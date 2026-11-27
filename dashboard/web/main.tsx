import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  dayLabel, deliveryPage, fetchEvidence, milestoneLabel, pagePath,
  shippingPath, stageLabel, stages, utcLabel, durationMillis, processMillis,
  changePolicy, changeValues, changeTree, countLabel,
  type ChangeReview, type ChangeNode, type ChangeFile, type Detail, type Milestone, type ProcessCapture, type Review,
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
          <span className="waterfall-duration">{item.elapsedMillis === null ? <span className="sr-only">Interval unknown</span> : durationMillis(item.elapsedMillis)}</span>
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

function useEvidence<T extends object>(path: string, refresh = false) {
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
  useEffect(() => {
    if (!refresh) return;
    let pending: AbortController | undefined;
    const timer = window.setInterval(() => {
      if (document.hidden || pending) return;
      const controller = pending = new AbortController();
      fetchEvidence<T>(path, controller.signal).then((data) => {
        if (controller.signal.aborted) return;
        setResult((prior) => prior.state === "ready" && "snapshotAt" in prior.data &&
          "snapshotAt" in data && prior.data.snapshotAt === data.snapshotAt ? prior : { state: "ready", data });
      }).catch(() => undefined).finally(() => { pending = undefined; });
    }, 30_000);
    return () => {
      window.clearInterval(timer);
      pending?.abort();
    };
  }, [path, refresh]);
  return { result, retry: () => setAttempt((count) => count + 1) };
}

function ProcessWaterfall({ capture }: { capture: ProcessCapture }) {
  const scale = Math.max(1, capture.observedMicros);
  const tracks = [{ id: 1, parent: 0, depth: 0, name: "Tool command", start: 0,
    end: capture.durationMicros, elapsed: capture.durationMicros }, ...capture.spans];
  const labels = new Map(tracks.map((track) => [track.id, track.name]));
  return <>
    <div className="process-grid process-scale" aria-hidden="true">
      <span>Process</span><span><span>0</span><span>{processMillis(capture.observedMicros)}</span></span><span>Elapsed</span>
    </div>
    <ol className="waterfall-rows process-rows" aria-label="Observed process spans">
      {tracks.map((track) => <li className="process-grid" key={track.id}>
        <span className="process-label" style={{ "--depth": Math.min(5, track.depth) } as CSSProperties}>
          <span>{track.name}</span>
          {track.parent > 0 && labels.has(track.parent) &&
            <span className="sr-only">Child of {labels.get(track.parent)}</span>}
        </span>
        <span className="process-track" aria-hidden="true" title={track.end === null ? undefined :
          `${processMillis(track.start)} to ${processMillis(track.end)}`}>
          {track.elapsed !== null && <span className="process-bar" data-root={track.id === 1} style={{
            "--position": `${track.start * 100 / scale}%`, "--duration": `${track.elapsed * 100 / scale}%`,
          } as CSSProperties} />}
        </span>
        <span className="process-duration">{track.elapsed === null ? "Unknown" : processMillis(track.elapsed)}</span>
      </li>)}
    </ol>
    {capture.unfinished > 0 && <p className="fine process-note">
      {capture.unfinished} process {capture.unfinished === 1 ? "interval has" : "intervals have"} no captured end.
    </p>}
    <p className="fine process-note">Linux process events. Child spans can overlap. Shell built-ins share the shell span.</p>
  </>;
}

function ProcessTimings() {
  const { result, retry } = useEvidence<{ captures: ProcessCapture[] }>("/api/v1/process-timings");
  const [choice, setChoice] = useState(0);
  const captures = result.state === "ready" ? result.data.captures : [];
  const capture = captures[choice] ?? captures[0];
  return <details className="process-timings" id="process-timing">
    <summary>Local process timings</summary>
    <p className="fine process-note">Captures are linked to individual tool calls. PR attribution is unavailable.</p>
    {result.state === "loading" && <p className="fine" role="status">Loading process captures…</p>}
    {result.state === "error" && <div className="detail-links" role="alert"><p>{result.message}</p>
      <Button onClick={retry}>Retry process timings</Button></div>}
    {result.state === "ready" && !capture && <p className="fine">No linked process captures in this snapshot.</p>}
    {capture && <>
      {captures.length > 1 ? <div className="process-picker">
        <label htmlFor="process-capture">Tool call</label>
        <NativeSelect id="process-capture" value={choice} onChange={(event) => setChoice(Number(event.currentTarget.value))}>
          {captures.map((item, index) => <option value={index} key={index}>{utcLabel(item.startedAt)}</option>)}
        </NativeSelect>
      </div> : <p className="fine">Tool call · <time dateTime={capture.startedAt}>{utcLabel(capture.startedAt)}</time></p>}
      <ProcessWaterfall capture={capture} />
    </>}
  </details>;
}

function openProcessTimings() {
  const timings = document.querySelector<HTMLDetailsElement>("#process-timing");
  if (!timings) return;
  timings.open = true;
  timings.querySelector("summary")?.focus({ preventScroll: true });
  timings.scrollIntoView();
}

function PollIntervalForm({ path, initial }: { path: string; initial: number }) {
  const [value, setValue] = useState(String(initial));
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const result = await fetchEvidence<{ minutes: number }>(
        path + "?" + new URLSearchParams({ minutes: String(Number(value)) }), AbortSignal.timeout(10_000), "PUT");
      setSaved(result.minutes);
      setValue(String(result.minutes));
      setStatus("Polling interval saved.");
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== "TimeoutError"
        ? failure.message : "The save timed out. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return <form className="poll-form" onSubmit={save}>
    <label htmlFor="poll-interval">Poll interval (minutes)</label>
    <div className="poll-controls">
      <input className="control-input" id="poll-interval" type="number" min="1" max="1440" step="1"
        required readOnly={saving} value={value} onChange={(event) => {
          setValue(event.currentTarget.value);
          setStatus("");
          setError("");
        }} />
      <Button type="submit" disabled={saving || Number(value) === saved}>{saving ? "Saving…" : "Save"}</Button>
    </div>
    <p role="status">{status}</p>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function PollSettings({ path }: { path: string }) {
  const { result, retry } = useEvidence<{ minutes: number }>(path);
  return <section className="poll-settings" id="poll-settings" aria-labelledby="poll-settings-title">
    <h2 id="poll-settings-title">GitHub polling</h2>
    {result.state === "loading" && <p role="status">Loading polling interval…</p>}
    {result.state === "error" && <div className="poll-error">
      <p role="alert">{result.message}</p><Button variant="outline" onClick={retry}>Retry</Button>
    </div>}
    {result.state === "ready" && <PollIntervalForm path={path} initial={result.data.minutes} />}
  </section>;
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
  return <>
    {items.length ? <>
      <StageKey />
      <p className="fine delivery-note">Bars show measured time between milestones. Missing clocks leave gaps in coverage. PRs in the same release can share the time from publication to the access check.</p>
      <div className="delivery-lanes" aria-hidden="true">
        <span>Merged or later</span><span>Before merge</span>
      </div>
      <div className="delivery-list">{items.map((item) => {
        const measured = item.milestones.flatMap((entry) => entry.elapsedMillis !== null && entry.elapsedMillis > 0 ?
          [{ ...entry, elapsedMillis: entry.elapsedMillis }] : []);
        const total = measured.reduce((sum, entry) => sum + entry.elapsedMillis, 0);
        const rowWidth = 100 * Math.log1p(total / 60_000) / Math.log1p(Math.max(1, maxMeasuredMillis) / 60_000);
        return <details key={item.number} id={`delivery-pr-${item.number}`} className="thread" data-stage={item.stage}>
          <summary>
            <span className="thread-meta">
              <span className="thread-name">{item.title ?? "Pull request title unavailable"}</span>
              <span className="thread-status">{stageLabel(item.stage)} · <time dateTime={item.lastObservedAt}>{dayLabel(item.lastObservedAt)}</time></span>
            </span>
            <span className="thread-bar" aria-hidden="true">{measured.length ? measured.map((entry) => {
              const elapsed = entry.elapsedMillis;
              const label = durationMillis(elapsed);
              return <span key={entry.key} className={`stage-segment ${phaseClass(entry)}`}
                style={{ width: `${rowWidth * elapsed / total}%` }}
                title={`${milestoneLabel(entry.key)} · ${label}`}><span>{label}</span></span>;
            }) : <span className="thread-unmeasured">No timed stages</span>}</span>
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
  </>;
}

function selectedPullRequest(): number | null {
  const pr = new URLSearchParams(location.search).get("pr");
  return pr && /^[1-9]\d*$/.test(pr) && Number.isSafeInteger(Number(pr)) ? Number(pr) : null;
}

function App() {
  const path = shippingPath();
  const [selection, setSelection] = useState(() => ({ pr: selectedPullRequest(), revision: 0 }));
  const [showSettings, setShowSettings] = useState(false);
  const { result: api } = useEvidence<{ pollingSettings?: string }>("/api/v1");
  const settingsPath = api.state === "ready" ? api.data.pollingSettings : undefined;
  const { result, retry } = useEvidence<Review>(path, Boolean(settingsPath) && selection.pr === null);
  const review = result.state === "ready" ? result.data : null;
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
    if (result.state !== "ready") return;
    const reveal = () => {
      if (location.hash === "#process-timing") openProcessTimings();
      if (location.hash === "#delivery-title") document.getElementById("delivery-title")?.scrollIntoView();
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [result.state]);
  const settingsToggle = settingsPath && <button type="button" className="settings-toggle" aria-expanded={showSettings}
    aria-controls={showSettings ? "poll-settings" : undefined}
    onClick={() => setShowSettings((open) => !open)}>Settings</button>;
  const changesLink = <Button asChild variant="outline"><a href="/changed-code">Changed Code Analysis</a></Button>;
  return <main className="review">
    {!review && <header className="masthead">
      <h1>Barnacles</h1>
      {changesLink}
      <div className="scope">
        <a href={path}>Review API JSON</a>
        {settingsToggle}
      </div>
    </header>}
    {review && <Fleet fleet={review.fleet} onSelect={select} headerAction={changesLink}>
      <div className="review-info">
        <span>{dayLabel(review.window.from)}–{dayLabel(review.window.to)} UTC</span>
        <span>Snapshot · <time dateTime={review.snapshotAt}>{utcLabel(review.snapshotAt)}</time></span>
        <Filters review={review} />
        <div className="scope">
          <span>{review.repository} · Linux Main x86_64</span>
          <a href={path}>Review API JSON</a>
          {settingsToggle}
          <a href="#process-timing" onClick={openProcessTimings}>Process timings</a>
        </div>
      </div>
    </Fleet>}
    {showSettings && settingsPath && <PollSettings path={settingsPath} />}
    {result.state === "loading" && <div className="page-message"><p role="status">Loading prepared evidence…</p></div>}
    {result.state === "error" && <div className="page-message" role="alert"><p>{result.message}</p>
      <div className="detail-links"><Button onClick={retry}>Retry review</Button><a href="/">Reset filters</a></div>
    </div>}
    {review && <>
      <Overview review={review} />
      <DailyStages chart={review.shipments.dailyChart} window={review.window} />
      <section className="delivery" aria-labelledby="delivery-title">
        <h2 id="delivery-title">Delivery cycle time</h2>
        <ProcessTimings />
        <DeliveryTimeline key={review.snapshotAt} review={review} selection={selection} />
      </section>
    </>}
  </main>;
}

const changePercent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
const changeRatio = (part: number, total: number) => changePercent.format(changePolicy.share(part, total));
const nodeLabel = (node: ChangeNode) => node.name + (node.directory ? "/" : "");
const nodeKey = (node: ChangeNode) => JSON.stringify([node.directory, node.name]);
const sameNode = (left: ChangeNode, right?: ChangeNode) => Boolean(right && nodeKey(left) === nodeKey(right));
const chartHeight = (index: number) => [172, 218, 263][index];

function ChangeActivity({ repository, scan, files }: {
  repository: string; scan: NonNullable<ChangeReview["scan"]>; files: ChangeFile[];
}) {
  const root = useMemo(() => changeTree(files), [files]);
  const [path, setPath] = useState(() => changeValues(changePolicy.initial_route(root)));
  const [scope, setScope] = useState(path);
  const [query, setQuery] = useState("");
  const view = useRef<HTMLDivElement>(null);
  const selectedDetail = useRef<HTMLElement>(null);
  const destination = useRef<{ depth: number; kind: "segment" | "row" | "crumb"; advance: boolean } | null>(null);
  const directories = [root, ...path.filter((node) => node.directory)];
  const active = path.at(-1) ?? root;
  const parent = path.at(-2) ?? root;
  const folder = scope.at(-1) ?? root;
  const results = useMemo(() => changePolicy.search(folder, query), [folder, query]);
  const matches = changeValues(results.rows);
  const crumbs = useRef<HTMLElement>(null);
  const [wideChart, setWideChart] = useState(false);
  useLayoutEffect(() => {
    const target = view.current;
    if (!target) return;
    const update = () => setWideChart(target.scrollWidth > target.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    observer.observe(target.firstElementChild!);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const target = destination.current;
    if (!target || !view.current) return;
    destination.current = null;
    if (target.advance) view.current.scrollLeft = view.current.scrollWidth;
    if (target.kind === "row") selectedDetail.current?.focus();
    else if (target.kind === "crumb") crumbs.current?.querySelector<HTMLElement>("[aria-current]")?.focus();
    else {
      const stage = target.advance
        ? `[data-depth="${target.depth + 1}"] h2`
        : `[data-depth="${target.depth}"] [aria-pressed="true"]`;
      view.current.querySelector<HTMLElement>(stage)?.focus({ preventScroll: true });
    }
  }, [path]);
  function choose(node: ChangeNode, depth: number) {
    const next = [...path.slice(0, depth), node];
    destination.current = { depth, kind: "segment", advance: node.directory };
    setPath(next);
    if (node.directory) { setScope(next); setQuery(""); }
  }
  function goBack(depth: number) {
    const next = path.slice(0, depth);
    destination.current = { depth, kind: "crumb", advance: false };
    setPath(next);
    setScope(next);
    setQuery("");
  }
  const columnOffset = Math.max(0, directories.length - 3);
  const selectedPath = path.map((node) => node.name).join("/");
  const fileScope = scope.length ? scope.map((node) => node.name).join("/") + "/" : "Entire repository";
  return <div className="change-body">
    <p className="change-muted">{repository} · {countLabel(scan.commitsScanned)} non-merge commits</p>
    <nav className="change-crumbs" aria-label="Folder path" ref={crumbs}>
      {directories.map((node, depth) => <span key={depth}>
        {depth > 0 && <span aria-hidden="true"> / </span>}
        {depth === directories.length - 1 ? <span tabIndex={-1} aria-current="location">{node.name}</span>
          : <button type="button" onClick={() => goBack(depth)}>{node.name}</button>}
      </span>)}
    </nav>
    <div className="change-scroll" ref={view} role="region" aria-label="Folder activity chart" tabIndex={0}>
      <div className="change-chart">
        {directories.map((node, depth) => {
          const level = Math.max(0, depth - columnOffset), bands = changeValues(changePolicy.bands(changePolicy.sorted(node), node.touches, 0));
          const height = chartHeight(level);
          const nextHeight = chartHeight(Math.max(0, depth + 1 - columnOffset));
          return <section className={"change-stage" + (depth < columnOffset ? " change-ancestor" : "")}
            data-depth={depth} data-level={level} key={depth}>
            <h2 title={nodeLabel(node)} tabIndex={-1}>{depth ? nodeLabel(node) : node.name}</h2>
            <p>{countLabel(node.touches)} touches · 100%</p>
            <div className="change-stack" style={{ height }}>
              {bands.map(({ node: child, top, size }) => {
                const selected = sameNode(child, path[depth]);
                const share = changePercent.format(size);
                return <button type="button" key={nodeKey(child)} aria-pressed={selected}
                  aria-label={`${nodeLabel(child)}, ${share} of ${node.name}`} title={`${nodeLabel(child)} ${share}`}
                  data-small={size < .1} data-root={depth === 0} className="change-band"
                  style={{ top: `${top * 100}%`, height: `${size * 100}%` }}
                  onClick={() => choose(child, depth)}><span>{nodeLabel(child)} {share}</span></button>;
              })}
              {depth < directories.length - 1 && bands.filter(({ node: child }) => sameNode(child, path[depth]))
                .map(({ top, size }) => <span aria-hidden="true" key="connector" className="change-connector"
                  style={{ height: Math.max(height, nextHeight),
                    clipPath: `polygon(0 ${top * height}px, 100% 0, 100% ${nextHeight}px, 0 ${(top + size) * height}px)` }} />)}
            </div>
          </section>;
        })}
      </div>
    </div>
    {wideChart && <p className="change-muted">Scroll sideways to see all folder levels.</p>}
    <section className="change-selection" aria-label="Selected path" aria-live="polite" ref={selectedDetail} tabIndex={-1}>
      <h2>{selectedPath ? selectedPath + (active.directory ? "/" : "") : root.name}</h2>
      <p>{countLabel(active.touches)} file touches{active !== root && <> · {changeRatio(active.touches, parent.touches)} of {parent === root ? "the repository" : nodeLabel(parent)}
        {parent !== root && <> · {changeRatio(active.touches, root.touches)} of all touches</>}</>}</p>
    </section>
    <div className="change-review">
      <section aria-labelledby="changed-files-title">
        <h2 id="changed-files-title">Most changed files</h2>
        <p className="change-muted">{fileScope}</p>
        <label htmlFor="change-search">Find a file in this folder</label>
        <input id="change-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        <p role="status" className="change-muted">{results.count
          ? `Showing ${matches.length} of ${countLabel(results.count)} ${query.trim() ? "matches" : "changed files"}`
          : "No matching files. Try a different name."}</p>
        {matches.length > 0 && <table aria-labelledby="changed-files-title"><thead>
          <tr><th scope="col">File path</th><th scope="col">Commits</th><th scope="col">Folder share</th></tr>
        </thead><tbody>{matches.map((row) => {
          const next = [...scope, ...changeValues(row.route)];
          const selected = !active.directory && next.length === path.length &&
            next.every((node, depth) => sameNode(node, path[depth]));
          return <tr key={row.path}><td><button type="button" aria-pressed={selected} onClick={() => {
            destination.current = { kind: "row", depth: next.length, advance: true };
            setPath(next);
          }}>{row.path}</button></td><td>{countLabel(row.touches)}</td><td>{changeRatio(row.touches, folder.touches)}</td></tr>;
        })}</tbody></table>}
      </section>
      <aside aria-labelledby="change-coverage-title"><h2 id="change-coverage-title">Scan coverage</h2>
        <dl>
          <div><dt>Repository</dt><dd>{repository}</dd></div>
          <div><dt>Revision</dt><dd title={scan.revision}>{scan.revision.slice(0, 12)}</dd></div>
          <div><dt>History</dt><dd>{countLabel(scan.commitsScanned)} non-merge commits{scan.hasMoreCommits && " · limit reached"}</dd></div>
          <div><dt>Changed paths</dt><dd>{countLabel(files.length)}</dd></div>
          <div><dt>File touches</dt><dd>{countLabel(root.touches)}</dd></div>
        </dl>
        {scan.shallow && <p className="change-muted">Shallow history. File changes at the checkout boundary are unavailable.</p>}
        <p className="change-muted">One file touch is one commit changing one file. Each chart column shows 100% of its folder.</p>
      </aside>
    </div>
  </div>;
}

function ChangedCodePage() {
  const { result, retry } = useEvidence<ChangeReview>("/api/v1/changed-code");
  const scan = result.state === "ready" ? result.data.scan : null;
  return <main className="change-page">
    <header className="masthead"><h1>Changed Code Analysis</h1><a href="/">Shipping review</a></header>
    {result.state === "loading" && <div className="page-message"><p role="status">Loading the Git scan…</p></div>}
    {result.state === "error" && <div className="page-message" role="alert"><p>{result.message}</p>
      <Button onClick={retry}>Retry Git scan</Button></div>}
    {result.state === "ready" && <>{!scan?.files ? <div className="page-message"><p>
      {scan ? "This snapshot contains the ranked report. Save a fresh Git scan and rebuild the snapshot to see the folder analysis."
        : "Save a Git scan for this repository and rebuild the snapshot to see changed files."}</p>
    </div> : scan.files.length ? <ChangeActivity repository={result.data.repository} scan={scan} files={scan.files} />
      : <div className="page-message"><p>No file changes were observed in this scan.</p>
        <p>Revision {scan.revision.slice(0, 12)} · {countLabel(scan.commitsScanned)} commits scanned
          {scan.hasMoreCommits && " · limit reached"}{scan.shallow && " · shallow history"}</p></div>}</>}
  </main>;
}

const isChanges = location.pathname === "/changed-code";
if (isChanges) document.title = "Barnacles · Changed Code Analysis";
createRoot(document.getElementById("root")!).render(isChanges ? <ChangedCodePage /> : <App />);
