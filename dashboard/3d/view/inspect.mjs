import { createElement as h } from "react";
import { Button } from "../../web/controls.tsx";
import { timeLabel } from "./parcels.mjs";

const control = (props, ...children) =>
  h(Button, { type: "button", ...props }, ...children);
export function Inspector({ item, board, select }) {
  if (!item) return null;
  const parent = board.objects.get(item.parent);
  let facts;
  if (item.kind === "batch") {
    facts = [
      item.measured + " of 10 threads measured",
      ...[-1, 1].map((step) =>
        control(
          {
            key: step,
            disabled: !board.batches[item.index + step],
            onClick: () =>
              select(board.batches[item.index + step].key, "batch-step"),
          },
          step < 0 ? "Previous batch" : "Next batch",
        ),
      ),
    ];
  } else if (item.kind === "category" || item.kind === "operation") {
    const category = item.kind === "category" ? item : parent;
    facts = category.operations.length
      ? category.operations.map((op) =>
          control(
            {
              key: op.key,
              "data-fallback": op.key,
              "aria-pressed": item.key === op.key,
              onClick: () => select(op.key),
            },
            op.name + " · " + op.value,
          ),
        )
      : "No operations in this range.";
  } else {
    const thread = item.kind === "thread" ? item : parent;
    const entries = [...thread.parts, ...thread.failures].sort(
      (a, b) => a.start - b.start,
    );
    facts = h(
      "ul",
      { className: "evidence-list", "aria-label": "Recorded timeline" },
      entries.map((part) =>
        h(
          "li",
          { key: part.key },
          control(
            {
              "aria-pressed": part.key === item.key,
              onClick: () => select(part.key),
            },
            timeLabel(part.start) +
              (part.duration != null
                ? "–" + timeLabel(part.start + part.duration)
                : "") +
              " · " +
              (part.category && part.name !== part.category
                ? part.category + " · "
                : "") +
              part.name,
          ),
        ),
      ),
    );
    if (!entries.length) facts = "No elapsed interval recorded.";
  }
  return h(
    "section",
    { className: "farm-detail", "aria-label": "Selected field" },
    h("h2", null, item.name),
    h("span", { className: "readout" }, item.value),
    item.duration !== null &&
      h(
        "small",
        { className: "sr-only" },
        item.duration.toLocaleString("en") + " ms",
      ),
    h("div", { className: "facts" }, facts),
  );
}
