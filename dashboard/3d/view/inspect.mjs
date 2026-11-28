export function createInspectors({
  clearPlots,
  first,
  worldRect,
  remember,
  focusRect,
  dispatch,
  tags,
  labelAnchorsForRow,
  placeLabels,
  present,
  facts,
  home,
  all,
  rememberBatch,
}) {
  function threadDetails(trigger) {
    clearPlots();
    const row = trigger.closest(".trace"),
      el = row.querySelector(".bar");
    if (!el) return;

    const native = row.querySelector(".inspectable"),
      r = worldRect(el);
    remember(trigger);
    focusRect(r, el, "thread");
    if (native.getAttribute("aria-expanded") !== "true") dispatch(native);
    for (const span of row.querySelectorAll(".bar .field-span")) {
      const tag = document.createElement("span");
      tag.textContent =
        span.dataset.kind === "1"
          ? "Admission wait"
          : span.dataset.kind === "2"
            ? "Provider run"
            : "Unobserved";
      tags.append(tag);
      labelAnchorsForRow({ tag, r: worldRect(span) });
    }
    placeLabels();
    present(
      row.querySelector(".sample-title").textContent,
      row.querySelector(".meta").textContent,
    );
    requestAnimationFrame(() => {
      const inspector = first("#thread-inspector");
      const list = inspector?.querySelector("ol,ul,dl");
      if (list) {
        const c = list.cloneNode(true);
        c.removeAttribute("id");
        facts.append(c);
      } else if (inspector) {
        facts.textContent = inspector.innerText
          .split("\n")
          .filter((v) => v && v !== "×" && !v.includes("Recorded timeline"))
          .join(" · ");
      }
    });
    home.focus({ preventScroll: true });
  }
  function batchDetails(idx, trigger) {
    clearPlots();
    const chart = first(".trend-plot svg"),
      bounds = worldRect(chart.querySelector("foreignObject"));
    const btn = first(".batch-trigger");
    if (btn.getAttribute("aria-expanded") !== "true") dispatch(btn);
    requestAnimationFrame(() => {
      const rows = all(".trend-batch-panel tbody tr");
      if (!rows.length) return;
      idx = Math.max(0, Math.min(rows.length - 1, idx));
      const row = rows[idx],
        cells = [...row.cells].map((c) => c.textContent);
      const frac = idx / Math.max(1, rows.length - 1),
        x = bounds.x + bounds.w * frac,
        step = bounds.w / Math.max(1, rows.length - 1);
      const left = Math.max(bounds.x, x - step * 0.5),
        right = Math.min(bounds.x + bounds.w, x + step * 0.5);
      dispatch(btn);
      remember(trigger);
      focusRect(
        { x: left, y: bounds.y, w: right - left, h: bounds.h },
        chart,
        "batch",
      );
      rememberBatch(idx);
      present("Threads " + cells[0], cells[1] + " agent work");
      facts.textContent = cells[2] + " threads measured";
      const prev = document.createElement("button"),
        next = document.createElement("button");
      prev.type = next.type = "button";
      prev.textContent = "Previous batch";
      next.textContent = "Next batch";
      prev.disabled = idx === 0;
      next.disabled = idx === rows.length - 1;
      prev.onclick = () => batchDetails(idx - 1, trigger);
      next.onclick = () => batchDetails(idx + 1, trigger);
      facts.append(prev, next);
      home.focus({ preventScroll: true });
    });
  }
  return { threadDetails, batchDetails };
}
