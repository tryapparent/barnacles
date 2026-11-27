import { useEffect, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Button } from "../controls";

type Category = {
  kind: number;
  name: string;
  style: string;
  duration: string;
  share: string;
  expanded: boolean;
  select: () => void;
};

type Operation = {
  key: string;
  name: string;
  metric?: string;
  active?: boolean;
  select: () => void;
};

type Overview = {
  total: string;
  note: string;
  categories: Category[];
  breakdown?: string;
  operations: Operation[];
  emptyOperations: boolean;
  close: () => void;
  clearOperation?: () => void;
};

let overview: Overview | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function renderSummary(model: Overview) {
  flushSync(() => {
    overview = model;
    listeners.forEach(listener => listener());
  });
}

export function Summary() {
  const model = useSyncExternalStore(subscribe, () => overview);
  return <section className="summary-panel" id="summary-panel" aria-labelledby="summary-heading">
    <div className="summary-top">
      <h2 id="summary-heading">Where time went</h2>
      <p id="summary-total">{model?.total}</p>
    </div>
    <p id="summary-note" className="summary-note">{model?.note}</p>
    <div id="tiles" className="treemap">
      {model?.categories.map(category => <Button type="button" key={category.kind}
        className={`category-tile ${category.style}`} data-kind={category.kind}
        aria-expanded={category.expanded} aria-controls="operation-panel" onClick={category.select}>
        <span className="category-name">{category.name}</span>
        <span className="category-metric">{category.duration}<span className="category-share">{category.share}</span></span>
        <span className="category-icon" aria-hidden="true">{category.expanded ? "−" : "+"}</span>
      </Button>)}
    </div>
    <section id="operation-panel" hidden={!model?.breakdown} aria-labelledby="operation-heading"
      onKeyDown={event => {
        if (event.key === "Escape" && model?.clearOperation) {
          event.preventDefault();
          model.clearOperation();
        }
      }}>
      <div className="operation-heading">
        <h3 id="operation-heading">{model?.breakdown}</h3>
        <Button type="button" id="collapse" aria-label="Close breakdown" onClick={model?.close}><span aria-hidden="true">×</span></Button>
      </div>
      <div id="operation-tiles" role="group" aria-label="Operations">
        {model?.operations.map(operation => <Button type="button" key={operation.key}
          className="operation-tile" data-operation={operation.key} aria-pressed={operation.active} onClick={operation.select}>
          {operation.metric ? <>
            <span className="operation-name">{operation.name}<span className="selected-indicator" aria-hidden="true">✓</span></span>
            <span className="operation-metric">{operation.metric}</span>
          </> : operation.name}
        </Button>)}
      </div>
      <p id="operation-empty" className="summary-note" hidden={!model?.emptyOperations}>No operations in this range. Try zooming out.</p>
    </section>
  </section>;
}

type Coverage = { t3Runs: number; codexSpans: number; githubJobs: number };
type DelayCoverage = { sufficient: number; occurrences: number };
type OutcomeImpact = { totals: { coverage: DelayCoverage; affectedOutcomes: number; confirmedMs: number | null; sharedMs: number | null };
  patterns: { pattern: string; stage: string; affectedOutcomes: number; uniqueMs: number | null }[] };
type Analysis = { analyzedAt: string; bounded?: boolean; window?: { from: string; to: string };
  coverage?: { active: number; withCodex: number; withCI: number; withBoth: number };
  outcomeImpact?: OutcomeImpact | null;
  ranking: { rule: string; threads: number; occurrences: number }[];
  threads: { id: string; coverage: Coverage }[] };
type Detail = { coverage: Coverage; rules: string[]; costs: { clock: string; operation: string; seconds: number; unknown: number }[] };

export function Bottlenecks({ api }: { api: string }) {
  const [data, setData] = useState<Analysis>();
  const [thread, setThread] = useState("");
  const [detail, setDetail] = useState<Detail>();
  const [status, setStatus] = useState("Loading analysis…");
  const [detailStatus, setDetailStatus] = useState("");
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(api, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(8000)]) })
      .then(res => { if (!res.ok) throw Error(); return res.json(); })
      .then((result: Analysis) => { setData(result); setStatus(""); })
      .catch(() => { if (!ctrl.signal.aborted) setStatus("Analysis is unavailable. Check your private connection and reload."); });
    return () => ctrl.abort();
  }, [api]);
  useEffect(() => {
    if (!thread) return;
    const ctrl = new AbortController();
    fetch(`${api}/threads/${thread}`, { signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(8000)]) })
      .then(res => { if (!res.ok) throw Error(); return res.json(); })
      .then((result: Detail) => { setDetail(result); setDetailStatus(""); })
      .catch(() => { if (!ctrl.signal.aborted) setDetailStatus("Thread details are unavailable."); });
    return () => ctrl.abort();
  }, [api, thread]);
  const label = (rule: string) => rule.replaceAll("-", " ");
  const count = (n: number, singular: string) => `${n} ${singular}${n === 1 ? "" : "s"}`;
  const duration = (ms: number | null) => ms === null ? "Unknown"
    : `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} s`;
  const impact = data?.outcomeImpact;
  const clockLabels: Record<string, string> = {
    "ci-job-queue": "CI job queue",
    "ci-job-execution": "CI job execution",
    "codex-otel-span": "Codex span",
    "t3-run-envelope": "T3 run",
    "t3-run-admission": "T3 admission",
  };
  return <section className="bottlenecks" aria-labelledby="bottlenecks-heading">
    <h2 id="bottlenecks-heading">Bottlenecks</h2>
    {status && <p role="status">{status}</p>}
    {data && <>
      <p className="summary-note">{data.window && "Last 24 hours · "}{count(data.threads.length, data.window ? "active thread" : "joined thread")}
        {data.window ? <br /> : " · "}{data.window ? "Window ending " : "Analyzed "}
        <time dateTime={data.window?.to ?? data.analyzedAt}>
          {new Date(data.window?.to ?? data.analyzedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
        {data.bounded && " · Recent threads only"}</p>
      {data.coverage && <p className="summary-note">Threads with links · Codex {data.coverage.withCodex} · CI {data.coverage.withCI}</p>}
      {data.window && (impact && impact.totals.coverage.occurrences > 0 ? <>
        <p>Confirmed outcome delay · {duration(impact.totals.confirmedMs)} over {count(impact.totals.affectedOutcomes, "outcome")}
          {impact.totals.sharedMs ? ` · ${duration(impact.totals.sharedMs)} shared` : ""}</p>
        <p className="summary-note">{impact.totals.coverage.sufficient} of {impact.totals.coverage.occurrences} delay observations had sufficient evidence.</p>
        {impact.patterns.length > 0 && <table><caption>Outcome delay by pattern</caption>
          <thead><tr><th scope="col">Pattern</th><th scope="col">Outcomes</th><th scope="col">Unique delay</th></tr></thead>
          <tbody>{impact.patterns.map(item => <tr key={`${item.stage}/${item.pattern}`}><th scope="row">
            {label(item.pattern)} · {label(item.stage)}</th><td>{item.affectedOutcomes}</td><td>{duration(item.uniqueMs)}</td></tr>)}</tbody>
        </table>}
      </> : <p className="summary-note">Confirmed outcome delay is unknown for this window.</p>)}
      {data.ranking.length ? <table><caption>Findings ranked by affected threads</caption>
        <thead><tr><th scope="col">Finding</th><th scope="col">Threads</th><th scope="col">Events</th></tr></thead>
        <tbody>{data.ranking.map(item => <tr key={item.rule}><th scope="row">{label(item.rule)}</th>
          <td>{item.threads}</td><td>{item.occurrences}</td></tr>)}</tbody>
      </table> : <p>{data.window
        ? data.threads.length ? "No linked CI failures or timeouts were observed." : "No captured T3 activity in this window."
        : data.threads.length ? "No findings in the observed evidence." : "No joined threads yet."}</p>}
      {data.threads.length > 0 && <label className="analysis-thread">Thread details
        <select value={thread} onChange={event => {
          setDetail(undefined);
          setDetailStatus(event.target.value ? "Loading thread…" : "");
          setThread(event.target.value);
        }}><option value="">Select a thread</option>
          {data.threads.map((item, index) => <option key={item.id} value={item.id}>Thread {index + 1}</option>)}
        </select>
      </label>}
      {detailStatus && <p role="status">{detailStatus}</p>}
      {detail && <>
        <p>{count(detail.coverage.t3Runs, "T3 run")} · {count(detail.coverage.codexSpans, "Codex span")} · {count(detail.coverage.githubJobs, "GitHub job")}</p>
        {detail.rules.length > 0 && <ul>{detail.rules.map((rule, index) => <li key={index}>{label(rule)}</li>)}</ul>}
        {detail.costs.length > 0 && data.window && <p className="summary-note">Full thread timings</p>}
        {detail.costs.length > 0 && <ul aria-label="Measured clocks">{detail.costs.map(cost =>
          <li key={`${cost.clock}:${cost.operation}`}>{clockLabels[cost.clock] ?? label(cost.clock)} · {cost.operation.replaceAll("_", " ")} · {cost.seconds}s
            {cost.unknown > 0 && ` · ${cost.unknown} unknown`}</li>)}</ul>}
      </>}
    </>}
  </section>;
}
