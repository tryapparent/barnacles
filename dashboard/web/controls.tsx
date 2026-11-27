import type { ComponentProps } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Slider, SliderControl, SliderThumb, SliderTrack } from "@ui-sdk/react/slider";
import { createTooltipController, Tooltip, TooltipContent } from "@ui-sdk/react/tooltip";

const buttonVariants = cva("control-button", {
  variants: { variant: { default: "control-primary", outline: "control-outline" } },
  defaultVariants: { variant: "default" },
});

export function Button({ className, variant, asChild = false, ...props }:
  ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Control = asChild ? Slot : "button";
  return <Control data-slot="button" data-variant={variant} className={buttonVariants({ variant, className })} {...props} />;
}

export function Badge({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="badge" className={className} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="card" className={className} {...props} />;
}

type TimelineAction = { host: HTMLElement; label: string; fit: () => void; visible: boolean };
type TimelineRange = {
  host: HTMLElement;
  max: number;
  value: [number, number];
  format: (value: number) => string;
  resize: (index: number, value: number) => void;
};
type TimelineTip = { label: string; times: string[] };

const timelineTooltip = createTooltipController<TimelineTip>();
let timelineControls: ReturnType<typeof createRoot> | undefined;

export function renderTimelineControls(actions: TimelineAction[], range: TimelineRange) {
  timelineControls ??= createRoot(document.createDocumentFragment());
  flushSync(() => timelineControls!.render(<>
    {actions.map(({ host, label, fit, visible }, index) => createPortal(
      <Button className="fit-thread" variant="outline" type="button" aria-label={label}
        data-focus-part="fit" tabIndex={visible ? 0 : -1} onClick={fit} />,
      host, String(index),
    ))}
    {createPortal(
      <Slider min={0} max={range.max} value={range.value} minStepsBetweenThumbs={1} format={range.format}
        onValueChange={(value, details) => {
          if (details.thumb !== null) range.resize(details.thumb, value[details.thumb]);
        }}>
        <SliderControl>
          <SliderTrack>
            <SliderThumb className="mini-handle" index={0} aria-label="Visible range start" />
            <SliderThumb className="mini-handle" index={1} aria-label="Visible range end" />
          </SliderTrack>
        </SliderControl>
      </Slider>,
      range.host,
    )}
    <Tooltip controller={timelineTooltip} delay={0} container={document.body}>
      <TooltipContent<TimelineTip> className="timeline-tooltip" side="bottom" sideOffset={10}>
        {({ payload }) => payload && <>
          <strong>{payload.label}</strong>
          {payload.times.map((time, index) => <span key={index}>{time}</span>)}
        </>}
      </TooltipContent>
    </Tooltip>
  </>));
}

export function showTimelineTooltip(x: number, y: number, payload: TimelineTip) {
  void timelineTooltip.open({
    payload,
    anchor: { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) },
  });
}

export function hideTimelineTooltip() {
  timelineTooltip.close();
}

export const fieldPalettes = [
  { name: "Soil", color: "#543b2a", kind: "workflow" },
  { name: "Crops", color: "#91ad5f", kind: "agent" },
  { name: "Unobserved", color: "#dfbf89", kind: "unclear" },
];

export function FieldSettings() {
  return <details className="field-settings" id="field-settings" hidden
    onKeyDown={event => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }}>
    <summary>Field colors</summary>
    <div className="field-settings-controls">
      {fieldPalettes.map(({ name, color }) => <label key={name}>{name}<input type="color" defaultValue={color} /></label>)}
      <label>Wind<input type="checkbox" defaultChecked /></label>
    </div>
  </details>;
}

type ChartInput = {
  viewport: HTMLElement;
  ruler: HTMLElement;
  rows: HTMLElement;
  plot: () => { left: number; width: number };
  start: () => number;
  select: (first: number, last: number, distance: number) => void;
  pan: (fraction: number, start: number) => void;
  zoom: (factor: number, anchor: number) => void;
  reset: () => void;
  hover: (target: HTMLElement, event: PointerEvent) => void;
  dismissTip: () => void;
};

export function wireChartInput(input: ChartInput) {
  const { viewport, ruler, rows } = input;
  let drag: { pointer: number; x: number; left: number; width: number; start: number; pan: boolean; active: boolean } | undefined;
  let suppressClick = false;
  const fraction = (x: number, plot: { left: number; width: number }) =>
    Math.min(1, Math.max(0, (x - plot.left) / plot.width));

  viewport.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    suppressClick = false;
    const plot = input.plot();
    const pan = ruler.contains(event.target);
    if (!(pan || event.target.closest(".rail")) || event.clientX < plot.left || event.clientX >= plot.left + plot.width) return;
    drag = { ...plot, pointer: event.pointerId, x: event.clientX, start: input.start(), pan, active: false };
    input.dismissTip();
  });
  viewport.addEventListener("pointermove", event => {
    const target = event.target instanceof Element && event.target.closest<HTMLElement>(".fit-thread");
    if (target && event.pointerType !== "touch" && !event.buttons) input.hover(target, event);
    else input.dismissTip();
    if (!drag || drag.pointer !== event.pointerId) return;
    const distance = event.clientX - drag.x;
    if (!drag.active && Math.abs(distance) < 4) return;
    if (!drag.active) {
      viewport.setPointerCapture(event.pointerId);
      drag.active = true;
      suppressClick = true;
    }
    if (drag.pan) {
      input.pan(-distance / drag.width, drag.start);
      ruler.classList.add("panning");
      return;
    }
    const first = fraction(drag.x, drag), last = fraction(event.clientX, drag);
    const offset = drag.left - rows.getBoundingClientRect().left;
    rows.style.setProperty("--brush-left", (offset + Math.min(first, last) * drag.width) + "px");
    rows.style.setProperty("--brush-width", Math.abs(first - last) * drag.width + "px");
    rows.dataset.brushing = "";
  });
  function clear() {
    drag = undefined;
    delete rows.dataset.brushing;
    ruler.classList.remove("panning");
  }
  viewport.addEventListener("pointerup", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (drag.active && !drag.pan) {
      const first = fraction(drag.x, drag), last = fraction(event.clientX, drag);
      input.select(Math.min(first, last), Math.max(first, last), Math.abs(last - first) * drag.width);
    }
    clear();
  });
  viewport.addEventListener("pointerleave", () => { if (!drag?.active) clear(); });
  viewport.addEventListener("pointerleave", input.dismissTip);
  document.addEventListener("scroll", input.dismissTip);
  viewport.addEventListener("pointercancel", clear);
  viewport.addEventListener("lostpointercapture", clear);
  viewport.addEventListener("click", event => {
    if (suppressClick && event.detail > 0) event.stopPropagation();
  }, true);

  viewport.addEventListener("wheel", event => {
    const plot = input.plot();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? plot.width : 1;
    if (event.ctrlKey) {
      event.preventDefault();
      const delta = Math.max(-60, Math.min(60, event.deltaY * unit));
      if (delta) input.zoom(Math.exp(delta * .0025), fraction(event.clientX, plot));
    } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      event.preventDefault();
      input.pan((event.deltaX || event.deltaY) * unit / plot.width, input.start());
    }
  }, { passive: false });
  viewport.addEventListener("keydown", event => {
    if (event.altKey || event.metaKey || drag?.active) return;
    if (event.ctrlKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      input.zoom(event.key === "ArrowUp" ? .8 : 1.25, .5);
    } else if (!event.ctrlKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      input.pan(event.key === "ArrowLeft" ? -.1 : .1, input.start());
    } else if (!event.ctrlKey && event.key === "Home") {
      input.reset();
    } else return;
    event.preventDefault();
  });
}
