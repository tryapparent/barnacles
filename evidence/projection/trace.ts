import type { IntervalIdentity, ObservedInterval } from "./intervals.ts";

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

export type SpanRow = ObservedInterval<Extract<IntervalIdentity, { source: "codex" }>, "tool_envelope" | "async_cell"> & {
  terminal: string | null; line: number; tool: string; command: string; categories: string;
};
export type ReasoningRow = { line: number; at: number; resultAt: number; resultCallLine: number };

export function projectTrace(rows: SpanRow[], markers: ReasoningRow[], clean: boolean, policy: TracePolicy) {
  const measured = rows.filter((row): row is SpanRow & { start: number; end: number } =>
    policy.interval_valid(row.start ?? 0, row.end ?? 0));
  const cells = measured.filter((row) => row.terminal !== null);
  const children = Map.groupBy(cells, (row) => row.identity.call);
  const waits = Map.groupBy(cells, (row) => row.terminal);
  let bounds: TraceWindow = { $: "Window", from: 0, to: 0 };
  for (const row of measured) bounds = policy.extend_window(bounds, row.start, row.end);
  for (const marker of markers) bounds = policy.extend_window(bounds, marker.at, marker.at);
  if (!bounds.from) return null;
  const spans = measured.map((row) => {
    const candidates = [...(children.get(row.identity.call) ?? []), ...(waits.get(row.identity.call) ?? [])];
    const parent = candidates[0];
    const nested = policy.trace_parent(row.clock, candidates.length, row.start, row.end, parent?.start ?? 0, parent?.end ?? 0);
    return { ...row, parent: nested ? parent.identity.call : null,
      name: policy.trace_span_name(row.clock, row.tool, row.command, row.categories) };
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
    estimates.push(marker);
  }
  return { bounds, spans, markers, estimates };
}

export type TraceProjection = NonNullable<ReturnType<typeof projectTrace>>;
