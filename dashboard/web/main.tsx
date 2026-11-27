import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Button, Card } from "./controls";
import { AgentWorkTrend } from "./visual/agent-work-trend";
import { Summary } from "./visual/charts";

export { renderAgentWorkTrend } from "./visual/agent-work-trend";
export { renderSummary } from "./visual/charts";

export { hideTimelineTooltip, renderTimelineControls, showTimelineTooltip } from "./controls";

type ChartInput = {
  viewport: HTMLElement;
  ruler: HTMLElement;
  rows: HTMLElement;
  plot: () => { left: number; width: number };
  start: () => number;
  select: (first: number, last: number, distance: number) => void;
  pan: (fraction: number, start: number) => void;
  zoom: (factor: number, anchor: number) => void;
  reset: () => void;
  hover: (target: HTMLElement, event: PointerEvent) => void;
  dismissTip: () => void;
};

export function wireChartInput(input: ChartInput) {
  const { viewport, ruler, rows } = input;
  let drag: { pointer: number; x: number; left: number; width: number; start: number; pan: boolean; active: boolean } | undefined;
  let suppressClick = false;
  const fraction = (x: number, plot: { left: number; width: number }) =>
    Math.min(1, Math.max(0, (x - plot.left) / plot.width));

  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    suppressClick = false;
    const plot = input.plot();
    const pan = ruler.contains(event.target);
    if (!(pan || event.target.closest(".rail")) || event.clientX < plot.left || event.clientX >= plot.left + plot.width) return;
    drag = { ...plot, pointer: event.pointerId, x: event.clientX, start: input.start(), pan, active: false };
    input.dismissTip();
  });
  viewport.addEventListener("pointermove", event => {
    const target = event.target instanceof Element && event.target.closest<HTMLElement>(".fit-thread");
    if (target && event.pointerType !== "touch" && !event.buttons) input.hover(target, event);
    else input.dismissTip();
    if (!drag || drag.pointer !== event.pointerId) return;
    const distance = event.clientX - drag.x;
    if (!drag.active && Math.abs(distance) < 4) return;
    if (!drag.active) {
      viewport.setPointerCapture(event.pointerId);
      drag.active = true;
      suppressClick = true;
    }
    if (drag.pan) {
      input.pan(-distance / drag.width, drag.start);
      ruler.classList.add("panning");
      return;
    }
    const first = fraction(drag.x, drag), last = fraction(event.clientX, drag);
    const offset = drag.left - rows.getBoundingClientRect().left;
    rows.style.setProperty("--brush-left", (offset + Math.min(first, last) * drag.width) + "px");
    rows.style.setProperty("--brush-width", Math.abs(first - last) * drag.width + "px");
    rows.dataset.brushing = "";
  });
  function clear() {
    drag = undefined;
    delete rows.dataset.brushing;
    ruler.classList.remove("panning");
  }
  viewport.addEventListener("pointerup", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (drag.active && !drag.pan) {
      const first = fraction(drag.x, drag), last = fraction(event.clientX, drag);
      input.select(Math.min(first, last), Math.max(first, last), Math.abs(last - first) * drag.width);
    }
    clear();
  });
  viewport.addEventListener("pointerleave", () => { if (!drag?.active) clear(); });
  viewport.addEventListener("pointerleave", input.dismissTip);
  document.addEventListener("scroll", input.dismissTip);
  viewport.addEventListener("pointercancel", clear);
  viewport.addEventListener("lostpointercapture", clear);
  viewport.addEventListener("click", event => {
    if (suppressClick && event.detail > 0) event.stopPropagation();
  }, true);

  viewport.addEventListener("wheel", event => {
    const plot = input.plot();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plot.width : 1;
    if (event.ctrlKey) {
      event.preventDefault();
      const delta = Math.max(-60, Math.min(60, event.deltaY * unit));
      if (delta) input.zoom(Math.exp(delta * .0025), fraction(event.clientX, plot));
    } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      input.pan((event.deltaX || event.deltaY) * unit / plot.width, input.start());
    }
  }, { passive: false });
  viewport.addEventListener("keydown", event => {
    if (event.altKey || event.metaKey || drag?.active) return;
    if (event.ctrlKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      input.zoom(event.key === "ArrowUp" ? .8 : 1.25, .5);
    } else if (!event.ctrlKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      input.pan(event.key === "ArrowLeft" ? -.1 : .1, input.start());
    } else if (!event.ctrlKey && event.key === "Home") {
      input.reset();
    } else return;
    event.preventDefault();
  });
}

function Dashboard({ field, sessionHistory }: { field: string; sessionHistory?: string }) {
  return <>
    <main>
      <header className="activity-header">
        <img src={field} alt="" />
        <div className="activity-meta">
          <p className="wordmark">plow</p>
          <div className="activity-links">
            {sessionHistory && <a id="session-history-link" href={sessionHistory}>Session history</a>}
          </div>
        </div>
        <h1>Thread activity</h1>
      </header>
      <div className="board">
        <p className="summary-note" id="feed-status">Session data is temporarily unavailable. Reload to try again.</p>
        <div id="feed-content" hidden>
          <div className="activity-overview"><AgentWorkTrend /><Summary /></div>
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
      </div>
    </main>
    <span className="measure" aria-hidden="true" />
  </>;
}

export function mountDashboard() {
  const element = document.getElementById("plow-root");
  if (!element?.dataset.field) throw Error("Missing Plow dashboard assets");
  const { field, sessionHistory } = element.dataset;
  element.removeAttribute("data-field");
  element.removeAttribute("data-session-history");
  const root = createRoot(element);
  flushSync(() => root.render(<Dashboard field={field} sessionHistory={sessionHistory} />));
}
