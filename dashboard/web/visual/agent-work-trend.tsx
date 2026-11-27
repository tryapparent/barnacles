import { useId, useSyncExternalStore } from "react";
import { Card } from "../controls";

type Bucket = { from: number; to: number; measured: number; basis_points: number };
type Point = { x: number; y: number };
let buckets: Bucket[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function renderAgentWorkTrend(next: Bucket[]) {
  buckets = next;
  listeners.forEach(listener => listener());
}

function segmentPaths(data: Bucket[]) {
  const segments: Point[][] = [];
  let current: Point[] = [];
  data.forEach((batch, index) => {
    if (!batch.measured) {
      current = [];
      return;
    }
    if (current.length === 0) segments.push(current);
    current.push({ x: 53 + (index + .5) * 329 / data.length, y: 112 - batch.basis_points / 100 });
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
  const data = useSyncExternalStore(subscribe, () => buckets);
  const id = useId();
  const first = data[0];
  const last = data[data.length - 1];
  const paths = segmentPaths(data);
  const field = paths.filter(path => path.length > 1);
  const endpoint = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const description = data.map(bucket =>
    `${endpoint.format(bucket.from)}–${endpoint.format(bucket.to)} UTC: ${bucket.measured ? (bucket.basis_points / 100).toFixed(1) + "%" : "unknown"}`
  ).join(". ");
  return <Card className="agent-work-trend" aria-labelledby={id} aria-describedby="overview-period">
    <h2 id={id}>Agent work share</h2>
      <div className="trend-plot">
      {first && paths.length > 0 ? <svg viewBox="0 0 400 145" role="img" aria-label={description}>
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
        <text x="51" y="134">{endpoint.format(first.from)} UTC</text>
        <text x="389" y="134" textAnchor="end">{endpoint.format(last.to)} UTC</text>
      </svg> : <p className="agent-work-empty">No measured provider or admission time in this range.</p>}
      </div>
  </Card>;
}
