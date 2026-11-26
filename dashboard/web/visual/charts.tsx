import { useEffect, useRef, useState, type CSSProperties } from "react";
import { countLabel, dayLabel, duration, pagePath, stages, type DeliveryDay, type Review, type OperationTile, type Week } from "../api";

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
  const label = duration(deltaSeconds, true);
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
      <span className="readout" style={{ "--label-length": label.length } as CSSProperties}>{label}</span>
      <div className="scale" aria-hidden="true">
        <span>{duration(bound * 3600, true)}</span><span>{duration(0)}</span><span>{duration(-bound * 3600, true)}</span>
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
type Tile = Rectangle & { item: OperationTile };

function layout(items: Array<{ item: OperationTile; weight: number }>, bounds: Rectangle): Tile[] {
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

type Pulse = { x: number; y: number; at: number };
type Pixel = { x: number; y: number; delay: number };

function DelayedBursts() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const surface = canvas.current!;
    const tile = surface.parentElement!;
    const review = tile.closest("main");
    const ctx = surface.getContext("2d");
    const base = document.createElement("canvas");
    const background = base.getContext("2d");
    if (!ctx || !background) return;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const pitch = 3;
    const radius = 68;
    const lifetime = 620;
    const intensity = .2;
    let pixels: Array<Pixel | undefined> = [];
    let trace: Pulse[] = [];
    let last: Pulse | undefined;
    let columns = 0;
    let rows = 0;
    let frame = 0;

    const restore = () => {
      if (!surface.width || !surface.height) return;
      ctx.clearRect(0, 0, surface.width, surface.height);
      ctx.drawImage(base, 0, 0);
    };
    const resize = () => {
      const width = surface.width = base.width = surface.clientWidth;
      const height = surface.height = base.height = surface.clientHeight;
      columns = Math.ceil(width / pitch);
      rows = Math.ceil(height / pitch);
      pixels = new Array(columns * rows);
      ctx.fillStyle = background.fillStyle = getComputedStyle(tile).getPropertyValue("--surface").trim();
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
          const x = col * pitch;
          const y = row * pitch;
          const seed = (col * 29 + row * 71 + col * row * 13) % 61;
          const density = Math.max(.045, (x / width * .84 + y / height * .29 - .22) * 1.12);
          if (seed / 61 > density) continue;
          pixels[row * columns + col] = { x, y, delay: (seed % 4) * 38 };
          background.fillRect(x, y, 2, 2);
        }
      }
      trace = [];
      last = undefined;
      restore();
    };
    const paused = () => reduced.matches || review?.hasAttribute("data-motion-paused");
    const paint = (now: number) => {
      frame = 0;
      if (paused()) {
        trace = [];
        last = undefined;
        restore();
        return;
      }
      trace = trace.filter((pulse) => now - pulse.at < lifetime);
      const displaced = new Map<Pixel, { x: number; y: number; strength: number }>();

      for (const pulse of trace) {
        const lastRow = Math.min(rows - 1, Math.floor((pulse.y + radius) / pitch));
        const lastCol = Math.min(columns - 1, Math.floor((pulse.x + radius) / pitch));
        for (let row = Math.max(0, Math.floor((pulse.y - radius) / pitch)); row <= lastRow; row++) {
          for (let col = Math.max(0, Math.floor((pulse.x - radius) / pitch)); col <= lastCol; col++) {
            const pixel = pixels[row * columns + col];
            if (!pixel) continue;
            const age = now - pulse.at - pixel.delay;
            const x = pixel.x - pulse.x;
            const y = pixel.y - pulse.y;
            const distance = Math.hypot(x, y);
            if (age <= 0 || distance < 1 || distance >= radius) continue;
            const envelope = (1 - Math.exp(-age / 18)) * Math.exp(-age / 143);
            const amplitude = intensity * (1 - distance / radius) * Math.floor(envelope * 13);
            const dx = Math.round(x / distance * amplitude);
            const dy = Math.round(y / distance * amplitude);
            const strength = Math.max(Math.abs(dx), Math.abs(dy));
            if (strength > (displaced.get(pixel)?.strength ?? 0)) {
              displaced.set(pixel, { x: pixel.x + dx * pitch, y: pixel.y + dy * pitch, strength });
            }
          }
        }
      }
      restore();
      for (const pixel of displaced.keys()) ctx.clearRect(pixel.x, pixel.y, 2, 2);
      for (const pixel of displaced.values()) ctx.fillRect(pixel.x, pixel.y, 2, 2);
      if (trace.length) frame = requestAnimationFrame(paint);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || paused()) return;
      const bounds = surface.getBoundingClientRect();
      const pulse = { x: event.clientX - bounds.left, y: event.clientY - bounds.top, at: performance.now() };
      if (last && Math.hypot(pulse.x - last.x, pulse.y - last.y) < 9 && pulse.at - last.at < 55) return;
      trace.push(pulse);
      if (trace.length > 18) trace.shift();
      last = pulse;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const leave = () => { last = undefined; };
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    tile.addEventListener("pointermove", move);
    tile.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      tile.removeEventListener("pointermove", move);
      tile.removeEventListener("pointerleave", leave);
    };
  }, []);
  return <canvas className="operation-dither" ref={canvas} />;
}

function OperationMap({ items }: { items: OperationTile[] }) {
  const [path, setPath] = useState<OperationTile[]>([]);
  const [width, setWidth] = useState(0);
  const scope = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const current = path.at(-1);
  const level = current?.children ?? items;
  const tiles = layout(level.map((item) => ({ item, weight: item.totalSeconds })), { x: 0, y: 0, w: 100, h: 100 });
  const compact = ({ item, w, h }: Tile) => w * width / 100 < (item.grouped ? 58 : 66) || h < 20;
  const name = (item: OperationTile) => item.grouped ? `Other (${item.grouped})` : item.label;
  const describe = (item: OperationTile) => `${name(item)} · ${duration(item.totalSeconds)}`;
  const navigate = (next: OperationTile[]) => {
    moveFocus.current = true;
    setPath(next);
  };

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    if (scope.current) observer.observe(scope.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (moveFocus.current) {
      heading.current?.focus({ preventScroll: true });
      moveFocus.current = false;
    }
  }, [path]);

  return <>
    <div className="operation-scope" ref={scope}>
      <h3 ref={heading} tabIndex={-1}>{current ? name(current) : "All recorded time"}</h3>
      {current && <button type="button" onClick={() => navigate(path.slice(0, -1))}>
        ← {path.length > 1 ? name(path[path.length - 2]) : "All operations"}
      </button>}
    </div>
    <div className="operation-map" key={path.length}>{tiles.map((tile) => {
      const { item, x, y, w, h } = tile;
      const style = { left: x + "%", top: y + "%", width: w + "%", height: h + "%",
        "--tile": item.grouped ? "var(--operation-other)" : inks[item.index % inks.length] } as CSSProperties;
      const label = <><DelayedBursts />{!compact(tile) && <span className="operation-label">
        <span>{name(item)}</span><span>{duration(item.totalSeconds)}{item.children.length ? " ›" : ""}</span></span>}</>;
      const key = item.grouped ? "other" : "tile-" + item.label;
      return item.children.length && !compact(tile)
        ? <button key={key} type="button" className="operation-tile" aria-label={`Open ${describe(item)}`}
            title={describe(item)} style={style} onClick={() => navigate([...path, item])}>{label}</button>
        : <div key={key} className="operation-tile" title={describe(item)} style={style}
            aria-hidden={compact(tile) || undefined}>{label}</div>;
    })}</div>
    <ul className="operation-list">{tiles.map((tile) =>
      <li key={tile.item.grouped ? "other" : "tile-" + tile.item.label} data-compact={compact(tile)}>
        {tile.item.children.length
          ? <button type="button" onClick={() => navigate([...path, tile.item])}>{describe(tile.item)} ›</button>
          : describe(tile.item)}</li>)}</ul>
  </>;
}

function Operations({ operations }: { operations: Review["operations"] }) {
  const { items, map } = operations;
  return <section className="panel time" aria-labelledby="operations-title">
    <h2 id="operations-title">Where time went</h2>
    {map?.length ? <OperationMap key={JSON.stringify([operations.clock, operations.operation, map])} items={map} />
      : <p className="empty-chart">{map ? "No measured time for this selection." : "The time map needs a refreshed evidence snapshot."}</p>}
    {!!items.length && <details className="chart-details" open={map === undefined ? true : undefined}>
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

export function StageKey() {
  return <ul className="stage-key" aria-label="Delivery stages">{stages.map(([key, label, color]) =>
    <li key={key} className={`stage-${color}`}>{label}</li>)}</ul>;
}

export function DailyStages({ days }: { days: DeliveryDay[] | undefined }) {
  const longest = Math.max(0, ...(days ?? []).map(({ stages }) =>
    stages.reduce((total, stage) => total + (stage.meanSeconds ?? 0), 0)));
  const step = longest >= 3600 ? 1800 : longest >= 60 ? 30 : 1;
  const scale = Math.max(2, Math.ceil(longest / (2 * step))) * 2 * step;
  return <section className="delivery daily-chart" aria-labelledby="daily-title">
    <h2 id="daily-title">Mean delivery stages by day</h2>
    {days === undefined ? <p className="fine">Daily stage data needs a refreshed evidence snapshot.</p> :
      !days.length ? <p className="fine">No verified shipments in this review window.</p> : <>
        <p className="fine daily-intro">By publication day (UTC). Each stage averages the PRs with both clocks. Open a day for counts and times.</p>
        <StageKey />
        {longest > 0 && <div className="daily-axis" aria-hidden="true">
          <span>{duration(0)}</span><span>{duration(scale / 2)}</span><span>{duration(scale)}</span>
        </div>}
        {days.map((day) => <details key={day.startsAt} className="daily-row">
          <summary>
            <span className="daily-label"><time dateTime={day.startsAt}>{dayLabel(day.startsAt)}</time>
              <span>{countLabel(day.verified)} verified</span></span>
            <span className="daily-bar" aria-hidden="true">
              {day.stages.every(({ meanSeconds }) => meanSeconds === null) ? <span>Unknown</span> :
                day.stages.every(({ meanSeconds }) => !meanSeconds) ? <span>{duration(0)}</span> :
                  stages.map(([phase, label, color]) => {
                    const mean = day.stages.find((stage) => stage.phase === phase)?.meanSeconds;
                    return mean ? <span key={phase} className={`daily-segment stage-${color}`}
                      style={{ width: `${100 * mean / scale}%` }} title={`${label} · ${duration(mean)}`} /> : null;
                  })}
            </span>
          </summary>
          <table className="daily-values">
            <caption className="sr-only">Stage means for {dayLabel(day.startsAt)}</caption>
            <thead><tr><th scope="col">Stage</th><th scope="col">Mean</th><th scope="col">Measured</th></tr></thead>
            <tbody>{stages.map(([phase, label, color]) => {
              const sample = day.stages.find((stage) => stage.phase === phase);
              return <tr key={phase}><th scope="row" className={`stage-${color}`}>{label}</th>
                <td>{duration(sample?.meanSeconds ?? null)}</td>
                <td>{countLabel(sample?.measured ?? 0)} / {countLabel(day.verified)}</td></tr>;
            })}</tbody>
          </table>
        </details>)}
      </>}
  </section>;
}

export function Overview({ review }: { review: Review }) {
  return <div className="board">
    <Gauge comparison={review.cycleComparison} />
    <Operations operations={review.operations} />
    <section className="panel shipped" aria-labelledby="ship-title">
      <h2 id="ship-title">Shipped to users</h2>
      <p className="shipped-count">{countLabel(review.shipments.verified)}</p>
      <p className="fine">Verified PRs in the review window</p>
    </section>
    <Weekly weeks={review.shipments.weekly} />
  </div>;
}
