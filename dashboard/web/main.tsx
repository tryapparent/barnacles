import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  dayLabel, fetchEvidence, milestoneLabel, pagePath,
  shippingPath, stageLabel, stages, utcLabel, durationMillis, processMillis,
  changePolicy, changeTree, countLabel,
  changeValues, sessionPolicy, sessionEventList, type HistoryEntry, type HistoryEvent, type HistoryLane, type HistoryTrace,
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

function SelectedPullRequestEvidence({ number, cutoff }: { number: number; cutoff: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const path = `/api/v1/pull-requests/${number}?asOf=${encodeURIComponent(cutoff)}`;
  const { result, retry } = useEvidence<Detail>(path);
  const detail = result.state === "ready" ? result.data : null;
  useEffect(() => {
    heading.current?.scrollIntoView({ block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, []);
  return <section className="selected-delivery" aria-labelledby={`delivery-pr-${number}`}>
    <h3 ref={heading} id={`delivery-pr-${number}`} tabIndex={-1}>{detail?.title ?? `PR #${number}`}</h3>
    {result.state === "loading" && <p className="fine" role="status">Loading PR evidence…</p>}
    {result.state === "error" && <div className="detail-links" role="alert"><p>{result.message}</p>
      <Button onClick={retry}>Retry PR details</Button></div>}
    {detail && <>
      <Waterfall milestones={detail.milestones} />
      <div className="detail-links"><a href={detail.pullRequestUrl}>Open PR on GitHub</a><a href={path}>PR evidence JSON</a></div>
    </>}
  </section>;
}

function DeliveryTimeline({ review, selection }: { review: Review; selection: { pr: number | null; revision: number } }) {
  const selected = selection.pr;
  const { items } = review.deliveries;
  const points = items.flatMap((item) => item.milestones.flatMap((milestone) =>
    milestone.observedAt ? [Date.parse(milestone.observedAt)] : []));
  const start = Math.min(...points);
  const end = Math.max(...points);
  const position = (at: number) => start === end ? 50 : (at - start) * 100 / (end - start);
  const ticks = start === end ? [start] : [start, Math.floor(start + (end - start) / 2), end];
  const found = selected !== null && items.some((item) => item.number === selected);
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
      <p className="fine delivery-scope">{items.length === 10 ? "Latest 10 pull requests" : `${items.length} pull requests in this window`}</p>
      <StageKey />
      <p className="fine delivery-note">Bars show measured intervals. Dashed green spans show time from publication to the access check. Open a row for exact timestamps.</p>
      <div className="delivery-axis">
        <span className="delivery-clock">Milestone time (UTC)</span>
        <div className="delivery-ticks" data-single={ticks.length === 1}>
          {ticks.map((tick, index) => {
            const at = new Date(tick).toISOString();
            const time = at.slice(11, end - start >= 86400000 ? 16 : end - start >= 1000 ? 19 : 23);
            return <time key={index} dateTime={at} title={at}>{dayLabel(at)} <span>{time}</span></time>;
          })}
        </div>
      </div>
      <div className="delivery-list">{items.map((item) => {
        const merge = item.milestones.find((entry) => entry.key === "merged")?.observedAt;
        return <details key={item.number} id={`delivery-pr-${item.number}`} className="thread">
          <summary>
            <span className="thread-meta">
              <span className="thread-name">{item.title ?? "Pull request title unavailable"}</span>
              <span className="thread-status">{merge ? <>Merged <time dateTime={merge} title={utcLabel(merge)}>{dayLabel(merge)}</time></> : "No merge recorded"}
                {item.stage !== "merged" && ` · ${stageLabel(item.stage)}`}</span>
            </span>
            <span className="thread-bar" aria-hidden="true">{item.milestones.map((entry) => {
              if (!entry.observedAt) return null;
              const at = Date.parse(entry.observedAt);
              if (at < start || at > end) return null;
              const left = position(Math.max(start, at - (entry.elapsedMillis ?? 0)));
              const width = position(at) - left;
              const title = `${milestoneLabel(entry.key)} · ${utcLabel(entry.observedAt)}`;
              const label = entry.elapsedMillis === null ? null : durationMillis(entry.elapsedMillis);
              return <span key={entry.key} className={`stage-segment ${phaseClass(entry)}`}
                style={{ left: `${left}%`, width: width === 0 ? undefined : `${width}%` }} data-point={width === 0}
                title={label === null ? title : `${title} · ${label}`}>{width > 0 && entry.key !== "access-verified" && <span>{label}</span>}</span>;
            })}</span>
          </summary>
          {selected === item.number ? <PullRequestEvidence path={item.detailPath} milestones={item.milestones} /> :
            <Waterfall milestones={item.milestones} />}
          <div className="detail-links"><a href={item.pullRequestUrl}>Open PR on GitHub</a><a href={item.detailPath}>PR evidence JSON</a></div>
        </details>;
      })}</div>
    </> : <p className="fine">No delivery milestones were observed in this window.</p>}
    {selected !== null && !found &&
      <SelectedPullRequestEvidence key={selection.revision} number={selected} cutoff={review.window.to} />}
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
  const dashboardLinks = <nav className="dashboard-links" aria-label="Dashboard views">
    <Button asChild variant="outline"><a href="/sessions">Session history</a></Button>
    <Button asChild variant="outline"><a href="/changed-code">Changed Code Analysis</a></Button>
  </nav>;
  return <main className="review">
    {!review && <header className="masthead">
      <h1>Barnacles</h1>
      {dashboardLinks}
      <div className="scope">
        <a href={path}>Review API JSON</a>
        {settingsToggle}
      </div>
    </header>}
    {review && <Fleet fleet={review.fleet} onSelect={select} headerAction={dashboardLinks}>
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
        <h2 id="delivery-title">Delivery timeline</h2>
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
const isHistory = location.pathname === "/sessions";
if (isChanges) document.title = "Barnacles · Changed Code Analysis";
if (isHistory) document.title = "Plow · Session history";
createRoot(document.getElementById("root")!).render(isHistory ? <SessionHistoryPage /> : isChanges ? <ChangedCodePage /> : <App />);

function sessionPath(id: string) {
  return "/sessions?session=" + encodeURIComponent(id);
}

const traceElapsed = (value: number) => sessionPolicy.trace_elapsed(Math.max(0, Math.round(value)));
const traceEnd = (event: HistoryEvent) => event.end.$ === "Some" ? event.end.value : null;
const traceUtc = (time: number) => new Date(time).toISOString();

type TraceRange = { from: number; to: number };
type Study = { cutoff: number; replay: boolean };

function TraceMarks({ events, range, active }: { events: HistoryEvent[]; range: TraceRange; active: number | null }) {
  const x = (time: number) => (time - range.from) / Math.max(1, range.to - range.from) * 1000;
  const paths = { spans: "", points: "", unknown: "", selected: "" };
  for (const event of events) {
    const end = traceEnd(event);
    if (event.start > range.to || (end ?? event.start) < range.from) continue;
    const left = Math.max(0, x(event.start));
    const point = Math.max(3, Math.min(997, left));
    if (end !== null && end > event.start) {
      const right = Math.max(left + 1, Math.min(1000, x(end)));
      paths.spans += `M${left},12H${right}`;
      if (event.index === active) paths.selected += `M${left},12H${right}`;
    } else {
      const key = end === null ? "unknown" : "points";
      const glyph = end === null ? `M${point - 3},15l6,-6` : `M${point},7v10`;
      paths[key] += glyph;
      if (event.index === active) paths.selected += glyph;
    }
  }
  return <svg className="trace-marks" viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true">
    <path className="trace-rail" d="M0,12H1000M500,0V24" />
    <path className="trace-span" d={paths.spans} />
    <path className="trace-point" d={paths.points} />
    <path className="trace-unknown" d={paths.unknown} />
    <path className="trace-selected" d={paths.selected} />
  </svg>;
}

function TraceChart({ lanes, range, fullEnd, zoomed, selectedLane, active, selectLane, resetZoom }: {
  lanes: HistoryLane[]; range: TraceRange; fullEnd: number; zoomed: boolean; selectedLane: number | null; active: number | null;
  selectLane: (index: number) => void; resetZoom: () => void;
}) {
  const ticks = [range.from, (range.from + range.to) / 2, range.to];
  return <figure className="trace-chart" aria-labelledby="trace-chart-title">
    <figcaption id="trace-chart-title">Observed timeline</figcaption>
    {zoomed && <div className="trace-zoom">
      <div><p>Full trace · {traceElapsed(fullEnd)}</p><div className="trace-zoom-track" aria-hidden="true"><span
        style={{ inlineSize: `${(range.to - range.from) / Math.max(1, fullEnd) * 100}%`,
          insetInlineStart: `${range.from / Math.max(1, fullEnd) * 100}%` }} /></div></div>
      <Button variant="outline" onClick={resetZoom}>Reset timeline zoom</Button>
    </div>}
    <div className="trace-ruler"><span>Elapsed from thread start</span>
      <div>{ticks.map((tick, index) => <span key={index}>{traceElapsed(tick)}</span>)}</div>
    </div>
    {lanes.map((lane) => <div key={lane.index} className="trace-lane" data-lane={lane.index}>
      <button aria-pressed={selectedLane === lane.index} disabled={!lane.events.length} onClick={() => selectLane(lane.index)}>
        <span>{lane.name}</span><span className="trace-count">{countLabel(lane.events.length)}</span>
      </button>
      <TraceMarks events={lane.events} range={range} active={active} />
    </div>)}
    <p className="trace-key"><span><i className="trace-key-span" /> Interval</span><span><i className="trace-key-point" /> Event</span>
      <span><i className="trace-key-unknown" /> End unknown</span></p>
  </figure>;
}

function TraceSignals({ study, signals, reveal }: {
  study: Study; signals: HistoryTrace["signals"]; reveal: (index: number) => void;
}) {
  return <section className="trace-signals" aria-labelledby="trace-signals-title">
    <h3 id="trace-signals-title">Slowdown signals</h3>
    {!signals.length ? <p>{study.replay ? "No replay signals matched this trace." : "No matching analyzer replay was loaded."}</p>
      : <details open><summary>{countLabel(signals.length)} analyzer {signals.length === 1 ? "finding" : "findings"}</summary>
        <ul>{signals.map((signal) => <li key={signal.rule + ":" + signal.id}>
          <strong>{signal.rule === "ci-queue" ? "CI queue" : signal.rule === "ci-execution" ? "CI execution" : signal.rule.replaceAll("-", " ")}</strong>
          <span>{signal.seconds > 0 ? traceElapsed(signal.seconds * 1000) : "Duration unknown"}
            {signal.peers > 0 && ` · ${traceElapsed(signal.median * 1000)} peer median · ${signal.peers} peers`}</span>
          {signal.event.$ === "Some" && <Button variant="outline" onClick={() => {
            if (signal.event.$ === "Some") reveal(signal.event.value);
          }}>Show in trace</Button>}
        </li>)}</ul>
      </details>}
  </section>;
}

function TraceDetail({ trace, study }: { trace: HistoryTrace; study: Study }) {
  const { entry, lanes, signals } = trace;
  const { thread } = entry;
  const [lane, setLane] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<HistoryEvent | null>(null);
  const [focus, setFocus] = useState<TraceRange | null>(null);
  const full = { from: 0, to: entry.end };
  const range = focus ?? full;
  const events = useMemo(() => lane === null
    ? sessionPolicy.order_events(sessionEventList(lanes.flatMap((item) => item.events)))
    : sessionEventList(lanes[lane].events), [lanes, lane]);
  const page = useMemo(() => sessionPolicy.session_events(events, range.from, range.to, query, offset),
    [events, range.from, range.to, query, offset]);
  const selectLane = (index: number) => {
    setLane((prior) => prior === index ? null : index);
    setOffset(0);
  };
  const setRange = (value: TraceRange | null) => {
    setFocus(value);
    setOffset(0);
  };
  const recordDetails = useRef<HTMLDivElement>(null);
  const focusEvent = (event: HistoryEvent) => {
    const end = traceEnd(event) ?? event.start;
    const padding = Math.max(30000, Math.floor((end - event.start) / 8));
    setRange({ from: Math.max(0, event.start - padding), to: Math.min(full.to, end + padding) });
  };

  const revealSignal = (index: number) => {
    const event = lanes.flatMap((item) => item.events).find((item) => item.index === index);
    if (!event) return;
    setQuery("");
    setLane(event.lane);
    setSelected(event);
    focusEvent(event);
    requestAnimationFrame(() => recordDetails.current?.focus());
  };

  return <article className="trace-detail" aria-labelledby="trace-thread-title">
    <header className="trace-thread">
      <div><h2 id="trace-thread-title">{thread.title}</h2>
        <p>Started {utcLabel(traceUtc(thread.start))}</p></div>
      <a href={thread.source}>Open T3 thread</a>
    </header>
    <dl className="trace-context">
      <div><dt>Observed window</dt><dd>{entry.count ? traceElapsed(entry.end) : "Unknown"}</dd></div>
      <div><dt>Trace records</dt><dd>{countLabel(entry.count)}</dd></div>
      <div><dt>Codex rollouts</dt><dd>{countLabel(thread.rollout_count)}</dd></div>
      {signals.length > 0 && <div><dt>Slowdown signals</dt><dd><a href="#trace-signals-title">{countLabel(signals.length)}</a></dd></div>}
    </dl>
    {entry.count > 0 ? <>
      <TraceChart lanes={lanes} range={range} fullEnd={full.to} zoomed={focus !== null} selectedLane={lane}
        active={selected?.index ?? null} selectLane={selectLane} resetZoom={() => setRange(null)} />
      <p className="trace-coverage">Clocks can overlap. Empty lanes indicate missing observations. A CI or Git record can be linked to the thread or mentioned in its history.</p>
    </> : <p className="trace-message">This thread has no retained timing records.</p>}
    <div className="trace-evidence">
      <section aria-labelledby="trace-records-title" className="trace-records">
        <h3 id="trace-records-title">Trace records</h3>
        <div className="trace-filters">
          <label>Search records<input className="control-input" type="search" value={query} onChange={(event) => {
            setQuery(event.currentTarget.value);
            setOffset(0);
          }} /></label>
          <label>Clock<NativeSelect value={lane ?? ""} onChange={(event) => {
            setLane(event.currentTarget.value === "" ? null : Number(event.currentTarget.value));
            setOffset(0);
          }}>
            <option value="">All clocks</option>
            {lanes.map((item) => <option key={item.index} value={item.index} disabled={!item.events.length}>{item.name}</option>)}
          </NativeSelect></label>
        </div>
        {selected && <div className="trace-inspection" ref={recordDetails} tabIndex={-1} aria-live="polite">
          <div><strong>{selected.label}</strong><p>{lanes[selected.lane].name} · {traceUtc(thread.start + selected.start)}</p>
            <p>{selected.clipped && "Clipped at study boundary · "}{selected.state && selected.state + " · "}
              {selected.relation === "mentioned" ? "Mentioned in thread" : selected.relation === "worktree" ? "Matched worktree" : "Linked evidence"}
              {selected.source && (selected.source.startsWith("https:") ? <> · <a href={selected.source}>Source record</a></> : " · " + selected.source)}</p></div>
          <Button variant="outline" onClick={() => focusEvent(selected)}>Zoom to record</Button>
        </div>}
        <p className="trace-result-count" role="status">{countLabel(page.total)} matching {page.total === 1 ? "record" : "records"}</p>
        {page.total > 0 && <>
          <ul className="trace-events">
            {changeValues(page.rows).map((event) => {
              const end = traceEnd(event);
              return <li key={event.index}><button type="button" aria-pressed={selected?.index === event.index} onClick={() => setSelected(event)}>
                <span className="trace-event-time">{traceElapsed(event.start)}</span>
                <span><strong>{event.label}</strong><small>{lanes[event.lane].name}</small>
                  <span className="trace-eventplot" data-lane={event.lane}><TraceMarks events={[event]} range={range} active={null} /></span></span>
                <span className="trace-event-duration">{end === null ? "End unknown" : end === event.start ? "Event" : traceElapsed(end - event.start)}</span>
              </button></li>;
            })}
          </ul>
          {page.total > 20 && <nav className="trace-pagination" aria-label="Trace record pages">
            <Button variant="outline" disabled={!offset} onClick={() => setOffset(offset - 20)}>Previous</Button>
            <span>{offset + 1}–{Math.min(offset + 20, page.total)} of {countLabel(page.total)}</span>
            <Button variant="outline" disabled={offset + 20 >= page.total} onClick={() => setOffset(offset + 20)}>Next</Button>
          </nav>}
        </>}
      </section>
      <TraceSignals study={study} signals={signals} reveal={revealSignal} />
    </div>
  </article>;
}

function SelectedTrace({ id }: { id: string }) {
  const { result, retry } = useEvidence<{ study: Study; trace: HistoryTrace }>("/api/v1/sessions?session=" + encodeURIComponent(id));
  if (result.state === "loading") return <p className="trace-message" role="status">Loading trace…</p>;
  if (result.state === "error") return <div className="trace-message" role="alert"><p>{result.message}</p>
    <Button variant="outline" onClick={retry}>Retry trace</Button></div>;
  return <TraceDetail key={id} trace={result.data.trace} study={result.data.study} />;
}

function SessionStudy({ sessions, study }: { sessions: HistoryEntry[]; study: Study }) {
  const active = new URLSearchParams(location.search).get("session") ?? sessions[0].thread.id;
  const [query, setQuery] = useState("");
  const matches = useMemo(() => sessions.filter((entry) => sessionPolicy.session_matches(entry, query)), [sessions, query]);
  return <div className="trace-layout">
    <nav aria-label="Sampled threads" className="trace-history">
      <label>Find a thread<input className="control-input" type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
      <p role="status">{matches.length === sessions.length ? `${countLabel(sessions.length)} sampled threads`
        : `${countLabel(matches.length)} of ${countLabel(sessions.length)} threads`}</p>
      <label className="trace-thread-picker">Open a thread
        <NativeSelect value={matches.some(({ thread }) => thread.id === active) ? active : ""}
          disabled={!matches.length} onChange={(event) => {
            if (event.currentTarget.value) location.assign(sessionPath(event.currentTarget.value));
          }}>
          <option value="" disabled>Choose a thread</option>
          {matches.map(({ thread }) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </NativeSelect>
      </label>
      <ul>{matches.map(({ thread, end, count, signals }) =>
        <li key={thread.id}><a href={sessionPath(thread.id)} aria-current={active === thread.id ? "page" : undefined}>
          <strong>{thread.title}</strong><small>{dayLabel(traceUtc(thread.start))}{count > 0 && ` · ${traceElapsed(end)} observed`}{signals > 0 && ` · ${signals} ${signals === 1 ? "signal" : "signals"}`}</small>
        </a></li>)}</ul>
    </nav>
    <div className="trace-workspace">
      <p className="trace-study">Study capture through {utcLabel(traceUtc(study.cutoff))}</p>
      <SelectedTrace key={active} id={active} />
    </div>
  </div>;
}

function SessionHistoryPage() {
  const { result, retry } = useEvidence<{ study: Study | null; sessions: HistoryEntry[] }>("/api/v1/sessions");
  return <main className="trace-page">
    <header className="trace-masthead"><div className="trace-brand">plow</div><a href="/">Shipping review</a></header>
    <div className="trace-content">
      <h1>Session history</h1>
      {result.state === "loading" && <p className="trace-message" role="status">Loading session history…</p>}
      {result.state === "error" && <div className="trace-message" role="alert"><p>{result.message}</p>
        <Button variant="outline" onClick={retry}>Retry session history</Button></div>}
      {result.state === "ready" && (result.data.study && result.data.sessions.length
        ? <SessionStudy sessions={result.data.sessions} study={result.data.study} />
        : <div className="trace-message"><h2>{result.data.study ? "No threads in this study" : "No session study loaded"}</h2>
          <p>Load a private waterfall export into the Harbor snapshot to view session history.</p></div>)}
    </div>
  </main>;
}
