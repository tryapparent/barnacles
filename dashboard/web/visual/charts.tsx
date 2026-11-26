import { useEffect, useRef, useState, type CSSProperties } from "react";
import { countLabel, dayLabel, duration, pagePath, stages, type DeliveryDay, type Review, type Operation, type Week } from "../api";

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

function Operations({ operations }: { operations: Review["operations"] }) {
  const items = operations.items;
  const measured = items.flatMap((item) => item.hasArea && item.totalSeconds ?
    [{ item, weight: item.totalSeconds, index: operations.operationOptions.indexOf(item.operation) }] : []);
  const tiles = layout(measured, { x: 0, y: 0, w: 100, h: 100 });
  return <section className="panel time" aria-labelledby="operations-title">
    <h2 id="operations-title">Where time went</h2>
    {tiles.length ? <div className="operation-map" aria-hidden="true">{tiles.map(({ item, index, x, y, w, h }) =>
      <div key={item.operation} className="operation-tile" title={`${item.operation} · ${duration(item.totalSeconds)}`}
        style={{ left: x + "%", top: y + "%", width: w + "%", height: h + "%", "--tile": inks[index % inks.length] } as CSSProperties}>
        <DelayedBursts />
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

export function StageKey() {
  return <ul className="stage-key" aria-label="Delivery stages">{stages.map(([key, label, color]) =>
    <li key={key} className={`stage-${color}`}>{label}</li>)}</ul>;
}

const dayMillis = 86_400_000;
const fullDayLabel = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", dateStyle: "long" });

function DailyValues({ day }: { day: DeliveryDay }) {
  return <table className="daily-values">
    <caption>{dayLabel(day.startsAt)} · {countLabel(day.verified)} verified</caption>
    <thead><tr><th scope="col">Stage</th><th scope="col">Mean</th><th scope="col">Measured</th></tr></thead>
    <tbody>{stages.map(([phase, label, color]) => {
      const sample = day.stages.find((stage) => stage.phase === phase);
      return <tr key={phase}><th scope="row" className={`stage-${color}`}>{label}</th>
        <td>{duration(sample?.meanSeconds ?? null)}</td>
        <td>{countLabel(sample?.measured ?? 0)} / {countLabel(day.verified)}</td></tr>;
    })}</tbody>
  </table>;
}

function DailyColumns({ days, window }: { days: DeliveryDay[]; window: Review["window"] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const first = Date.parse(window.from.slice(0, 10));
  const last = Date.parse(window.to.slice(0, 10));
  const count = (last - first) / dayMillis + 1;
  const stacks = days.map((day) => ({
    day, height: day.stages.reduce((total, stage) => total + (stage.meanSeconds ?? 0), 0),
  }));
  const byDate = new Map(stacks.map((stack) => [stack.day.startsAt, stack]));
  const detail = selected === null ? undefined : byDate.get(selected)?.day;
  const longest = Math.max(...stacks.map(({ height }) => height));
  const step = longest >= 3600 ? 1800 : longest >= 60 ? 30 : 1;
  const scale = Math.max(2, Math.ceil(longest / (2 * step))) * 2 * step;
  return <>
    <p className="fine daily-intro">Publication day (UTC). Gaps have no verified shipments in this window.
      Select a column for stage means and counts.</p>
    <StageKey />
    <div className="daily-figure">
      <div className="daily-axis" aria-hidden="true">
        <span>{duration(scale)}</span><span>{duration(scale / 2)}</span><span>0 s</span>
      </div>
      <div className="daily-scroll" role="region" aria-label="Daily duration columns" tabIndex={0}>
        <div className="daily-columns" data-dense={count > 5} style={{ "--daily-count": count } as CSSProperties}>
          {Array.from({ length: count }, (_, index) => {
            const timestamp = first + index * dayMillis;
            const date = new Date(timestamp).toISOString();
            const stack = byDate.get(date);
            const pressed = selected === date;
            const label = fullDayLabel.format(timestamp);
            const tick = count <= 5 || index === count - 1 || (index % 5 === 0 && index < count - 3);
            return <div key={date} className="daily-slot">
              {stack ? <button type="button" className="daily-column" aria-pressed={pressed}
                aria-label={`${label}, ${countLabel(stack.day.verified)} verified`} aria-controls="daily-stage-values"
                title={`${label} · ${countLabel(stack.day.verified)} verified`}
                onClick={() => setSelected(pressed ? null : date)}>
                {stack.height > 0 ? <span className="daily-stack" aria-hidden="true"
                  style={{ height: `${100 * stack.height / scale}%` }}>
                  {stages.map(([phase, name, color]) => {
                    const mean = stack.day.stages.find((stage) => stage.phase === phase)?.meanSeconds;
                    return mean ? <span key={phase} className={`daily-segment stage-${color}`}
                      style={{ height: `${100 * mean / stack.height}%` }} title={`${name} · ${duration(mean)}`} /> : null;
                  })}
                </span> : <span className="daily-zero" aria-hidden="true"
                  title={stack.day.stages.some(({ meanSeconds }) => meanSeconds === 0) ? "0 s measured" : "Stage times unknown"} />}
              </button> : <span className="daily-gap" title={`${label} · No verified shipments`} />}
              {tick && <time className="daily-tick" dateTime={date} aria-hidden="true">{dayLabel(date)}</time>}
            </div>;
          })}
        </div>
      </div>
    </div>
    <div id="daily-stage-values">{detail && <DailyValues day={detail} />}</div>
  </>;
}

export function DailyStages({ days, window }: { days: DeliveryDay[] | undefined; window: Review["window"] }) {
  return <section className="delivery daily-chart" aria-labelledby="daily-title">
    <h2 id="daily-title">Mean delivery stages by day</h2>
    {days === undefined ? <p className="fine">Daily stage data needs a refreshed evidence snapshot.</p> :
      days.length ? <DailyColumns days={days} window={window} /> :
        <p className="fine">No verified shipments in this review window.</p>}
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
