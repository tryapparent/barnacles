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
    return { curve, fill: `${curve} V112 H${first.x} Z`, first, length: points.length };
  });
}

export function AgentWorkTrend() {
  const data = useSyncExternalStore(subscribe, () => batches);
  const id = useId();
  const first = data[0];
  const last = data[data.length - 1];
  const paths = segmentPaths(data);
  const label = (batch: Batch) => `${batch.first}–${batch.last}`;
  return <section className="agent-work-trend" aria-labelledby={id}>
    <h2 id={id}>Agent work share</h2>
    <Collapsible className="trend-disclosure">
      <div className="trend-plot">
      {first && paths.length > 0 ? <svg viewBox="0 0 400 145" role="img" aria-label="Agent work share by batch. Exact values are in Batch data.">
        <defs>
          <linearGradient id={`${id}-cream`} x1="0" x2="0" y1="0" y2="1">
            <stop stopColor="var(--cream)" stopOpacity=".38" /><stop offset=".65" stopColor="var(--cream)" /><stop offset="1" stopColor="var(--cream)" />
          </linearGradient>
          <pattern id={`${id}-etch`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(32)">
            <path d="M0 0v5" stroke="var(--meadow)" strokeOpacity=".69" strokeWidth="1.1" />
          </pattern>
        </defs>
        {paths.filter(path => path.length > 1).map(({ fill, first }) => <g key={first.x}>
          <path d={fill} fill={`url(#${id}-cream)`} /><path d={fill} fill={`url(#${id}-etch)`} />
        </g>)}
        {[100, 50, 0].map(value => <g key={value}>
          <path d={`M48 ${112 - value}H389`} stroke="currentColor" strokeOpacity=".21" />
          <text x="43" y={116 - value} textAnchor="end">{value}%</text>
        </g>)}
        {paths.map(({ curve, first, length }) => <path key={first.x}
          d={length === 1 ? `M${first.x - 4},${first.y}h8` : curve}
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />)}
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
