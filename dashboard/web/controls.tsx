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
