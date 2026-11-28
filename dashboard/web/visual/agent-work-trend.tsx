import { useId, useSyncExternalStore } from "react";
import { Card } from "../controls";

type Bucket = { from: number; to: number; measured: number; basis_points: number };
type Point = { x: number; y: number };
const plotLeft = 53;
const plotWidth = 329;
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
    current.push({ x: plotLeft + (index + .5) * plotWidth / data.length, y: 112 - batch.basis_points / 100 });
  });
  return segments.map(points => {
    const [first] = points;
    const halfBucket = plotWidth / data.length / 2;
    const left = first.x - halfBucket;
    const right = points[points.length - 1].x + halfBucket;
    const curve = points.slice(1).reduce((path, point, i) => {
      const previous = points[i];
      const dx = (point.x - previous.x) / 3;
      return path + ` C${previous.x + dx},${previous.y} ${point.x - dx},${point.y} ${point.x},${point.y}`;
    }, `M${left},${first.y} H${first.x}`) + ` H${right}`;
    return {
      curve,
      soil: `${curve} V12 H${left} Z`,
      canopy: `${curve} V112 H${left} Z`,
      left,
    };
  });
}

export function AgentWorkTrend() {
  const data = useSyncExternalStore(subscribe, () => buckets);
  const id = useId();
  const first = data[0];
  const last = data[data.length - 1];
  const paths = segmentPaths(data);
  const missing = data.flatMap((bucket, index) => bucket.measured ? [] : [index]);
  const endpoint = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const description = data.map(bucket =>
    `${endpoint.format(bucket.from)}–${endpoint.format(bucket.to)} UTC: ${bucket.measured ? (bucket.basis_points / 100).toFixed(1) + "%" : "no measured time"}`
  ).join(". ");
  return <Card className="agent-work-trend" aria-labelledby={id} aria-describedby="overview-period">
    <h2 id={id}>Agent work share</h2>
    {paths.length > 0 && missing.length > 0 && <span className="trend-gap-key" aria-hidden="true">No measured time</span>}
      <div className="trend-plot">
      {first && paths.length > 0 ? <svg viewBox="0 0 400 145" role="img" aria-label={description}>
        <defs>
          <pattern id={`${id}-gap`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="trend-gap-background" width="6" height="6" />
            <path className="trend-gap-hatch" d="M0 0v6" />
          </pattern>
          <clipPath id={`${id}-soil`}>
            {paths.map(({ soil, left }) => <path key={left} d={soil} />)}
          </clipPath>
          <clipPath id={`${id}-canopy`}>
            {paths.map(({ canopy, left }) => <path key={left} d={canopy} />)}
          </clipPath>
        </defs>
        {missing.map(index => <rect key={index} x={plotLeft + index * plotWidth / data.length} y="12"
          width={plotWidth / data.length} height="100" fill={`url(#${id}-gap)`} />)}
        {(["soil", "canopy"] as const).map(material =>
          <foreignObject className="trend-field" key={material} x={plotLeft} y="12" width={plotWidth} height="100"
            clipPath={`url(#${id}-${material})`}>
            <div className={`trend-material trend-${material}`} />
          </foreignObject>)}
        {[100, 50, 0].map(value =>
          <text key={value} x="43" y={116 - value} textAnchor="end">{value}%</text>)}
        {paths.map(({ curve, left }) => <path className="trend-series trend-field-outline" key={left}
          d={curve}
          fill="none" stroke="#3c5930" strokeWidth="2.2" strokeLinecap="round" />)}
        <text x="51" y="134">{endpoint.format(first.from)} UTC</text>
        <text x="389" y="134" textAnchor="end">{endpoint.format(last.to)} UTC</text>
      </svg> : <div className="agent-work-empty"><strong>No measured time</strong>
        <p>Plow recorded no provider runs or admission waits in this time frame.</p></div>}
      </div>
  </Card>;
}
