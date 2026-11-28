import { createElement as h } from "react";
import { Button, Card } from "../../web/controls.tsx";
import { rect } from "./parcels.mjs";

export const control = (props, ...children) =>
  h(Button, { type: "button", ...props }, ...children);
const box = (r) => ({ left: r.x, top: r.y, width: r.w, height: r.h });
const label = (item) => item.name + " · " + item.value;
function parcelButton(choose, item, c, visible = true, props = {}) {
  return control(
    {
      key: item.key,
      className: c + " " + item.material,
      "data-target": item.key,
      "aria-label": label(item),
      style: box(item.r),
      onClick: () => choose(item.key),
      ...props,
    },
    visible &&
      h(
        "span",
        { className: "parcel-type" },
        h("span", { className: "category-name" }, item.name),
        h("strong", { className: "category-metric" }, item.value),
      ),
  );
}
function CategoryView({ b, selected, choose, height }) {
  const active =
    selected?.kind === "category"
      ? selected
      : selected?.kind === "operation"
        ? b.objects.get(selected.parent)
        : null;
  const scale = Math.min(1, height / (b.height * 0.93));
  const small = (d) => d.r.w * scale < 112 || d.r.h * scale * 0.93 < 42;
  return h(
    Card,
    { id: "summary-panel", "aria-labelledby": "summary-heading" },
    h(
      "h2",
      {
        id: "summary-heading",
        tabIndex: -1,
        style: { left: b.summary.x, top: b.summary.y - b.heading },
      },
      "Where time went",
    ),
    h(
      "div",
      { id: "tiles", className: "summary-tiles" },
      b.categories.map((item) =>
        parcelButton(choose, item, "category-tile", !!selected || !small(item), {
          "data-kind": item.category,
          "aria-expanded": active?.key === item.key,
          tabIndex: !selected && !small(item) ? 0 : -1,
        }),
      ),
    ),
    !selected &&
      b.categories.some(small) &&
      h(
        "div",
        {
          className: "path-labels",
          style: {
            left: b.summary.x,
            top: b.summary.y + b.summary.h + 3,
            width: b.summary.w,
          },
        },
        b.categories.filter(small).map((item) =>
          control(
            {
              key: item.key,
              "data-target": item.key,
              onClick: () => choose(item.key),
            },
            label(item),
          ),
        ),
      ),
    active &&
      h(
        "div",
        { className: "parcel-layer" },
        active.operations.map((item) =>
          parcelButton(
            choose,
            item,
            "parcel-button",
            true,
            {
              "aria-pressed": selected.key === item.key,
              "data-operation": item.name,
            },
          ),
        ),
      ),
  );
}
function TrendView({ b, selected, choose }) {
  const r = b.trend,
    z = b.trendZone;
  const toPath = (run) =>
    run.map(([x, y], i) => (i ? "L" : "M") + x + " " + y).join(" ");
  return h(
    Card,
    { className: "agent-work-trend", "aria-labelledby": "trend-heading" },
    h(
      "h2",
      {
        id: "trend-heading",
        tabIndex: -1,
        style: { left: z.x, top: z.y - b.heading },
      },
      "Agent work share",
    ),
    b.batches.length > 0 &&
      control(
        {
          id: "trend",
          className: "batch-trigger",
          "aria-label": "Batch values",
          title: "Inspect the agent work share along the field fence",
          "data-target": "trend",
          onClick: () => choose(b.batches[0].key),
          tabIndex: selected ? -1 : 0,
          style: { right: b.width - z.x - z.w, top: z.y - b.heading },
        },
        "Batch values",
      ),
    h(
      "div",
      { className: "trend-plot" },
      h(
        "svg",
        {
          width: b.width,
          height: b.height,
          "aria-label": "Agent work share across batches of ten threads",
          role: "img",
        },
        b.runs.map(
          (run, index) =>
            run.length > 1 &&
            h("path", {
              key: "soil" + index,
              className: "trend-soil",
              d:
                toPath(run) +
                " L" +
                run.at(-1)[0] +
                " " +
                r.y +
                " L" +
                run[0][0] +
                " " +
                r.y +
                " Z",
            }),
        ),
        b.runs.map(
          (run, index) =>
            run.length > 1 &&
            h("path", {
              key: "field" + index,
              className: "trend-ground",
              d:
                toPath(run) +
                " L" +
                run.at(-1)[0] +
                " " +
                (r.y + r.h) +
                " L" +
                run[0][0] +
                " " +
                (r.y + r.h) +
                " Z",
            }),
        ),
        b.runs.map((run, index) =>
          h("path", {
            className: "trend-series",
            key: index,
            d:
              run.length === 1
                ? "M" + (run[0][0] - 3) + " " + run[0][1] + "h6"
                : toPath(run),
          }),
        ),
        [0, 50, 100].map((n) =>
          h(
            "text",
            {
              key: n,
              x: r.x - 7,
              y: r.y + r.h * (1 - n / 100) + 4,
              textAnchor: "end",
            },
            n + "%",
          ),
        ),
        b.batches
          .filter((d, i, a) => i === 0 || i === a.length - 1)
          .map((d, i) =>
            h(
              "text",
              {
                key: d.key,
                x: i ? r.x + r.w : r.x,
                y: r.y + r.h + 20,
                textAnchor: i ? "end" : "start",
              },
              d.name,
            ),
          ),
      ),
    ),
    !b.runs.length &&
      h(
        "p",
        {
          className: "empty-trend",
          style: { left: r.x + 8, top: r.y + 8, width: r.w - 16 },
        },
        b.batches.length
          ? "No classified time in these batches."
          : "The trend starts after 10 threads.",
      ),
    b.batches.map((d) =>
      parcelButton(choose, d, "batch-parcel", false, {
        tabIndex: -1,
        "aria-pressed": selected?.key === d.key,
      }),
    ),
  );
}
function TimelineView({ b, selected, choose }) {
  const t = b.timeline,
    a = b.axis;
  return h(
    Card,
    { id: "timeline-panel", "aria-labelledby": "timeline" },
    h(
      "h2",
      { id: "timeline", tabIndex: -1, style: { left: t.x, top: t.y } },
      "Timeline",
      h("small", {className:"field-story", title:"Meadow lies outside each thread’s recorded time."}, "UTC"),
    ),
    h("div", {className:"axis utc",style:{left:a.x-47,top:a.y-32}}, "UTC"),
    b.ticks.map((tick) =>
      h(
        "span",
        {
          className: "tick",
          key: tick.x,
          style: {
            left: Math.min(tick.x, a.x + a.w - 31),
            top: a.y - 25,
          },
        },
        h("span", null, tick.name),
        tick.value,
      ),
    ),
    b.threads.map((thread) =>
      h(
        "div",
        {
          className: "trace",
          key: thread.key,
          "data-match":
            selected?.kind === "operation"
              ? selected.matches.includes(thread.index)
              : undefined,
        },
        control(
          {
            className: "inspectable",
            "aria-label": "Inspect " + label(thread),
            title: label(thread),
            "data-target": thread.key,
            tabIndex: selected ? -1 : 0,
            style: box(rect(t.x, thread.r.y, a.x - t.x, thread.r.h)),
            onClick: () => choose(thread.key),
          },
          h("strong", { className: "sample-title" }, thread.name),
          h("small", { className: "meta" }, thread.value),
        ),
        h("div", { className: "rail", style: box(thread.rail) }),
        thread.parts.map((p) =>
          h("i", {
            key: p.key,
            className: "field-span " + p.material,
            "aria-hidden": true,
            style: box(p.r),
          }),
        ),
        parcelButton(choose, thread, "fit-thread bar", false, {
          tabIndex: -1,
          style: box({ ...thread.r, w: Math.max(3, thread.r.w) }),
        }),
        (selected?.key === thread.key || selected?.parent === thread.key) &&
          thread.parts.map((d) =>
            parcelButton(choose, d, "phase-target", true, {
              "aria-pressed": selected?.key === d.key,
              title: label(d),
            }),
          ),
        thread.failures.map((d) =>
          control(
            {
              key: d.key,
              "data-target": d.key,
              "aria-label": label(d),
              className: "failure-point",
              tabIndex: selected ? -1 : 0,
              style: box(rect(d.r.x - 9, d.r.y, 18, d.r.h)),
              onClick: () => choose(d.key),
            },

          ),
        ),
      ),
    ),
    !b.threads.length &&
      h(
        "p",
        { className: "no-rows", style: { left: t.x, top: a.y } },
        "No recorded threads.",
      ),
  );
}
export function LandscapeBoard({ board, selected, choose, height }) {
  return h(
    "main",
    {
      className: "board",
      style: { width: board.width, height: board.height },
    },
    h("h1", { className: "sr-only" }, "Synthetic thread activity landscape"),
    h(CategoryView, { b: board, selected, choose, height }),
    h(TrendView, { b: board, selected, choose }),
    h(TimelineView, { b: board, selected, choose }),
  );
}
