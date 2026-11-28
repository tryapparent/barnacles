import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Button, Card } from "./controls";
import { AgentWorkTrend } from "./visual/agent-work-trend";
import { Summary } from "./visual/charts";

export { renderAgentWorkTrend } from "./visual/agent-work-trend";
export { renderSummary } from "./visual/charts";

export { hideTimelineTooltip, renderTimelineControls, showTimelineTooltip, wireChartInput } from "./controls";

type Priority = {
  kind: "confirmed-delay" | "t3-admission" | "ci-job";
  target: string;
  stage: string;
  nextStep: string;
  occurrences: number;
  affectedThreads: number | null;
  affectedOutcomes: number | null;
  measured: number;
  totalMs: number | null;
  medianMs: number | null;
  worstMs: number | null;
};

type TimeRange = "24h" | "7d";
const rangeLabels: Record<TimeRange, string> = { "24h": "Last 24 hours", "7d": "Last 7 days" };

type PrioritiesReport = { range?: TimeRange; window: { to: string }; coverage: { active: number }; priorities: Priority[] };
type PrioritiesState = { report: PrioritiesReport } | { failed: true };

const number = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const quantity = (value: number, unit: string) => `${number.format(value)} ${unit}${value === 1 ? "" : "s"}`;

function duration(ms: number | null) {
  if (ms === null) return "Unknown";
  if (ms < 1000) return `${number.format(ms)}\u00a0ms`;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  if (hours) return minutes ? `${hours}\u00a0h ${minutes}\u00a0min` : `${hours}\u00a0h`;
  if (minutes) return seconds % 60 ? `${minutes}\u00a0min ${seconds % 60}\u00a0s` : `${minutes}\u00a0min`;
  return `${seconds}\u00a0s`;
}

const readable = (value: string) => value.replaceAll("-", " ").replace(/^./u, letter => letter.toUpperCase());

function priorityLabels(item: Priority) {
  if (item.kind === "confirmed-delay") return {
    title: readable(item.target), context: readable(item.stage), clock: "Confirmed outcome delay", count: "Outcomes affected",
    reach: item.affectedOutcomes, unit: "outcome", event: "delay observation", longest: "Longest outcome delay",
  };
  if (item.kind === "t3-admission") return {
    title: "T3 admission waits",
    context: "This total adds each wait. Where time went counts any overlap with a provider run on the same thread as provider time.",
    clock: "Observed request-to-start time", count: "Threads affected",
    reach: item.affectedThreads, unit: "thread", event: "wait", longest: "Longest wait",
  };
  const job = item.target.split(" · ").slice(2).join(" · ");
  return {
    title: job ? `CI failures · ${job}` : "CI failures", context: item.target, clock: "Observed CI execution time",
    count: "Threads affected", reach: item.affectedThreads, unit: "thread", event: "failed or timed-out job", longest: "Longest execution",
  };
}

function PriorityInspector({ priorities }: { priorities: Priority[] }) {
  const [selected, select] = useState(0);
  return <div className="priority-split">
    <ol className="priority-rail" aria-label="Ranked priorities">
      {priorities.map((item, index) => {
        const label = priorityLabels(item);
        const active = index === selected;
        const summary = item.kind === "confirmed-delay" ? `${duration(item.totalMs)} confirmed`
          : quantity(item.occurrences, label.event);
        const contents = <>
          <span aria-hidden="true" className="priority-rank">{index + 1}</span>
          <span className="priority-option-copy">
            <strong id={`priority-title-${index}`}>{label.title}</strong>
            <span id={`priority-summary-${index}`}>{summary}
              {label.reach !== null && ` · ${quantity(label.reach, label.unit)}`}</span>
            <span className="priority-option-step">{item.nextStep}</span>
          </span>
        </>;
        return <li key={`${item.kind}/${item.target}/${item.stage}`}>
          {priorities.length === 1 ? <div className="priority-option" data-current>{contents}</div>
            : <Button type="button" className="priority-option" variant="outline" aria-pressed={active}
                aria-controls={`priority-detail-${index}`} aria-labelledby={`priority-title-${index}`}
                aria-describedby={`priority-summary-${index}`} onClick={() => select(index)}>
                {contents}
              </Button>}
        </li>;
      })}
    </ol>
    <div className="priority-inspector" aria-live="polite">
      {priorities.map((item, index) => {
        const label = priorityLabels(item);
        return <section className="priority-details" id={`priority-detail-${index}`} aria-hidden={index !== selected}
            aria-labelledby={`priority-heading-${index}`} key={`${item.kind}/${item.target}/${item.stage}`}>
          <h3 id={`priority-heading-${index}`}>{label.title}</h3>
          {label.context && <p className="priority-context">{label.context}</p>}
          <dl className="priority-metrics">
            <div><dt>{label.clock}</dt><dd>{duration(item.totalMs)}</dd></div>
            <div><dt>{label.count}</dt><dd>{label.reach === null ? "Unknown" : number.format(label.reach)}</dd></div>
          </dl>
          <p className="priority-coverage">Timing available for {number.format(item.measured)} of {quantity(item.occurrences, label.event)}
            {item.medianMs !== null && ` · Median per outcome ${duration(item.medianMs)}`}
            {item.worstMs !== null && ` · ${label.longest} ${duration(item.worstMs)}`}</p>
          <h4>Next step</h4>
          <p className="priority-next">{item.nextStep}</p>
        </section>;
      })}
    </div>
  </div>;
}

function Priorities({ api, range }: { api: string; range: TimeRange }) {
  const [result, setResult] = useState<PrioritiesState>();
  const [attempt, retry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const url = new URL(api);
    if (range === "7d") url.searchParams.set("range", range);
    fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
      .then(async response => {
        if (!response.ok) throw Error("Priorities request failed");
        const report: PrioritiesReport = await response.json();
        if (!Array.isArray(report.priorities) || !Number.isSafeInteger(report.coverage?.active) ||
            !Number.isFinite(Date.parse(report.window?.to)) || (range === "7d" && report.range !== range)) throw Error("Invalid priorities report");
        if (!controller.signal.aborted) setResult({ report });
      })
      .catch(() => { if (!controller.signal.aborted) setResult({ failed: true }); });
    return () => controller.abort();
  }, [api, range, attempt]);
  const report = result && "report" in result ? result.report : undefined;
  return <Card className="priorities" aria-labelledby="priorities-heading">
    <header className="priorities-heading">
      <h2 id="priorities-heading" ref={heading} tabIndex={-1}>{range === "24h" ? "What to fix today" : "What to fix this week"}</h2>
      <p>{rangeLabels[range]}{report && <> · {quantity(report.coverage.active, "active thread")} ·
        {" Ending "}<time dateTime={report.window.to}>{time.format(new Date(report.window.to))}</time></>}</p>
    </header>
    {!result && <p className="priority-status" role="status">Loading priorities…</p>}
    {result && "failed" in result && <div className="priority-status">
      <p role="status">Couldn’t load priorities. Check your private connection and try again.</p>
      <Button type="button" variant="outline" onClick={() => {
        heading.current?.focus();
        setResult(undefined);
        retry(value => value + 1);
      }}>Try again</Button>
    </div>}
    {report && (report.priorities.length > 0 ? <PriorityInspector priorities={report.priorities} />
      : <p className="priority-status">{report.coverage.active
        ? "No priorities in the captured evidence for this window."
        : "No thread activity was captured in this window."}</p>)}
  </Card>;
}

function Dashboard({ field, fieldTexture, analysisApi }: { field: string; fieldTexture?: string; analysisApi?: string }) {
  const [range, setRange] = useState<TimeRange>("24h");
  return <>
    <main>
      <img className="activity-landscape" src={field} alt="" />
      <header className="activity-header">
        <div className="activity-meta">
          <p className="wordmark">plow</p>
          <div className="time-range" role="group" aria-label="Time frame">
            <span aria-hidden="true">Time frame</span>
            {(["24h", "7d"] as const).map(option =>
              <Button key={option} type="button" variant="outline" aria-label={rangeLabels[option]}
                aria-pressed={range === option} onClick={() => {
                  if (range === option) return;
                  setRange(option);
                  document.dispatchEvent(new CustomEvent("plow-range-change", { detail: option }));
                }}>{option === "24h" ? "24h" : "7 days"}</Button>
            )}
          </div>
        </div>
        <h1 className="visually-hidden">Thread activity</h1>
      </header>
      <div className="board">
        <p className="summary-note" id="feed-status" role="status">Session data is temporarily unavailable. Reload to try again.</p>
        <div id="feed-content" hidden>
          <p className="visually-hidden" id="overview-period">{rangeLabels[range]}</p>
          <div className="activity-overview"><Summary fieldTexture={fieldTexture} /><AgentWorkTrend /></div>
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
        {analysisApi && <Priorities key={range} api={analysisApi} range={range} />}
      </div>
    </main>
    <span className="measure" aria-hidden="true" />
  </>;
}

export function mountDashboard() {
  const element = document.getElementById("plow-root");
  if (!element?.dataset.field) throw Error("Missing Plow dashboard assets");
  const { field, fieldTexture, analysisApi } = element.dataset;
  element.removeAttribute("data-field");
  element.removeAttribute("data-field-texture");
  const root = createRoot(element);
  flushSync(() => root.render(<Dashboard field={field} fieldTexture={fieldTexture} analysisApi={analysisApi} />));
}
