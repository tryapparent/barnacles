import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Badge, Button } from "./controls";
import { AgentWorkTrend } from "./visual/agent-work-trend";
import { Summary } from "./visual/charts";

export { renderAgentWorkTrend } from "./visual/agent-work-trend";
export { renderSummary } from "./visual/charts";

function Dashboard({ field }: { field: string }) {
  return <>
    <main>
      <header className="activity-header">
        <img src={field} alt="" />
        <div className="activity-meta">
          <p className="wordmark">plow</p>
          <Badge className="prototype">Sample data</Badge>
        </div>
        <h1>Thread activity</h1>
      </header>
      <div className="board">
        <div className="activity-overview"><AgentWorkTrend /><Summary /></div>
        <section id="timeline-panel" aria-labelledby="timeline-heading">
          <div className="timeline-heading-row">
            <div><h2 id="timeline-heading">Timeline</h2><p id="timeline-selection" role="status" /></div>
            <div className="controls zoom-tools" role="group" aria-label="Zoom time range">
              <Button type="button" id="zoom-out" aria-label="Zoom out" title="Zoom out">−</Button>
              <Button type="button" id="zoom-in" aria-label="Zoom in" title="Zoom in">+</Button>
              <Button type="button" id="zoom-fit">Fit all</Button>
              <output id="zoom-mode" aria-live="polite" />
            </div>
          </div>
          <div className="navigator">
            <div id="minimap" className="minimap" tabIndex={0} role="slider" aria-label="Position of visible time range"
              aria-description="Use the left and right arrow keys to pan when zoomed in." aria-valuemin={0} aria-valuemax={100} aria-valuenow={50}>
              <div className="mini-threads" /><div className="mini-window" /><div className="mini-brush" hidden />
            </div>
          </div>
          <p className="utc-window" id="utc-window" aria-live="polite" />
          <ul className="chart-key" aria-label="Chart key">
            <li><i className="work-key" />Agent work</li>
            <li><i className="wait-key" />Workflows or waits</li>
            <li><i className="unclear-key" />Unclear (blended)</li>
            <li id="failure-key" hidden><i className="failure-key" />Failure</li>
          </ul>
          <div className="timeline-viewport" id="timeline-viewport" tabIndex={0} role="region" aria-label="Scrollable UTC timelines">
            <div className="timeline-grid" id="timeline-grid">
              <div className="table-head">
                <span className="pinned-heading">Thread</span>
                <span id="chart-ruler" className="chart-ruler" aria-label="Timeline axis in UTC">
                  <span className="utc-meta">UTC</span><span id="scale-caption" className="utc-scale" />
                </span>
              </div>
              <ol className="rows" id="traces" aria-label="Sample thread timelines" />
            </div>
          </div>
          <div className="inspector-slot">
            <section className="inspect-panel" id="thread-inspector" tabIndex={0} aria-labelledby="inspector-heading" hidden />
          </div>
          <details className="reading-help">
            <summary>How to read the chart</summary>
            <div className="help-copy" tabIndex={0} role="region" aria-label="Chart instructions">
              <p>The rows share a UTC clock. Scroll up and down through threads, and horizontally to pan when zoomed in. Drag the minimap to select a range, or use its arrow keys to pan when zoomed in. You can also drag the UTC axis. At six hours or less, select a thread to see its recorded events below the chart, timed from its first message. Brown can include time when a workflow ran alongside other work. Unclear intervals blend with nearby colors. A blended interval can look like the workflow around it. Very short slices merge at this zoom level. X1 also uses reviewed phase boundaries. The other nine rows use captured timestamps.</p>
            </div>
          </details>
        </section>
      </div>
    </main>
    <span className="measure" aria-hidden="true" />
  </>;
}

export function mountDashboard() {
  const element = document.getElementById("plow-root");
  if (!element?.dataset.field) throw Error("Missing Plow dashboard assets");
  const field = element.dataset.field;
  element.removeAttribute("data-field");
  const root = createRoot(element);
  flushSync(() => root.render(<Dashboard field={field} />));
}
