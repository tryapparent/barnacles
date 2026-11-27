import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent,
  type PointerEvent, type ReactNode } from "react";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger, Tip, TooltipProvider } from "../controls";
import { changeValues, sessionEventList, sessionPath, useTimelineRows, utcRange,
  type HistoryEntry, type TimelinePolicy, type TimelineRow as Row, type UtcRange } from "../api";
import "./session-timeline.css";

const modules = import.meta.glob<TimelinePolicy>("./session-timeline.bend", { eager: true, import: "default" });
const policy = modules["./session-timeline.bend"];

type Brush = { area: "chart" | "minimap"; range: UtcRange };
type Gesture = { id: number; x: number; rect: DOMRect; range: UtcRange; start: UtcRange;
  area: Brush["area"] | "ruler"; active: boolean };
const day = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "short", day: "numeric" });
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
const preciseClock = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const elapsed = (range: UtcRange) => range.end - range.start;
const extent = ({ thread, end }: HistoryEntry) => utcRange(thread.start, thread.start + end);
const fraction = (x: number, rect: DOMRect) => Math.max(0, Math.min(1, (x - rect.left) / rect.width));
const at = (range: UtcRange, f: number) => Math.round(range.start + elapsed(range) * f);
const percentage = (value: number, range: UtcRange) => (value - range.start) / elapsed(range) * 100 + "%";
const rangeStyle = (span: UtcRange, range: UtcRange) => ({
  insetInlineStart: percentage(span.start, range), inlineSize: elapsed(span) / elapsed(range) * 100 + "%",
});

function useTimelineView(full: UtcRange) {
  const [range, setRange] = useState(full);
  const [selected, setSelected] = useState<string | null>(null);
  const current = useRef(full);
  const animation = useRef(0);
  const stop = () => cancelAnimationFrame(animation.current);
  function update(next: UtcRange) {
    current.current = next;
    setRange(next);
  }
  function show(next: UtcRange, animate = true, focus: string | null = null) {
    stop();
    setSelected(focus);
    const start = current.current;
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches ||
        (start.start === next.start && start.end === next.end)) {
      update(next);
      return;
    }
    const beginning = performance.now();
    function frame(now: number) {
      const progress = Math.min(1, (now - beginning) / 260);
      const eased = 1 - (1 - progress) ** 3;
      const interpolate = (a: number, b: number) => Math.round(a + (b - a) * eased);
      update(utcRange(interpolate(start.start, next.start), interpolate(start.end, next.end)));
      if (progress < 1) animation.current = requestAnimationFrame(frame);
    }
    animation.current = requestAnimationFrame(frame);
  }
  function move(start: number, duration: number, animate = false) {
    show(policy.chart_window(full, Math.max(0, Math.round(start)), Math.round(duration)), animate);
  }
  function zoom(factor: number, anchor = .5, animate = true) {
    const prior = current.current;
    const duration = policy.window_duration(Math.round(elapsed(prior) * factor), elapsed(full));
    move(prior.start + (elapsed(prior) - duration) * anchor, duration, animate);
  }
  useEffect(() => () => cancelAnimationFrame(animation.current), []);
  return { range, selected, current, stop, show, move, zoom };
}

function SessionLane({ row, range, width, details, selected, fit }: {
  row: Row; range: UtcRange; width: number; details: boolean; selected: boolean; fit: () => void;
}) {
  const { entry, evidence } = row;
  const span = extent(entry);
  const from = Math.max(0, range.start - span.start);
  const to = Math.max(0, range.end - span.start);
  const scale = elapsed(range);
  const visible = evidence && entry.end > 0 && policy.visible_row(span.start, span.end, range.start, range.end);
  const slices = visible ? changeValues(policy.draw_slices(evidence.phases, from, to, width, details, scale)) : [];
  const ticks = visible ? changeValues(policy.draw_failures(evidence.failures, from, to, width, scale, details)) : [];
  return <li className="timeline-row">
    <span className="timeline-title" title={entry.thread.title}>{entry.thread.title}</span>
    <div className="timeline-rail">
      {visible && <Button type="button" className="timeline-bar" variant="outline" aria-pressed={selected}
        style={rangeStyle(utcRange(Math.max(span.start, range.start), Math.min(span.end, range.end)), range)}
        aria-label={`Fit ${entry.thread.title} · ${day.format(span.start)} ${clock.format(span.start)} UTC`} onClick={fit} />}
      {slices.map((part) => <Tip key={part.a} label={part.name}>
        <span className="timeline-slice" style={{ ...rangeStyle(utcRange(span.start + part.a, span.start + part.b), range),
          background: part.paint, color: part.ink }} onClick={fit} aria-hidden="true">{part.inline}</span>
      </Tip>)}
      {ticks.map(({ at, failures }) => {
        const events = changeValues(failures).reverse();
        return <Tip key={at} label={<>
          <strong>{events.length === 1 ? "Recorded failure" : `${events.length} recorded failures`}</strong>
          <ul>{events.map((event) => <li key={event.index}>{preciseClock.format(span.start + event.at)} UTC · {event.label}</li>)}</ul>
        </>}>
          <span className="timeline-failure" style={{ insetInlineStart: percentage(span.start + at, range) }}
            onClick={fit} aria-hidden="true" />
        </Tip>;
      })}
      {!entry.end && <small>No timed span</small>}
      {!evidence && <small>Trace unavailable</small>}
    </div>
  </li>;
}

function TimelineChart({ rows }: { rows: Row[] }) {
  const full = useMemo(() => {
    const bounds = policy.exact_utc_frame(sessionEventList(rows.map(({ entry }) => extent(entry))), utcRange(0, 30000));
    return utcRange(bounds.start, Math.max(bounds.start + 30000, bounds.end));
  }, [rows]);
  const view = useTimelineView(full);
  const { range } = view;
  const [width, setWidth] = useState(400);
  const [brush, setBrush] = useState<Brush | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const minimap = useRef<HTMLDivElement>(null);
  const scale = elapsed(range);
  const details = policy.chart_details(scale, view.selected !== null);
  const selectedRow = rows.find((row) => row.entry.thread.id === view.selected);

  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.floor(entry.contentRect.width))));
    observer.observe(ruler.current!);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = viewport.current!;
    function wheel(event: WheelEvent) {
      const box = ruler.current!.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.width : 1;
      if (event.ctrlKey) {
        event.preventDefault();
        const delta = Math.max(-60, Math.min(60, event.deltaY * unit));
        if (delta) view.zoom(Math.exp(delta * .0025), fraction(event.clientX, box), false);
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const now = view.current.current;
        view.move(now.start + (event.deltaX || event.deltaY) * unit * elapsed(now) / box.width, elapsed(now));
      }
    }
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [view]);

  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.altKey || gesture.current?.active) return;
    if (event.ctrlKey) {
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      if (!event.repeat) view.zoom(event.key === "ArrowUp" ? .8 : 1.25);
    } else {
      switch (event.key) {
        case "ArrowLeft": case "ArrowRight":
          view.move(range.start + (event.key === "ArrowLeft" ? -scale : scale) / 5, scale);
          break;
        case "+": case "=": view.zoom(.8); break;
        case "-": view.zoom(1.25); break;
        case "Escape": case "Home": view.show(full); break;
        default: return;
      }
    }
    event.preventDefault();
  }

  function begin(event: PointerEvent<HTMLElement>, area: Gesture["area"]) {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = (area === "minimap" ? minimap : ruler).current!.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right) return;
    view.stop();
    suppressClick.current = false;
    const start = view.current.current;
    gesture.current = { id: event.pointerId, x: event.clientX, rect, area,
      range: area === "minimap" ? full : start, start, active: false };
  }

  function selection(g: Gesture, x: number) {
    const a = fraction(g.x, g.rect);
    const b = fraction(x, g.rect);
    if (!policy.ready_brush(Math.round(Math.abs(b - a) * g.rect.width))) return null;
    return policy.brush_window(g.range, at(g.range, Math.min(a, b)), at(g.range, Math.max(a, b)), elapsed(g.start));
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId || !g.active && Math.abs(g.x - event.clientX) < 6) return;
    if (!g.active) {
      g.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (g.area === "ruler") {
      view.move(g.start.start + (g.x - event.clientX) * elapsed(g.start) / g.rect.width, elapsed(g.start));
    } else {
      const target = selection(g, event.clientX);
      setBrush(target && { area: g.area, range: target });
    }
  }

  function cancel() {
    gesture.current = null;
    setBrush(null);
  }
  function release(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    if (g.active) {
      suppressClick.current = true;
      const target = g.area !== "ruler" && selection(g, event.clientX);
      if (target) view.show(target);
    } else if (g.area === "minimap") {
      view.move(at(full, fraction(event.clientX, g.rect)) - scale / 2, scale, true);
    }
    cancel();
  }

  function fit(row: Row) {
    if (!viewport.current?.contains(document.activeElement)) viewport.current?.focus({ preventScroll: true });
    view.show(extent(row.entry), true, row.entry.thread.id);
  }

  const ticks = changeValues(policy.chart_ticks(range, scale, width))
    .filter((time) => (time - range.start) * width / scale >= 25 && (range.end - time) * width / scale >= 25);
  const tickClock = scale < 300000 ? preciseClock : clock;
  return <TooltipProvider delayDuration={0} disableHoverableContent>
    <figure className="thread-timeline" aria-label="Thread timelines">
      <div onPointerMove={drag} onPointerUp={release} onPointerCancel={cancel} onLostPointerCapture={cancel}
        onPointerLeave={() => { if (!gesture.current?.active) cancel(); }}
        onClickCapture={(event) => {
          if (suppressClick.current && event.detail) {
            suppressClick.current = false;
            event.stopPropagation();
          }
        }}>
        <div className="timeline-mini" ref={minimap} onPointerDown={(event) => begin(event, "minimap")} aria-hidden="true">
          {rows.map(({ entry }, index) => <i key={entry.thread.id} style={{ ...rangeStyle(extent(entry), full), top: 3 + index * 2.6 }} />)}
          <span className="timeline-mini-window" style={rangeStyle(range, full)} />
          {brush?.area === "minimap" && <span className="timeline-brush" style={rangeStyle(brush.range, full)} />}
        </div>
        <ul className="timeline-key" aria-label="Timeline key">
          <li data-kind="tool">Tool activity</li><li data-kind="wait">Workflows or waits</li>
          <li data-kind="unclear">Unclear (blended)</li><li data-kind="failure" style={{ visibility: details ? "visible" : "hidden" }}>Failure</li>
        </ul>
        <div className="timeline-frame">
          <div className="timeline-view" ref={viewport} role="region" aria-label="Scrollable UTC timelines" tabIndex={0}
            aria-keyshortcuts="Control+ArrowUp Control+ArrowDown ArrowLeft ArrowRight Home Escape" onKeyDown={key}
            data-start={range.start} data-end={range.end}>
            <div className="timeline-head">
              <span>Thread</span>
              <div className="timeline-ruler" ref={ruler} onPointerDown={(event) => begin(event, "ruler")}>
                <span>UTC</span>
                <div className="timeline-ticks">{(ticks.length ? ticks : [Math.round((range.start + range.end) / 2)]).map((time) =>
                  <span key={time} style={{ left: percentage(time, range) }}>{day.format(time)}<b>{tickClock.format(time)}</b></span>)}</div>
              </div>
            </div>
            <ol className="timeline-rows" onPointerDown={(event) => begin(event, "chart")}>
              {rows.map((row) => <SessionLane key={row.entry.thread.id} row={row} range={range} width={width} details={details}
                selected={view.selected === row.entry.thread.id} fit={() => fit(row)} />)}
            </ol>
          </div>
          {brush?.area === "chart" && <div className="timeline-overlay" style={{ width }}><span className="timeline-brush" style={rangeStyle(brush.range, range)} /></div>}
        </div>
      </div>
      <div className="timeline-footer">
        <details><summary>How to use the timeline</summary>
          <p>Drag across the chart or minimap to zoom. Drag the UTC ruler to pan. Select a bar to fit that thread.</p>
          <p>Ctrl+scroll or Ctrl+↑/↓ zooms. ← and → pan. Esc fits all threads. Hover over a phase or red mark for details.</p>
          <p>Green shows recorded tool activity. Brown shows workflows or waits, which can overlap other activity. Unclear time blends with its neighbors.</p>
        </details>
        {selectedRow && <Button asChild variant="outline"><a href={sessionPath(selectedRow.entry.thread.id)}>Open trace waterfall</a></Button>}
      </div>
    </figure>
  </TooltipProvider>;
}

function SessionTimeline({ sessions }: { sessions: HistoryEntry[] }) {
  const { rows, retry } = useTimelineRows(sessions, policy);
  return rows ? <>
    <TimelineChart rows={rows} />
    {rows.some((row) => !row.evidence) && <div className="trace-message" role="status">
      <p>Some timing records could not be loaded.</p>
      <Button variant="outline" onClick={retry}>Retry traces</Button>
    </div>}
  </> : <p className="trace-message" role="status">Loading thread timelines…</p>;
}

export function SessionViews({ sessions, waterfall }: { sessions: HistoryEntry[]; waterfall: ReactNode }) {
  return <Tabs defaultValue={new URLSearchParams(location.search).has("session") ? "waterfall" : "timeline"}>
    <TabsList aria-label="Session views">
      <TabsTrigger value="timeline">Timeline</TabsTrigger>
      <TabsTrigger value="waterfall">Trace waterfall</TabsTrigger>
    </TabsList>
    <TabsContent value="timeline"><SessionTimeline sessions={sessions} /></TabsContent>
    <TabsContent value="waterfall">{waterfall}</TabsContent>
  </Tabs>;
}
