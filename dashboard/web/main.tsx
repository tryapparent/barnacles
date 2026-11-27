import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Button, Card } from "./controls";
import { AgentWorkTrend } from "./visual/agent-work-trend";
import { FieldSettings, Summary } from "./visual/charts";

export { renderAgentWorkTrend } from "./visual/agent-work-trend";
export { renderSummary } from "./visual/charts";

export { hideTimelineTooltip, renderTimelineControls, showTimelineTooltip, wireChartInput } from "./controls";

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

function Bottlenecks({ api }: { api: string }) {
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

function Dashboard({ field, fieldTexture, sessionHistory, analysisApi }: { field: string; fieldTexture?: string; sessionHistory?: string; analysisApi?: string }) {
  return <>
    <main>
      <header className="activity-header">
        <img src={field} alt="" />
        <div className="activity-meta">
          <p className="wordmark">plow</p>
          <div className="activity-links">
            {sessionHistory && <a id="session-history-link" href={sessionHistory}>Session history</a>}
            {fieldTexture && <FieldSettings />}
          </div>
        </div>
        <h1>Thread activity</h1>
      </header>
      <div className="board">
        <p className="summary-note" id="feed-status">Session data is temporarily unavailable. Reload to try again.</p>
        <div id="feed-content" hidden>
          <div className="activity-overview"><AgentWorkTrend /><Summary fieldTexture={fieldTexture} /></div>
          <Card id="timeline-panel" aria-labelledby="timeline-heading">
            <div className="timeline-heading-row">
              <h2 id="timeline-heading">Timeline</h2>
              <p id="timeline-selection" role="status" />
              <Popover>
                <PopoverTrigger render={<Button variant="outline" className="timeline-help" />} aria-label="Timeline guide" title="Timeline guide">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                </PopoverTrigger>
                <PopoverContent className="timeline-guide" align="end" sideOffset={6} inline keepMounted>
                  <PopoverTitle>Timeline guide</PopoverTitle>
                  <PopoverDescription>Drag across the chart to zoom. Select a bar to fit its thread. Hover over a phase or failure to see details.</PopoverDescription>
                  <p>Resize or slide the minimap selection. Ctrl+scroll or Ctrl+↑/↓ zooms. Use arrow keys to pan and Home to reset.</p>
                  <ul className="chart-key" aria-label="Chart key">
                    <li><i className="work-key" />Provider run</li>
                    <li><i className="wait-key" />Admission wait</li>
                    <li><i className="unclear-key" />Unobserved</li>
                    <li id="failure-key" hidden><i className="failure-key" />Failure</li>
                  </ul>
                  <p id="feed-cutoff" hidden />
                </PopoverContent>
              </Popover>
            </div>
            <div className="time-strip">
              <div className="navigator">
                <div id="minimap" className="minimap" tabIndex={0} role="slider" aria-label="Position of visible time range"
                  aria-description="Use the left and right arrow keys to pan. Press Home to reset."
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={50}>
                  <div className="mini-threads" /><div className="mini-window" /><div className="mini-brush" hidden />
                </div>
                <div className="mini-handles" />
              </div>
            </div>
            <div className="timeline-viewport" id="timeline-viewport" role="region" aria-label="UTC timelines" tabIndex={0}
              aria-keyshortcuts="Control+ArrowUp Control+ArrowDown ArrowLeft ArrowRight Home">
              <div className="timeline-grid" id="timeline-grid">
                <div className="table-head">
                  <span className="pinned-heading">Thread</span>
                  <span id="chart-ruler" className="chart-ruler" aria-label="Timeline axis in UTC">
                    <span className="utc-meta">UTC</span><span id="scale-caption" className="utc-scale" />
                  </span>
                </div>
                <ol className="rows" id="traces" aria-label="Observed thread timelines" />
              </div>
            </div>
            <div className="inspector-slot">
              <section className="inspect-panel" id="thread-inspector" tabIndex={0} aria-labelledby="inspector-heading" hidden />
            </div>
          </Card>
        </div>
        {analysisApi && <Bottlenecks api={analysisApi} />}
      </div>
    </main>
    <span className="measure" aria-hidden="true" />
  </>;
}

export function mountDashboard() {
  const element = document.getElementById("plow-root");
  if (!element?.dataset.field) throw Error("Missing Plow dashboard assets");
  const { field, fieldTexture, sessionHistory, analysisApi } = element.dataset;
  element.removeAttribute("data-field");
  element.removeAttribute("data-session-history");
  const root = createRoot(element);
  flushSync(() => root.render(<Dashboard field={field} fieldTexture={fieldTexture} sessionHistory={sessionHistory} analysisApi={analysisApi} />));
}
