import { useId, useSyncExternalStore } from "react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { Button } from "../controls";

type Batch = { first: number; last: number; measured: number; basis_points: number };
type Point = { x: number; y: number };
let batches: Batch[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function renderAgentWorkTrend(next: Batch[]) {
  batches = next;
  listeners.forEach(listener => listener());
}

function segmentPaths(data: Batch[]) {
  const segments: Point[][] = [];
  let current: Point[] = [];
  data.forEach((batch, index) => {
    if (!batch.measured) {
      current = [];
      return;
    }
    if (current.length === 0) segments.push(current);
    current.push({ x: 53 + index * 329 / Math.max(1, data.length - 1), y: 112 - batch.basis_points / 100 });
  });
  return segments.map(points => {
    const [first] = points;
    const curve = points.slice(1).reduce((path, point, i) => {
      const previous = points[i];
      const dx = (point.x - previous.x) / 3;
      return path + ` C${previous.x + dx},${previous.y} ${point.x - dx},${point.y} ${point.x},${point.y}`;
    }, `M${first.x},${first.y}`);
    return {
      curve,
      soil: `${curve} V12 H${first.x} Z`,
      canopy: `${curve} V112 H${first.x} Z`,
      first,
      length: points.length,
    };
  });
}

export function AgentWorkTrend() {
  const data = useSyncExternalStore(subscribe, () => batches);
  const id = useId();
  const first = data[0];
  const last = data[data.length - 1];
  const paths = segmentPaths(data);
  const field = paths.filter(path => path.length > 1);
  const label = (batch: Batch) => `${batch.first}–${batch.last}`;
  return <section className="agent-work-trend" aria-labelledby={id}>
    <h2 id={id}>Agent work share</h2>
    <Collapsible className="trend-disclosure">
      <div className="trend-plot">
      {first && paths.length > 0 ? <svg viewBox="0 0 400 145" role="img" aria-label="Agent work share across batches of ten threads.">
        <defs>
          <clipPath id={`${id}-soil`}>
            {field.map(({ soil, first }) => <path key={first.x} d={soil} />)}
          </clipPath>
          <clipPath id={`${id}-canopy`}>
            {field.map(({ canopy, first }) => <path key={first.x} d={canopy} />)}
          </clipPath>
        </defs>
        {field.length > 0 && (["soil", "canopy"] as const).map(material =>
          <foreignObject className="trend-field" key={material} x="53" y="12" width="329" height="100"
            clipPath={`url(#${id}-${material})`}>
            <div className={`trend-material trend-${material}`} />
          </foreignObject>)}
        {[100, 50, 0].map(value =>
          <text key={value} x="43" y={116 - value} textAnchor="end">{value}%</text>)}
        {paths.map(({ curve, first, length }) => <path className={length === 1 ? "trend-series" : "trend-series trend-field-outline"} key={first.x}
          d={length === 1 ? `M${first.x - 4},${first.y}h8` : curve}
          fill="none" stroke="#3c5930" strokeWidth="2.2" strokeLinecap="round" />)}
        <text x="51" y="134">Threads {label(first)}</text>
        {last !== first && <text x="389" y="134" textAnchor="end">Threads {label(last)}</text>}
      </svg> : <p className="agent-work-empty">{first ? "No classified time in the recorded batches." : "The trend starts after 10 threads."}</p>}
      </div>
      {first && <>
        <CollapsibleTrigger render={<Button variant="outline" className="batch-trigger" />}>Batch data</CollapsibleTrigger>
        <CollapsiblePanel className="trend-batch-panel" role="region" aria-label="Batch data" tabIndex={0}>
          <p>Each batch groups 10 consecutive threads. Every measured thread counts equally. Unclear time is excluded.</p>
          <table aria-label="Agent work share by thread range">
            <thead><tr><th scope="col">Threads</th><th scope="col">Agent work</th><th scope="col">Measured</th></tr></thead>
            <tbody>{data.map(batch => <tr key={batch.first}>
              <th scope="row">{label(batch)}</th>
              <td>{batch.measured > 0 ? `${(batch.basis_points / 100).toFixed(1)}%` : "Unknown"}</td>
              <td>{batch.measured} of 10</td>
            </tr>)}</tbody>
          </table>
        </CollapsiblePanel>
      </>}
    </Collapsible>
  </section>;
}
