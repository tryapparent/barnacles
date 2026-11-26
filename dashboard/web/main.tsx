import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  countLabel, dayLabel, detailPage, duration, fetchEvidence, milestoneLabel, pagePath, route,
  shippingPath, stageLabel, stages, utcLabel, type Detail, type Milestone, type Review,
} from "./api";
import { Overview } from "./visual/charts";
import { Button, NativeSelect } from "./controls";
import { Fleet } from "./visual/fleet";
import "./style.css";

function toUTC(value: string) {
  if (!value) return null;
  return value + (value.length === 16 ? ":00Z" : "Z");
}

function Filters({ review }: { review: Review }) {
  const [clock, setClock] = useState(review.operations.clock);
  const hasMatchingClock = clock === review.operations.clock;
  const change = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    location.assign(pagePath({
      from: toUTC(String(values.get("from") ?? "")), to: toUTC(String(values.get("to") ?? "")),
      clock, operation: hasMatchingClock ? String(values.get("operation") ?? "") : null, offset: null,
    }));
  };
  return <details className="filters">
    <summary>Review filters</summary>
    <form onSubmit={change} className="filter-form">
      <label>From (UTC)<input className="control-input" type="datetime-local" step="0.001" name="from"
        defaultValue={review.window.from.slice(0, 23)} /></label>
      <label>To (UTC)<input className="control-input" type="datetime-local" step="0.001" name="to"
        defaultValue={review.window.to.slice(0, 23)} /></label>
      <div className="filter-field"><label htmlFor="review-clock">Clock</label>
        <NativeSelect id="review-clock" name="clock" value={clock} onChange={(event) => setClock(event.currentTarget.value)}>
        {review.operations.clockOptions.map((choice) => <option key={choice}>{choice}</option>)}
      </NativeSelect></div>
      <div className="filter-field"><label htmlFor="review-operation">Operation</label>
        <NativeSelect id="review-operation" name="operation" key={clock} disabled={!hasMatchingClock}
        defaultValue={hasMatchingClock ? review.operations.operation ?? "" : ""}>
        <option value="">All operations</option>
        {hasMatchingClock && review.operations.operationOptions.map((choice) => <option key={choice}>{choice}</option>)}
      </NativeSelect></div>
      <Button type="submit">Apply filters</Button>
    </form>
  </details>;
}

function MilestoneTable({ milestones, sources = false }: { milestones: Milestone[]; sources?: boolean }) {
  const evidence = (item: Milestone) => item.provenance?.url ?
    <a href={item.provenance.url}>{provenanceLabel(item.provenance.source)}</a> :
    item.provenance ? provenanceLabel(item.provenance.source) : "Unknown";
  return <div className="table-scroll"><table className="milestone-table">
    <caption className="sr-only">Delivery milestones</caption>
    <thead><tr><th scope="col">Milestone</th><th scope="col">Observed (UTC)</th>
      <th scope="col">Elapsed</th>{sources && <th scope="col" className="evidence-col">Evidence</th>}</tr></thead>
    <tbody>{milestones.map((item) => <tr key={item.key}>
      <th scope="row">{milestoneLabel(item.key)}
        {sources && item.provenance && <small className="milestone-source">{evidence(item)}</small>}
      </th>
      <td>{item.observedAt ? <time dateTime={item.observedAt}>{item.observedAt.slice(0, 23).replace("T", " ")}</time> : "Unknown"}</td>
      <td>{duration(item.elapsedMillis === null ? null : item.elapsedMillis / 1000)}</td>
      {sources && <td className="evidence-col">{evidence(item)}</td>}
    </tr>)}</tbody>
  </table></div>;
}

function provenanceLabel(source: string) {
  const sources: Record<string, string> = {
    "t3-owning-thread-link": "T3 thread link", "github-pull-request-commits": "GitHub commits",
    "github-pull-request": "GitHub PR", "github-actions": "Actions run", "github-release": "GitHub release",
    "verified-release-asset-check": "Release asset check",
  };
  return sources[source] ?? source;
}

type Request<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };

function useEvidence<T>(path: string) {
  const [result, setResult] = useState<Request<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ state: "loading" });
    fetchEvidence<T>(path, controller.signal).then((data) => {
      if (!controller.signal.aborted) setResult({ state: "ready", data });
    }, (error: Error) => {
      if (!controller.signal.aborted) setResult({ state: "error", message: error.message });
    });
    return () => controller.abort();
  }, [path, attempt]);
  return { result, retry: () => setAttempt((count) => count + 1) };
}

function PullRequest({ number, asOf }: { number: string; asOf: string }) {
  const path = `/api/v1/pull-requests/${encodeURIComponent(number)}?asOf=${encodeURIComponent(asOf)}`;
  const { result, retry } = useEvidence<Detail>(path);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (location.hash === "#pr-detail") {
      heading.current?.focus({ preventScroll: true });
      heading.current?.closest("section")?.scrollIntoView({ block: "start" });
    }
  }, [number]);
  return <section id="pr-detail" className="pr-detail" aria-labelledby="detail-title">
    <div className="detail-head">
      <h2 ref={heading} tabIndex={-1} id="detail-title">PR #{number}</h2>
      <a href={pagePath({ pr: null }, "#delivery-title")}>Close PR details</a>
    </div>
    {result.state === "loading" && <p role="status">Loading PR evidence…</p>}
    {result.state === "error" && <div role="alert"><p>{result.message}</p>
      <Button className="retry" onClick={retry}>Retry PR details</Button></div>}
    {result.state === "ready" && <>
      <p className="fine">{stageLabel(result.data.stage)} · As of {utcLabel(result.data.asOf)}</p>
      <MilestoneTable milestones={result.data.milestones} sources />
      <div className="detail-links"><a href={result.data.pullRequestUrl}>Open PR on GitHub</a>
        <a href={path}>PR evidence JSON</a></div>
    </>}
  </section>;
}

function DeliveryTimeline({ review }: { review: Review }) {
  const { items, offset, limit, total, nextOffset } = review.deliveries;
  const extent = Math.max(1, ...items.map((item) => {
    const first = Math.min(...item.milestones.flatMap((entry) => entry.observedAt ? [Date.parse(entry.observedAt)] : []));
    return Date.parse(item.lastObservedAt) - first;
  }));
  return <section className="delivery" aria-labelledby="delivery-title">
    <div className="delivery-header"><h2 id="delivery-title">Delivery cycle time</h2>
      <p>{countLabel(total)} observed · Newest first</p></div>
    {items.length ? <>
      <ul className="stage-key" aria-label="Delivery stages">{stages.map(([key, label, color]) =>
        <li key={key} className={`stage-${color}`}>{label}</li>)}</ul>
      <div className="thread-scale"><span>{duration(extent / 1000 / 4)}</span></div>
      {items.map((item) => <details key={item.number} className="thread">
        <summary>
          <span className="thread-meta"><span className="thread-name">PR #{item.number}</span>
            <time dateTime={item.lastObservedAt}>{dayLabel(item.lastObservedAt)}</time></span>
          <span className="thread-stages">
            <span className="thread-bar" aria-hidden="true">{item.milestones.map((entry) => {
              if (!entry.observedAt || entry.elapsedMillis === null) return null;
              const color = stages.find(([key]) => key === entry.phase)?.[2];
              const right = (Date.parse(item.lastObservedAt) - Date.parse(entry.observedAt)) / extent * 100;
              return <span key={entry.key} className={`stage-segment stage-${color}`}
                style={{ right: right + "%", width: entry.elapsedMillis / extent * 100 + "%" } as CSSProperties}
                title={`${milestoneLabel(entry.key)} · ${duration(entry.elapsedMillis / 1000)}`}>
                <span>{duration(entry.elapsedMillis / 1000)}</span>
              </span>;
            })}</span>
            <span className="thread-result">{stageLabel(item.stage)}</span>
          </span>
        </summary>
        <MilestoneTable milestones={item.milestones} />
        <div className="detail-links"><a href={detailPage(item.number, review.window.to)}>View PR #{item.number} evidence</a></div>
      </details>)}
      {(offset > 0 || nextOffset !== null) && <nav className="pager" aria-label="Delivery pages">
        <span>{countLabel(offset + 1)}–{countLabel(offset + items.length)} of {countLabel(total)}</span>
        {offset > 0 && <Button variant="outline" asChild>
          <a href={pagePath({ offset: Math.max(0, offset - limit), to: review.window.to }, "#delivery-title")}>Previous page</a>
        </Button>}
        {nextOffset !== null && <Button variant="outline" asChild>
          <a href={pagePath({ offset: nextOffset, to: review.window.to }, "#delivery-title")}>Next page</a>
        </Button>}
      </nav>}
    </> : offset > 0 ? <p className="fine">No pull requests on this page.{" "}
      <a href={pagePath({ offset: null, to: review.window.to }, "#delivery-title")}>First page</a></p> :
      <p className="fine">No delivery milestones were observed in this window.</p>}
  </section>;
}

function App() {
  const path = shippingPath();
  const { result, retry } = useEvidence<Review>(path);
  const review = result.state === "ready" ? result.data : null;
  const pr = route.get("pr");
  useEffect(() => {
    if (review && location.hash === "#delivery-title") document.getElementById("delivery-title")?.scrollIntoView();
  }, [review]);
  return <main className="review">
    <header className="masthead">
      <h1>Shipping review</h1>
      <div className="scope">
        {review && <span>{review.repository} · Linux Main x86_64</span>}
        <a href={path}>Review API JSON</a>
      </div>
    </header>
    {result.state === "loading" && <div className="page-message"><p role="status">Loading prepared evidence…</p></div>}
    {result.state === "error" && <div className="page-message" role="alert"><p>{result.message}</p>
      <div className="detail-links"><Button onClick={retry}>Retry review</Button><a href="/">Reset filters</a></div>
    </div>}
    {review && <>
      <div className="review-info">
        <span>{dayLabel(review.window.from)}–{dayLabel(review.window.to)} UTC</span>
        <span>Snapshot · <time dateTime={review.snapshotAt}>{utcLabel(review.snapshotAt)}</time></span>
        <Filters review={review} />
      </div>
      <Fleet fleet={review.fleet} />
      <Overview review={review} />
      {pr && <PullRequest number={pr} asOf={review.window.to} />}
      <DeliveryTimeline review={review} />
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
