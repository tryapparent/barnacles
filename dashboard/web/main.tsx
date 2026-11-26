import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  dayLabel, deliveryPage, fetchEvidence, milestoneLabel, pagePath,
  shippingPath, stageLabel, stages, utcLabel, wholeMinutes, type Detail, type Milestone, type Review,
} from "./api";
import { DailyStages, Overview, StageKey } from "./visual/charts";
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

function Waterfall({ milestones }: { milestones: Milestone[] }) {
  const observed = milestones.flatMap((item) => item.observedAt ?
    [{ ...item, observedAt: item.observedAt, time: Date.parse(item.observedAt) }] : []);
  const start = Math.min(...observed.map((item) => item.time));
  const span = Math.max(1, ...observed.map((item) => item.time - start));
  const missing = milestones.filter((item) => !item.observedAt);
  return <div className="waterfall">
    <ol className="waterfall-rows" aria-label="Delivery milestones">
      {observed.map((item) => {
        const end = (item.time - start) / span * 100;
        const width = (item.elapsedMillis ?? 0) / span * 100;
        const label = milestoneLabel(item.key);
        return <li key={item.key} className={phaseClass(item)}>
          <div className="waterfall-label">
            <span>{item.provenance?.url ? <a href={item.provenance.url} title={provenanceLabel(item.provenance.source)}>{label}</a> : label}</span>
            <time dateTime={item.observedAt} title={utcLabel(item.observedAt)}>{dayLabel(item.observedAt)} · {item.observedAt.slice(11, 19)} UTC</time>
          </div>
          <span className="waterfall-plot" aria-hidden="true">
            <span className="waterfall-fill" data-point={width <= 0} style={{ "--position": `${end - width}%`, "--duration": `${width}%` } as CSSProperties} />
          </span>
          <span className="waterfall-duration">{item.elapsedMillis === null ? <span className="sr-only">Interval unknown</span> : wholeMinutes(item.elapsedMillis)}</span>
        </li>;
      })}
    </ol>
    {missing.length > 0 && <details className="unobserved"><summary>Unobserved milestones</summary>
      <ul>{missing.map((item) => <li key={item.key}>{milestoneLabel(item.key)}</li>)}</ul>
    </details>}
  </div>;
}

function phaseClass(entry: Milestone) {
  return `stage-${stages.find(([key]) => key === entry.phase)?.[2]}`;
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

function PullRequestEvidence({ path, milestones }: { path: string; milestones: Milestone[] }) {
  const { result, retry } = useEvidence<Detail>(path);
  return <>
    <Waterfall milestones={result.state === "ready" ? result.data.milestones : milestones} />
    {result.state === "error" && <div className="detail-links" role="alert"><p>{result.message}</p>
      <Button className="retry" onClick={retry}>Retry PR details</Button></div>}
  </>;
}

function DeliveryTimeline({ review, selection }: { review: Review; selection: { pr: number | null; revision: number } }) {
  const selected = selection.pr;
  const [pages, setPages] = useState(review.deliveries);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const { items, offset, nextOffset, maxMeasuredMillis } = pages;
  const found = selected !== null && items.some((item) => item.number === selected);
  const loadMore = (limit?: number) => {
    if (nextOffset === null || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    fetchEvidence<Review>(deliveryPage(review, nextOffset, limit), controller.signal).then(({ deliveries }) => {
      setPages((prior) => ({ ...prior, nextOffset: deliveries.nextOffset,
        items: [...prior.items, ...deliveries.items.filter((item) => !prior.items.some((row) => row.number === item.number))] }));
    }).catch((failure: Error) => {
      if (!controller.signal.aborted) setError(failure.message);
    }).finally(() => {
      request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    });
  };
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (loading || error || nextOffset === null) return;
    if (selected !== null && !found) {
      loadMore(100);
      return;
    }
    if (!sentinel.current || !window.IntersectionObserver) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadMore();
    }, { rootMargin: "160px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [loading, error, nextOffset, selected, found]);
  useEffect(() => {
    if (!found) return;
    const row = document.getElementById(`delivery-pr-${selected}`) as HTMLDetailsElement | null;
    const summary = row?.querySelector("summary");
    if (!row || !summary) return;
    const finish = () => {
      row.open = true;
      summary.focus({ preventScroll: true });
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(row.getBoundingClientRect().top - 16) < 2) {
      row.scrollIntoView({ block: "start" });
      finish();
      return;
    }
    let timer: number;
    const open = () => {
      clearTimeout(timer);
      document.removeEventListener("scrollend", open);
      finish();
    };
    document.addEventListener("scrollend", open, { once: true });
    timer = window.setTimeout(open, 900);
    row.scrollIntoView({ block: "start", behavior: "smooth" });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("scrollend", open);
    };
  }, [selection, found]);
  return <section className="delivery" aria-labelledby="delivery-title">
    <h2 id="delivery-title">Delivery cycle time</h2>
    {items.length ? <>
      <StageKey />
      <div className="delivery-list">{items.map((item) => {
        const hasThread = item.milestones.some((entry) => entry.key === "thread-started" && entry.observedAt);
        const measured = item.milestones.flatMap((entry) => entry.elapsedMillis !== null && entry.elapsedMillis > 0 ?
          [{ ...entry, elapsedMillis: entry.elapsedMillis }] : []);
        const total = measured.reduce((sum, entry) => sum + entry.elapsedMillis, 0);
        const rowWidth = 100 * Math.log1p(total / 60_000) / Math.log1p(Math.max(1, maxMeasuredMillis) / 60_000);
        return <details key={item.number} id={`delivery-pr-${item.number}`} className="thread">
          <summary>
            <span className="thread-meta">
              <span className="thread-name" aria-label={hasThread ? `Thread linked to PR #${item.number}` : undefined}>
                {hasThread ? `Thread · #${item.number}` : `PR #${item.number}`}
              </span>
              <span className="sr-only">{stageLabel(item.stage)}</span>
              <time dateTime={item.lastObservedAt}>{dayLabel(item.lastObservedAt)}</time>
            </span>
            <span className="thread-bar" aria-hidden="true">{measured.length ? measured.map((entry) => {
              const elapsed = entry.elapsedMillis;
              return <span key={entry.key} className={`stage-segment ${phaseClass(entry)}`}
                style={{ width: `${rowWidth * elapsed / total}%` }}
                title={`${milestoneLabel(entry.key)} · ${wholeMinutes(elapsed)}`}><span>{wholeMinutes(elapsed)}</span></span>;
            }) : <span className="thread-unmeasured">—</span>}</span>
          </summary>
          {selected === item.number ? <PullRequestEvidence path={item.detailPath} milestones={item.milestones} /> :
            <Waterfall milestones={item.milestones} />}
          <div className="detail-links"><a href={item.pullRequestUrl}>Open PR on GitHub</a><a href={item.detailPath}>PR evidence JSON</a></div>
        </details>;
      })}</div>
      {nextOffset !== null && <div ref={sentinel} className="delivery-tail">
        {loading && <span role="status" className="fine">Loading more deliveries…</span>}
        {error && <p role="alert">{error}</p>}
        {!loading && <Button className={error || !window.IntersectionObserver ? "" : "scroll-keyboard"}
          onClick={() => loadMore(selected !== null && !found ? 100 : undefined)}>
          {error ? "Retry loading deliveries" : "Load more deliveries"}
        </Button>}
      </div>}
    </> : offset > 0 ? <p className="fine">No pull requests on this page.{" "}
      <a href={pagePath({ offset: null, to: review.window.to }, "#delivery-title")}>First page</a></p> :
      <p className="fine">No delivery milestones were observed in this window.</p>}
    {selected !== null && !found && nextOffset === null && <p className="fine" role="status">
      PR #{selected} has no row in this window. <a href={`/api/v1/pull-requests/${selected}?asOf=${encodeURIComponent(review.window.to)}`}>PR evidence JSON</a>
    </p>}
  </section>;
}

function selectedPullRequest(): number | null {
  const pr = new URLSearchParams(location.search).get("pr");
  return pr && /^[1-9]\d*$/.test(pr) && Number.isSafeInteger(Number(pr)) ? Number(pr) : null;
}

function App() {
  const path = shippingPath();
  const { result, retry } = useEvidence<Review>(path);
  const review = result.state === "ready" ? result.data : null;
  const [selection, setSelection] = useState(() => ({ pr: selectedPullRequest(), revision: 0 }));
  const select = (event: MouseEvent<HTMLAnchorElement>, pr: number) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(null, "", event.currentTarget.href);
    setSelection((prior) => ({ pr, revision: prior.revision + 1 }));
  };
  useEffect(() => {
    const restore = () => setSelection((prior) => ({ pr: selectedPullRequest(), revision: prior.revision + 1 }));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (review && location.hash === "#delivery-title") document.getElementById("delivery-title")?.scrollIntoView();
  }, [review]);
  return <main className="review">
    {!review && <header className="masthead">
      <h1>Barnacles</h1>
      <div className="scope">
        <a href={path}>Review API JSON</a>
      </div>
    </header>}
    {result.state === "loading" && <div className="page-message"><p role="status">Loading prepared evidence…</p></div>}
    {result.state === "error" && <div className="page-message" role="alert"><p>{result.message}</p>
      <div className="detail-links"><Button onClick={retry}>Retry review</Button><a href="/">Reset filters</a></div>
    </div>}
    {review && <>
      <Fleet fleet={review.fleet} onSelect={select}>
        <div className="review-info">
          <span>{dayLabel(review.window.from)}–{dayLabel(review.window.to)} UTC</span>
          <span>Snapshot · <time dateTime={review.snapshotAt}>{utcLabel(review.snapshotAt)}</time></span>
          <Filters review={review} />
          <div className="scope">
            <span>{review.repository} · Linux Main x86_64</span>
            <a href={path}>Review API JSON</a>
          </div>
        </div>
      </Fleet>
      <Overview review={review} />
      <DailyStages days={review.shipments.dailyStages} />
      <DeliveryTimeline review={review} selection={selection} />
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
