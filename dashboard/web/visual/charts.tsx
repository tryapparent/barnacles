import { useEffect, useRef, useState, type CSSProperties } from "react";
import { countLabel, dayLabel, duration, pagePath, stages, type DeliveryChart, type DeliveryDay, type Review, type OperationTile, type Operation } from "../api";

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

function OperationMap({ items, clock, unidentifiedWait }: { items: OperationTile[]; clock: string; unidentifiedWait?: Operation }) {
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
      <h3 ref={heading} tabIndex={-1}>{current ? path.map(name).join(" / ") : clock}</h3>
      {current && <button type="button" onClick={() => navigate(path.slice(0, -1))}>
        ← {path.length > 1 ? name(path[path.length - 2]) : "All operations"}
      </button>}
    </div>
    {path[0]?.label === "Waiting" && unidentifiedWait && <p className="fine wait-coverage">
      {countLabel(unidentifiedWait.measuredSpans)} measured waits · {countLabel(unidentifiedWait.unmeasuredSpans)} untimed.
      {" "}The source does not link these waits to a confirmed task.
    </p>}
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
  const { items } = operations;
  const map = operations.mapKind === "categories" ? operations.map : undefined;
  return <section className="panel time" aria-labelledby="operations-title">
    <h2 id="operations-title">Where time went</h2>
    {map?.length ? <OperationMap key={JSON.stringify([operations.clock, operations.operation, map])} items={map} clock={operations.clock}
      unidentifiedWait={items.find(({ operation }) => operation === "Waiting for an unidentified task")} />
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

const publicationStages = stages.filter(([phase]) => phase !== "access-verified");

export function StageKey({ includeAccessCheck = true }: { includeAccessCheck?: boolean }) {
  return <ul className="stage-key" aria-label="Delivery stages">{(includeAccessCheck ? stages : publicationStages).map(([key, label, color]) =>
    <li key={key} className={`stage-${color}`}>{label}</li>)}</ul>;
}

const fullDayLabel = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", dateStyle: "long" });

function DailyValues({ day }: { day: DeliveryDay }) {
  return <table className="daily-values">
    <caption>{dayLabel(day.startsAt)} · {countLabel(day.verified)} verified</caption>
    <thead><tr><th scope="col">Stage</th><th scope="col">Mean</th><th scope="col">Measured</th></tr></thead>
    <tbody>{stages.map(([phase, label, color]) => {
      const sample = day.stages.find((stage) => stage.phase === phase);
      return <tr key={phase}><th scope="row" className={`stage-${color}`}>{phase === "access-verified" ? "Publication to access check" : label}</th>
        <td>{duration(sample?.meanSeconds ?? null)}</td>
        <td>{countLabel(sample?.measured ?? 0)} / {countLabel(day.verified)}</td></tr>;
    })}</tbody>
  </table>;
}

function DailyColumns({ days }: { days: DeliveryDay[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const count = days.length;
  const stacks = [...days].reverse().map((day) => ({
    day, height: publicationStages.reduce((total, [phase]) => total +
      (day.stages.find((stage) => stage.phase === phase)?.meanSeconds ?? 0), 0),
  }));
  const detail = days.find((day) => day.startsAt === selected);
  const longest = Math.max(...stacks.map(({ height }) => height));
  const step = longest >= 3600 ? 1800 : 60;
  const scale = Math.max(1, Math.ceil(longest / (2 * step))) * 2 * step;
  return <>
    <StageKey includeAccessCheck={false} />
    <div className="daily-figure">
      <div className="daily-axis" aria-hidden="true">
        <span>{duration(scale)}</span><span>{duration(scale / 2)}</span><span>{duration(0)}</span>
      </div>
      <div className="daily-scroll" role="region" aria-label="Daily duration columns" tabIndex={0}>
        <div className="daily-columns" data-dense={count > 5} style={{ "--daily-count": count } as CSSProperties}>
          {stacks.map((stack, index) => {
            const date = stack.day.startsAt;
            const timestamp = Date.parse(date);
            const pressed = selected === date;
            const label = fullDayLabel.format(timestamp);
            const tick = count <= 5 || index === count - 1 || (index % 5 === 0 && index < count - 3);
            return <div key={date} className="daily-slot">
              <button type="button" className="daily-column" aria-pressed={pressed}
                aria-label={`${label}, ${countLabel(stack.day.verified)} verified`} aria-controls="daily-stage-values"
                title={`${label} · ${countLabel(stack.day.verified)} verified`}
                onClick={() => setSelected(pressed ? null : date)}>
                {stack.height > 0 ? <span className="daily-stack" aria-hidden="true"
                  style={{ height: `${100 * stack.height / scale}%` }}>
                  {publicationStages.map(([phase, name, color]) => {
                    const mean = stack.day.stages.find((stage) => stage.phase === phase)?.meanSeconds;
                    return mean ? <span key={phase} className={`daily-segment stage-${color}`}
                      style={{ height: `${100 * mean / stack.height}%` }} title={`${name} · ${duration(mean)}`} /> : null;
                  })}
                </span> : <span className="daily-zero" aria-hidden="true"
                  title={stack.day.stages.some(({ phase, meanSeconds }) => phase !== "access-verified" && meanSeconds === 0) ? `${duration(0)} measured` : "Stage times unknown"} />}
              </button>
              {tick && <time className="daily-tick" dateTime={date} aria-hidden="true">{dayLabel(date)}</time>}
            </div>;
          })}
        </div>
      </div>
    </div>
    <div id="daily-stage-values">{detail && <DailyValues day={detail} />}</div>
  </>;
}

export function DailyStages({ chart, window }: { chart: DeliveryChart | undefined; window: Review["window"] }) {
  const bounded = chart && chart.from !== window.from;
  return <section className="delivery daily-chart" aria-labelledby="daily-title">
    <h2 id="daily-title">Mean time to publication by stage</h2>
    {bounded && <p className="fine">Chart window · {dayLabel(chart.from)}–{dayLabel(window.to)} UTC</p>}
    {chart === undefined ? <p className="fine">Daily stage data needs a refreshed evidence snapshot.</p> :
      chart.days.length ? <>
        <p className="fine daily-intro">Verified shipments by publication day (UTC). Select a day for stage coverage and time to the access check.</p>
        <DailyColumns days={chart.days} />
      </> : <p className="fine">No verified shipments in this chart window.</p>}
  </section>;
}

export function Overview({ review }: { review: Review }) {
  const { meanCycleSeconds, attributed, verified } = review.shipments;
  return <div className="board">
    <section className="panel cycle" aria-labelledby="cycle-title">
      <h2 id="cycle-title">Average thread to publication</h2>
      {meanCycleSeconds === null || meanCycleSeconds === undefined
        ? <p className="cycle-empty">{attributed ? "Refresh the evidence snapshot to see the average." : "No measured deliveries in this window."}</p>
        : <p className="cycle-average">{duration(meanCycleSeconds)}</p>}
      <p className="fine">{countLabel(attributed)} of {countLabel(verified)} verified PRs measured in the review window</p>
      <p className="fine">From the linked thread’s start to release publication. Harbor verifies access separately.</p>
    </section>
    <Operations operations={review.operations} />
  </div>;
}
