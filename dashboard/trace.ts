import { createHash } from "node:crypto";
export type TraceWindow = { $: "Window"; from: number; to: number };
type ActivityScan = { $: "Scan"; latest_end: number; open: boolean };
export type TracePolicy = {
  interval_valid(start: number, end: number): boolean;
  extend_window(window: TraceWindow, start: number, end: number): TraceWindow;
  trace_operation(clock: string, tool: string, command: string, categories: string): string;
  trace_span_name(clock: string, tool: string, command: string, categories: string): string;
  trace_parent(clock: string, count: number, start: number, end: number, parentStart: number, parentEnd: number): boolean;
  scan_activity(scan: ActivityScan, start: number, end: number, until: number): { $: "Hold" } | { $: "Advance"; scan: ActivityScan };
  estimate_model_wait(clean: boolean, result: number, at: number, scan: ActivityScan): boolean;
};

export type SpanRow = {
  call: string; terminal: string | null; line: number; tool: string; command: string; categories: string;
  clock: string; start: number | null; end: number | null;
};
export type ReasoningRow = { line: number; at: number; resultAt: number; resultCallLine: number };

function id(length: number, ...parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, length);
}

const nanos = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

export function encodeTrace(key: string, rows: SpanRow[], markers: ReasoningRow[], clean: boolean, policy: TracePolicy) {
  const measured = rows.filter((row): row is SpanRow & { start: number; end: number } =>
    policy.interval_valid(row.start ?? 0, row.end ?? 0));
  const cells = measured.filter((row) => row.terminal !== null);
  const children = Map.groupBy(cells, (row) => row.call);
  const waits = Map.groupBy(cells, (row) => row.terminal);
  const traceId = id(32, "barnacles-codex-trace", key);
  const root = id(16, "barnacles-codex-window", key);
  const spanId = (row: SpanRow) => id(16, "barnacles-codex-span", key, row.call, row.clock);
  let bounds: TraceWindow = { $: "Window", from: 0, to: 0 };
  for (const row of measured) bounds = policy.extend_window(bounds, row.start, row.end);
  for (const marker of markers) bounds = policy.extend_window(bounds, marker.at, marker.at);
  if (!bounds.from) return null;
  const spans = measured.map((row) => {
    const candidates = [...(children.get(row.call) ?? []), ...(waits.get(row.call) ?? [])];
    const parent = candidates[0];
    const nested = policy.trace_parent(row.clock, candidates.length, row.start, row.end, parent?.start ?? 0, parent?.end ?? 0);
    return {
      traceId, spanId: spanId(row), parentSpanId: nested && parent ? spanId(parent) : root,
      name: policy.trace_span_name(row.clock, row.tool, row.command, row.categories), kind: 1,
      startTimeUnixNano: nanos(row.start), endTimeUnixNano: nanos(row.end),
      attributes: [text("barnacles.clock", row.clock), integer("barnacles.source_line", row.line),
        ...(row.command ? [text("barnacles.submitted_command", row.command)] : []),
        ...(row.categories ? [text("barnacles.categories", row.categories), text("barnacles.tool", row.tool)] : [])],
    };
  });
  let next = 0;
  let scan: ActivityScan = { $: "Scan", latest_end: 0, open: false };
  const estimates = [];
  for (const marker of markers) {
    for (; next < rows.length; next++) {
      const { start, end } = rows[next];
      const step = policy.scan_activity(scan, start ?? 0, end ?? 0, marker.at);
      if (step.$ === "Hold") break;
      scan = step.scan;
    }
    if (!policy.estimate_model_wait(clean, marker.resultAt, marker.at, scan)) continue;
    estimates.push({
      traceId, spanId: id(16, "barnacles-model-wait-estimate", key, String(marker.line)), parentSpanId: root,
      name: "Estimated model wait", kind: 1,
      startTimeUnixNano: nanos(marker.resultAt), endTimeUnixNano: nanos(marker.at),
      attributes: [text("barnacles.clock", "model_wait_estimate"),
        text("barnacles.estimate_basis", "Tool result to recorded reasoning"),
        integer("barnacles.tool_call_line", marker.resultCallLine),
        integer("barnacles.reasoning_line", marker.line)],
    });
  }
  const session = {
    traceId, spanId: root, name: "Recorded session window", kind: 1,
    startTimeUnixNano: nanos(bounds.from), endTimeUnixNano: nanos(bounds.to),
    attributes: [text("barnacles.clock", "observation_window")],
    events: markers.map((marker) => ({ name: "Reasoning recorded", timeUnixNano: nanos(marker.at),
      attributes: [integer("barnacles.source_line", marker.line)] })),
  };
  const payload = { resourceSpans: [{ resource: { attributes: [text("service.name", "codex")] },
    scopeSpans: [{ scope: { name: "barnacles" }, spans: [session, ...spans, ...estimates] }] }] };
  return { traceId, bounds, payload, spans: measured.length };
}
