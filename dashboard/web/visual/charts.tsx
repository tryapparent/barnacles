import type { CSSProperties } from "react";
import { countLabel, dayLabel, duration, pagePath, type Review, type Operation, type Week } from "../api";

function sector(inner: number, outer: number, from: number, to: number) {
  function point(radius: number, degrees: number) {
    const angle = degrees * Math.PI / 180;
    return `${(120 + radius * Math.sin(angle)).toFixed(2)} ${(117 - radius * Math.cos(angle)).toFixed(2)}`;
  }
  return `M${point(outer, from)} A${outer} ${outer} 0 0 1 ${point(outer, to)} L${point(inner, to)}
    A${inner} ${inner} 0 0 0 ${point(inner, from)} Z`;
}

function Gauge({ comparison }: { comparison: Review["cycleComparison"] }) {
  const { deltaSeconds, prior, recent } = comparison;
  const bound = Math.max(20, Math.ceil(Math.abs(deltaSeconds ?? 0) / 3600 / 10) * 10);
  const amount = Math.abs(deltaSeconds ?? 0) / (bound * 3600);
  const negative = comparison.direction === "Gardening";
  const signed = deltaSeconds === null ? "Unknown" :
    deltaSeconds === 0 ? "0 s" : (deltaSeconds > 0 ? "+" : "−") + duration(deltaSeconds);
  const segmentCount = 15;
  const blocks = Array.from({ length: segmentCount }, (_, index) => {
    const start = index * 6 + .65;
    const end = start + 4.7;
    const filled = amount * segmentCount - index;
    const extent = start + Math.min(1, Math.max(0, filled)) * 4.7;
    const tone = index < 5 ? "neutral" : index < 10 ? "mid" : "edge";
    return <g key={index}>
      <path className={`track gardening ${tone}`} d={sector(90, 111, -end, -start)} />
      <path className={`track shipping ${tone}`} d={sector(90, 111, start, end)} />
      {filled > 0 && <path className="segment" fill={filled > 1 ? "url(#gauge-dots)" : "currentColor"}
        d={negative ? sector(90, 111, -extent, -start) : sector(90, 111, start, extent)} />}
    </g>;
  });
  return <section className="panel cycle" aria-labelledby="cycle-title">
    <h2 id="cycle-title">Thread to release</h2>
    <div className="gauge" data-direction={deltaSeconds === null ? "unknown" : deltaSeconds === 0 ? "steady" :
      negative ? "gardening" : "shipping"}>
      <svg viewBox="0 0 240 126" aria-hidden="true">
        <defs><pattern id="gauge-dots" width="5" height="5" patternUnits="userSpaceOnUse">
          <rect width="5" height="5" fill="currentColor" /><rect width="2" height="2" fill="var(--surface)" />
        </pattern></defs>
        {blocks}<path className="center-tick" d="M120 2v24" />
      </svg>
      <span className="readout">{signed}</span>
      <div className="scale" aria-hidden="true">
        <span>+{bound} h</span><span>0</span><span>−{bound} h</span>
        <span>Gardening</span><span /><span>Shipping</span>
      </div>
    </div>
    {deltaSeconds !== null && <dl className="comparison">{[prior, recent].map((week) => <div key={week.startsAt}>
      <dt>Week of {dayLabel(week.startsAt)}</dt>
      <dd>{duration(week.meanSeconds)} <span>· {countLabel(week.attributedShipments)} measured</span></dd>
    </div>)}</dl>}
  </section>;
}

type Rectangle = { x: number; y: number; w: number; h: number };
type Tile = Rectangle & { item: Operation; index: number };

function layout(items: Array<{ item: Operation; weight: number; index: number }>, bounds: Rectangle): Tile[] {
  if (!items.length) return [];
  if (items.length === 1) return [{ ...bounds, ...items[0] }];
  const total = items.reduce((value, next) => value + next.weight, 0);
  let split = 1;
  let allocated = items[0].weight;
  while (split < items.length - 1 && allocated + items[split].weight / 2 < total / 2) {
    allocated += items[split++].weight;
  }
  const ratio = allocated / total;
  const { x, y, w, h } = bounds;
  if (w * 2.1 > h) {
    return [...layout(items.slice(0, split), { x, y, w: w * ratio, h }),
      ...layout(items.slice(split), { x: x + w * ratio, y, w: w * (1 - ratio), h })];
  }
  return [...layout(items.slice(0, split), { x, y, w, h: h * ratio }),
    ...layout(items.slice(split), { x, y: y + h * ratio, w, h: h * (1 - ratio) })];
}

const inks = ["var(--red)", "var(--amber)", "var(--green)", "var(--ink)", "#9bc7ff", "#bb9de8"];

function Operations({ operations }: { operations: Review["operations"] }) {
  const items = operations.items;
  const measured = items.flatMap((item) => item.hasArea && item.totalSeconds ?
    [{ item, weight: item.totalSeconds, index: operations.operationOptions.indexOf(item.operation) }] : []);
  const tiles = layout(measured, { x: 0, y: 0, w: 100, h: 100 });
  return <section className="panel time" aria-labelledby="operations-title">
    <h2 id="operations-title">Where time went</h2>
    {tiles.length ? <div className="operation-map" aria-hidden="true">{tiles.map(({ item, index, x, y, w, h }) =>
      <div key={item.operation} className="operation-tile" title={`${item.operation} · ${duration(item.totalSeconds)}`}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const tile = event.currentTarget;
          const bounds = tile.getBoundingClientRect();
          tile.style.setProperty("--cursor-x", `${event.clientX - bounds.left}px`);
          tile.style.setProperty("--cursor-y", `${event.clientY - bounds.top}px`);
        }} onPointerLeave={({ currentTarget }) => {
          currentTarget.style.removeProperty("--cursor-x");
          currentTarget.style.removeProperty("--cursor-y");
        }}
        style={{ left: x + "%", top: y + "%", width: w + "%", height: h + "%", "--tile": inks[index % inks.length] } as CSSProperties}>
        {w > 15 && h > 14 && <div className="operation-label"><span>{item.operation}</span>
          <span>{duration(item.totalSeconds)}</span></div>}
      </div>)}</div> : <p className="empty-chart">No measured time for this selection.</p>}
    {!!items.length && <details className="chart-details">
      <summary>Recorded operations</summary>
      <p className="fine">{operations.clock} · {operations.window} · Durations can overlap</p>
      <div className="table-scroll"><table><caption className="sr-only">Recorded operations</caption>
        <thead><tr><th scope="col">Operation</th><th scope="col">Total</th><th scope="col">Measured</th><th scope="col">Untimed</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.operation}>
          <th scope="row"><a href={pagePath({ operation: item.operation, offset: null })}>{item.operation}</a></th>
          <td>{duration(item.totalSeconds)}</td><td>{countLabel(item.measuredSpans)}</td><td>{countLabel(item.unmeasuredSpans)}</td>
        </tr>)}</tbody>
      </table></div>
    </details>}
  </section>;
}

function Weekly({ weeks }: { weeks: Week[] }) {
  const start = Date.parse(weeks[0]?.startsAt ?? "");
  const end = Date.parse(weeks.at(-1)?.startsAt ?? "");
  const highest = Math.max(2, ...weeks.map((week) => week.verified));
  const points = weeks.map((week) => ({ ...week, time: Date.parse(week.startsAt),
    x: start === end ? 50 : 7 + 86 * (Date.parse(week.startsAt) - start) / (end - start),
    y: 100 - 100 * week.verified / highest }));
  const groups: Array<typeof points> = [];
  for (const point of points) {
    const last = groups.at(-1)?.at(-1);
    if (!last || point.time - last.time !== 7 * 86400_000) groups.push([]);
    groups.at(-1)!.push(point);
  }
  return <figure className="panel history" aria-labelledby="history-title">
    <figcaption id="history-title">Weekly shipments</figcaption>
    {points.length ? <>
      <div className="history-chart" aria-hidden="true">
        <div className="plot-axis"><span>{highest}</span><span>{Math.round(highest / 2)}</span><span>0</span></div>
        <div className="plot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs><pattern id="shipment-dots" width="2" height="4" patternUnits="userSpaceOnUse">
              <rect width="1" height="2" fill="var(--green)" />
              <rect x="1" y="2" width="1" height="2" fill="var(--green)" />
            </pattern></defs>
            <path className="grid-lines" d="M0 0H100 M0 50H100 M0 100H100" />
            {groups.filter((group) => group.length > 1).map((group) => {
              const path = group.map(({ x, y }) => `${x} ${y}`).join(" L");
              return <g key={group[0].startsAt}><path fill="url(#shipment-dots)"
                d={`M${group[0].x} 100 L${path} L${group.at(-1)!.x} 100Z`} />
                <path className="plot-line" d={"M" + path} /></g>;
            })}
          </svg>
          <ol className="weeks">{points.map((point, index) =>
            <li key={point.startsAt} className={`week${index === points.length - 1 ? " current" : ""}`}
              style={{ "--x": point.x + "%", "--y": point.y + "%" } as CSSProperties}>
              {(points.length <= 5 || index === 0 || index === points.length - 1) &&
                <><time dateTime={point.startsAt}>{dayLabel(point.startsAt)}</time><span className="value">{point.verified}</span></>}
            </li>)}</ol>
        </div>
      </div>
      <ul className="sr-only" aria-label="Weekly shipments by date">
        {weeks.map((week) => <li key={week.startsAt}><time dateTime={week.startsAt}>{dayLabel(week.startsAt)}</time>
          <span>{countLabel(week.verified)} verified · {countLabel(week.attributed)} attributed</span></li>)}
      </ul>
    </> : <p className="empty-chart">No verified shipments in this window.</p>}
  </figure>;
}

export function Overview({ review }: { review: Review }) {
  return <div className="board">
    <Gauge comparison={review.cycleComparison} />
    <Operations operations={review.operations} />
    <section className="panel shipped" aria-labelledby="ship-title">
      <h2 id="ship-title">Shipped to users</h2>
      <p className="shipped-count">{countLabel(review.shipments.verified)}</p>
    </section>
    <Weekly weeks={review.shipments.weekly} />
  </div>;
}
