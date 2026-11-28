const materials = ["fog", "soil", "grain"];
const names = ["Unobserved", "Admission wait", "Provider run"];
const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const day = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
export const utc = (ms) => day.format(ms) + " · " + clock.format(ms) + " UTC";
export function timeLabel(ms) {
  if (!ms) return "0s";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return ms / 1000 + "s";
  const minutes = Math.floor(ms / 60000);
  return (
    (minutes >= 60 ? Math.floor(minutes / 60) + "h " : "") +
    (minutes % 60) +
    "m"
  );
}
export const rect = (x, y, w, h) => ({ x, y, w, h });
export const rows = (list) => {
  const items = [];
  for (let p = list; p.$ === "Con"; p = p.tail) items.push(p.head);
  return items;
};
export const list = (items) =>
  items.reduceRight((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
const nat = (n) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid snapshot clock");
  return n;
};
const millis = (n) => {
  if (typeof n !== "number" || n < 0) throw Error("Invalid elapsed seconds");
  return nat(Math.round(n * 1000));
};
export function decodeFeed(feed) {
  if (feed.unavailable) throw Error("Snapshot unavailable");
  const history = feed.history ?? { first: 1, threads: [] };
  const traces = feed.traces.map((trace) => {
    const span =
      (kind) =>
      ([a, b, name]) => {
        if (typeof name !== "string") throw Error("Missing operation label");
        return { $: "Interval", a: millis(a), b: millis(b), kind, name };
      };
    const start = nat(trace.startUtcMs),
      end = millis(trace.end);
    if (!Number.isFinite(new Date(start + end).valueOf()))
      throw Error("Invalid UTC range");
    return {
      $: "Trace",
      start,
      end,
      intervals: list([...trace.work.map(span(2)), ...trace.wait.map(span(1))]),
      errors: list(trace.errors.map(millis)),
    };
  });
  return {
    traces,
    history: history.threads.map(({ work, workflow }, index) => ({
      $: "TrendThread",
      start: index,
      position: index,
      work: nat(work),
      workflow: nat(workflow),
    })),
    first: nat(history.first),
    observed: nat(feed.observed),
  };
}
export function readScene(policy, decoded) {
  const result = policy.landscape(
    list(decoded.traces),
    list(decoded.history),
    decoded.first,
  );
  const groups = rows(result.summary.categories);
  return {
    observed: decoded.observed,
    frame: result.frame,
    total: result.summary.duration,
    categories: [1, 2, 0].map((kind) => {
      const group = groups.find((g) => g.kind === kind);
      return {
        kind,
        name: names[kind],
        material: materials[kind],
        duration: group?.duration ?? 0,
        operations: group
          ? rows(group.operations).map(({ name, duration, spans }) => ({
              name,
              duration,
              matches: rows(spans).map((span) => span.index - 1),
            }))
          : [],
      };
    }),
    traces: rows(result.rows).map((row) => ({
      ...row,
      parts: rows(row.parts),
      failures: rows(row.failures),
    })),
    batches: rows(result.batches),
  };
}
function descriptor(key, parent, kind, material, name, value, duration, r) {
  const section = ["category", "operation"].includes(kind)
    ? "summary"
    : kind === "batch"
      ? "trend"
      : "timeline";
  return {
    key,
    parent,
    kind,
    material,
    name,
    value,
    duration,
    r,
    target: {
      $: "Target",
      key,
      parent,
      section,
      toggle: ["operation", "phase", "failure"].includes(kind),
    },
    anchor: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
    priority: kind === "category" ? 2 : 1,
    minHeight: 14,
  };
}
function portion(box, start, share, vertical = false) {
  return vertical
    ? rect(box.x, box.y + start * box.h, box.w, box.h * share)
    : rect(box.x + start * box.w, box.y, box.w * share, box.h);
}
export function landscapeLayout(scene, width, revision, selection, policy) {
  const margin = Math.min(62, width * 0.041);
  const usable = width - margin * 2;
  const gap = Math.max(28, width * 0.044);
  const fieldWidth = (usable - gap) * 0.544;
  const heading = 47;
  const summary = rect(margin, 115, fieldWidth, Math.min(266, width * 0.18));
  const trendZone = rect(
    margin + fieldWidth + gap,
    summary.y,
    usable - fieldWidth - gap,
    summary.h,
  );
  const trend = rect(
    trendZone.x + trendZone.w * 0.1325,
    trendZone.y + trendZone.h * 0.083,
    trendZone.w * 0.8225,
    trendZone.h * 0.69,
  );
  const timeline = rect(margin, trendZone.y + trendZone.h + 52, usable, 0);
  const rowHeight = 42;
  const threadWidth = Math.min(181, width * 0.125);
  const axis = rect(
    margin + threadWidth,
    timeline.y + 102,
    usable - threadWidth,
    0,
  );
  const objects = new Map(),
    surfaces = [];
  const add = (d) => {
    objects.set(d.key, d);
    return d;
  };
  const categories = [];
  let restAt = 0;
  const firstShare = scene.total
    ? scene.categories[0].duration / scene.total
    : 0;
  const rest = portion(summary, firstShare, scene.total ? 1 - firstShare : 0);
  for (const [index, category] of scene.categories.entries()) {
    const share = scene.total - scene.categories[0].duration;
    const fraction = share ? category.duration / share : 0;
    const box =
      index === 0
        ? portion(summary, 0, firstShare)
        : portion(rest, restAt, fraction, true);
    if (index > 0) restAt += fraction;
    const key = "category/" + category.kind;
    const d = add(
      descriptor(
        key,
        "summary",
        "category",
        category.material,
        category.name,
        timeLabel(category.duration),
        category.duration,
        box,
      ),
    );
    d.category = category.kind;
    d.operations = [];
    let start = 0;
    for (const op of category.operations) {
      const area = op.duration / category.duration;
      const piece = portion(box, start, area, category.operations.length > 2);
      start += area;
      const sub = add(
        descriptor(
          key + "/operation/" + op.name,
          key,
          "operation",
          category.material,
          category.kind === 0 ? "Unobserved interval" : op.name,
          timeLabel(op.duration),
          op.duration,
          piece,
        ),
      );
      sub.matches = op.matches;
      d.operations.push(sub);
    }
    categories.push(d);
    const open =
      selection === key || d.operations.some((op) => op.key === selection);
    surfaces.push(...(open && d.operations.length ? d.operations : [d]));
  }
  const batchItems = scene.batches.map((batch, index) => {
    const step = 1 / Math.max(1, scene.batches.length - 1);
    const x = scene.batches.length === 1 ? 0.5 : index * step;
    const start = Math.max(0, x - step / 2),
      stop = Math.min(1, x + step / 2);
    const d = add(
      descriptor(
        "r" + revision + "/batch/" + index,
        "trend",
        "batch",
        "grain",
        "Threads " + batch.first + "–" + batch.last,
        batch.measured
          ? (batch.basis_points / 100).toFixed(1) + "%"
          : "Unknown",
        null,
        portion(trend, start, stop - start),
      ),
    );
    d.point = batch.measured
      ? [
          trend.x + trend.w * x,
          trend.y + trend.h * (1 - batch.basis_points / 10000),
        ]
      : null;
    d.measured = batch.measured;
    d.index = index;
    return d;
  });
  const runs = [];
  let run;
  for (const batch of batchItems) {
    if (!batch.point) {
      run = null;
      continue;
    }
    if (!run) {
      run = [];
      runs.push(run);
    }
    run.push(batch.point);
  }
  const span = Math.max(1, scene.frame.end - scene.frame.start);
  const xAt = (ms) => axis.x + (axis.w * (ms - scene.frame.start)) / span;

  const threads = [];
  for (const [index, row] of scene.traces.entries()) {
    const rail = rect(
      axis.x,
      axis.y + threads.length * rowHeight,
      axis.w,
      rowHeight - 2,
    );
    const box = rect(xAt(row.start), rail.y, (axis.w * row.end) / span, rail.h);
    const key = "r" + revision + "/thread/" + index;
    const d = add(
      descriptor(
        key,
        "timeline",
        "thread",
        "",
        "Thread " + (index + 1),
        utc(row.start),
        row.end,
        box,
      ),
    );
    d.rail = rail;
    d.index = index;
    d.parts = row.parts.map((part, i) => {
      const r = rect(
        xAt(row.start + part.a),
        rail.y,
        (axis.w * (part.b - part.a)) / span,
        rail.h,
      );
      const p = add(
        descriptor(
          key + "/phase/" + i,
          key,
          "phase",
          materials[part.kind],
          part.name,
          timeLabel(part.b - part.a),
          part.b - part.a,
          r,
        ),
      );
      p.start = part.a;
      p.category = names[part.kind];
      p.slot = "row/" + index + "/phase/" + i;
      p.small = true;
      return p;
    });
    d.failures = row.failures.map((at, i) => {
      const event = add(
        descriptor(
          key + "/failure/" + i,
          key,
          "failure",
          "",
          "Recorded failure",
          timeLabel(at),
          null,
          rect(xAt(row.start + at), rail.y, 0, rail.h),
        ),
      );
      event.start = at;
      return event;
    });
    surfaces.push(...d.parts);
    threads.push(d);
  }
  const ticks = rows(policy.ticks(scene.frame, Math.floor(axis.w))).map(
    (time) => ({
      x: xAt(time),
      name: day.format(time),
      value: clock.format(time),
    }),
  );
  return {
    width,
    height: axis.y + Math.max(1, threads.length) * rowHeight + 15,
    heading,
    margin,
    summary,
    trendZone,
    trend,
    timeline,
    axis,
    rowHeight,
    categories,
    runs,
    batches: batchItems,
    threads,
    ticks,
    surfaces,
    objects,
  };
}
