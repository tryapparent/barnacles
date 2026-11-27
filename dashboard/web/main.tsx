import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Badge, Button } from "./controls";
import { Summary } from "./visual/charts";

export { renderSummary } from "./visual/charts";

function Dashboard({ field, sessionHistory }: { field: string; sessionHistory?: string }) {
  return <>
    <main>
      <header className="activity-header">
        <img src={field} alt="" />
        <div className="activity-meta">
          <p className="wordmark">plow</p>
          <div className="activity-links">
            <Badge className="prototype" id="feed-cutoff" hidden />
            {sessionHistory && <a id="session-history-link" href={sessionHistory}>Session history</a>}
          </div>
        </div>
        <h1>Thread activity</h1>
      </header>
      <div className="board">
        <p className="summary-note" id="feed-status">Session data is temporarily unavailable. Reload to try again.</p>
        <div id="feed-content" hidden>
          <Summary />
          <section id="timeline-panel" aria-labelledby="timeline-heading">
            <div className="timeline-heading-row">
              <div><h2 id="timeline-heading">Timeline</h2><p id="timeline-selection" role="status" /></div>
            </div>
            <div className="time-strip">
              <div className="navigator">
                <div id="minimap" className="minimap" tabIndex={0} role="slider" aria-label="Position of visible time range"
                  aria-description="Use the left and right arrow keys to pan when zoomed in." aria-valuemin={0} aria-valuemax={100} aria-valuenow={50}>
                  <div className="mini-threads" /><div className="mini-window" /><div className="mini-brush" hidden />
                </div>
              </div>
              <div className="controls zoom-tools" role="group" aria-label="Zoom time range">
                <Button type="button" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</Button>
                <Button type="button" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</Button>
                <Button type="button" id="zoom-fit">Fit all</Button>
                <output id="zoom-mode" aria-live="polite" />
              </div>
            </div>
            <div className="time-caption">
              <p className="utc-window" id="utc-window" aria-live="polite" />
              <ul className="chart-key" aria-label="Chart key">
                <li><i className="work-key" />Provider run</li>
                <li><i className="wait-key" />Admission wait</li>
                <li><i className="unclear-key" />Unobserved</li>
                <li id="failure-key" hidden><i className="failure-key" />Failure</li>
              </ul>
            </div>
            <div className="timeline-viewport" id="timeline-viewport" tabIndex={0} role="region" aria-label="Scrollable UTC timelines">
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
            <details className="reading-help">
              <summary>How to read the chart</summary>
              <div className="help-copy" tabIndex={0} role="region" aria-label="Chart instructions">
                <p>The chart shows the ten newest imported threads with measured time on a shared UTC clock. Provider runs can include idle time, tool calls, or workflows. Admission lasts from run request to provider start. Unobserved gaps have no confirmed activity. Scroll vertically to see more threads. Drag the minimap to select a range, use its arrow keys to pan, or drag the UTC axis. At six hours or less, select a thread to inspect events timed from its start.</p>
              </div>
            </details>
          </section>
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
