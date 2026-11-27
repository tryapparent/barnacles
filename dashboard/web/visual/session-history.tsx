import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { changeValues, countLabel, dayLabel, sessionPath, sessionEventList, sessionPolicy, useEvidence, utcLabel,
  type HistoryEntry, type HistoryEvent, type HistoryLane, type HistoryTrace } from "../api";
import { Button, NativeSelect } from "../controls";
import "./session-history.css";

const SessionViews = lazy(() => import("./session-timeline").then(({ SessionViews }) => ({ default: SessionViews })));

const traceElapsed = (value: number) => sessionPolicy.trace_elapsed(Math.max(0, Math.round(value)));
const traceEnd = (event: HistoryEvent) => event.end.$ === "Some" ? event.end.value : null;
const traceDuration = (event: HistoryEvent) => {
  const end = traceEnd(event);
  return end === null ? "End unknown" : end === event.start ? "Event" : traceElapsed(end - event.start);
};
const traceUtc = (time: number) => new Date(time).toISOString();

type TraceRange = { from: number; to: number };
type Study = { cutoff: number; replay: boolean };

function TraceMarks({ event, range }: { event: HistoryEvent; range: TraceRange }) {
  const x = (time: number) => (time - range.from) / Math.max(1, range.to - range.from) * 1000;
  const end = traceEnd(event);
  const left = Math.max(0, x(event.start));
  const point = Math.max(3, Math.min(997, left));
  return <svg className="trace-marks" viewBox="0 0 1000 24" preserveAspectRatio="none" aria-hidden="true">
    <path className="trace-rail" d="M500,0V24" />
    {end === null ? <path className="trace-unknown" d={`M${point - 3},15l6,-6`} />
      : end === event.start ? <path className="trace-point" d={`M${point},7v10`} />
      : <path className="trace-span" d={`M${left},12H${Math.min(1000, Math.max(left + 1, x(end)))}`} />}
    {end !== null && end > range.to && <path className="trace-continued" d="M991,6L1000,12L991,18" />}
  </svg>;
}

function TraceChart({ records, lanes, range, fullEnd, zoomed, active, inspection, select, resetZoom }: {
  records: HistoryEvent[]; lanes: HistoryLane[]; range: TraceRange; fullEnd: number; zoomed: boolean;
  active: number | null; inspection: ReactNode; select: (record: HistoryEvent) => void; resetZoom: () => void;
}) {
  const ticks = [range.from, (range.from + range.to) / 2, range.to];
  return <figure className="trace-chart" aria-labelledby="trace-chart-title">
    <figcaption id="trace-chart-title">Trace waterfall</figcaption>
    {(zoomed || range.from > 0 || range.to < fullEnd) && <div className="trace-zoom">
      <div><p>Full trace · {traceElapsed(fullEnd)}</p><div className="trace-zoom-track" aria-hidden="true"><span
        style={{ inlineSize: `${(range.to - range.from) / Math.max(1, fullEnd) * 100}%`,
          insetInlineStart: `${range.from / Math.max(1, fullEnd) * 100}%` }} /></div></div>
      {zoomed && <Button variant="outline" onClick={resetZoom}>Reset timeline zoom</Button>}
    </div>}
    <div className="trace-ruler">
      <div aria-label="Elapsed from thread start">{ticks.map((tick, index) => <span key={index}>{traceElapsed(tick)}</span>)}</div>
    </div>
    <ol className="trace-waterfall-rows">
      {records.map((event) => {
        const clock = lanes[event.lane].name;
        return <li key={event.index}>
          <button className="trace-lane" type="button" aria-pressed={active === event.index} data-lane={event.lane}
            title={`${event.label} · ${clock} · ${traceDuration(event)}`} onClick={() => select(event)}>
            <span className="sr-only"><strong>{event.label}</strong> · {clock} · starts at {traceElapsed(event.start)} · {traceDuration(event)}</span>
            <TraceMarks event={event} range={range} />
          </button>
        </li>;
      })}
    </ol>
    <p className="trace-key"><span><i className="trace-key-span" /> Interval</span><span><i className="trace-key-point" /> Event</span>
      <span><i className="trace-key-unknown" /> End unknown</span></p>
    {inspection}
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
  const [longest, setLongest] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<HistoryEvent | null>(null);
  const [focus, setFocus] = useState<TraceRange | null>(null);
  const full = { from: 0, to: entry.end };
  const range = focus ?? full;
  const events = useMemo(() => {
    const candidates = sessionEventList(lane === null ? lanes.flatMap((item) => item.events) : lanes[lane].events);
    return longest ? sessionPolicy.order_duration(candidates) : sessionPolicy.order_events(candidates);
  }, [lanes, lane, longest]);
  const page = useMemo(() => sessionPolicy.session_events(events, range.from, range.to, query, offset),
    [events, range.from, range.to, query, offset]);
  const records = changeValues(page.rows);
  const first = records[0]?.start ?? 0;
  const last = records.at(-1)?.start ?? first;
  const chartRange = focus ?? (longest || first === last ? full : {
    from: first,
    to: Math.min(full.to, last + Math.ceil((last - first) / 8)),
  });
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

  const inspection = selected && <div className="trace-inspection" ref={recordDetails} tabIndex={-1} aria-live="polite">
    <div><strong>{selected.label}</strong><p>{lanes[selected.lane].name} · {traceUtc(thread.start + selected.start)} · {traceDuration(selected)}</p>
      <p>{selected.clipped && "Clipped at study boundary · "}{selected.state && selected.state + " · "}
        {selected.relation === "mentioned" ? "Mentioned in thread" : selected.relation === "worktree" ? "Matched worktree" : "Linked evidence"}
        {selected.source && (selected.source.startsWith("https:") ? <> · <a href={selected.source}>Source record</a></> : " · " + selected.source)}</p></div>
    <Button variant="outline" onClick={() => focusEvent(selected)}>Zoom to record</Button>
  </div>;

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
    {entry.count > 0 ? <div className="trace-evidence">
      <section aria-label="Trace waterfall" className="trace-records">
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
          <label>Sort<NativeSelect value={longest ? "longest" : "start"} onChange={(event) => {
            setLongest(event.currentTarget.value === "longest");
            setOffset(0);
          }}>
            <option value="start">Start time</option><option value="longest">Longest first</option>
          </NativeSelect></label>
        </div>
        <p className="trace-result-count" role="status">{countLabel(page.total)} matching {page.total === 1 ? "record" : "records"}</p>
        {page.total > 0 && <>
          <TraceChart records={records} lanes={lanes} range={chartRange} fullEnd={full.to} zoomed={focus !== null}
            active={selected?.index ?? null} inspection={inspection} select={setSelected} resetZoom={() => setRange(null)} />
          {page.total > 20 && <nav className="trace-pagination" aria-label="Trace record pages">
            <Button variant="outline" disabled={!offset} onClick={() => setOffset(offset - 20)}>Previous</Button>
            <span>{offset + 1}–{Math.min(offset + 20, page.total)} of {countLabel(page.total)}</span>
            <Button variant="outline" disabled={offset + 20 >= page.total} onClick={() => setOffset(offset + 20)}>Next</Button>
          </nav>}
          <p className="trace-coverage">Rows share one elapsed-time axis. An arrow marks an interval that continues past the visible window.</p>
        </>}
        {page.total === 0 && <div className="trace-message">
          <p>No records match these filters.</p>
          {focus && <Button variant="outline" onClick={() => setRange(null)}>Reset timeline zoom</Button>}
        </div>}
      </section>
      <TraceSignals study={study} signals={signals} reveal={revealSignal} />
    </div> : <p className="trace-message">This thread has no retained timing records.</p>}
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

export function SessionHistoryPage() {
  const { result, retry } = useEvidence<{ study: Study | null; sessions: HistoryEntry[] }>("/api/v1/sessions");
  return <main className="trace-page">
    <header className="trace-masthead"><div className="trace-brand">plow</div><a href="/">Shipping review</a></header>
    <div className="trace-content">
      <h1>Session history</h1>
      {result.state === "loading" && <p className="trace-message" role="status">Loading session history…</p>}
      {result.state === "error" && <div className="trace-message" role="alert"><p>{result.message}</p>
        <Button variant="outline" onClick={retry}>Retry session history</Button></div>}
      {result.state === "ready" && (result.data.study && result.data.sessions.length
        ? <Suspense fallback={<p role="status">Loading session views…</p>}>
          <SessionViews sessions={result.data.sessions} waterfall={<SessionStudy sessions={result.data.sessions} study={result.data.study} />} />
        </Suspense>
        : <div className="trace-message"><h2>{result.data.study ? "No threads in this study" : "No session study loaded"}</h2>
          <p>Load a private waterfall export into the Harbor snapshot to view session history.</p></div>)}
    </div>
  </main>;
}
