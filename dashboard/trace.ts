import { createHash } from "node:crypto";
import type { TraceProjection } from "../evidence/read.ts";

function id(length: number, ...parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, length);
}

const nanos = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
const integer = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

export function encodeTrace(key: string, { bounds, spans, markers, estimates }: TraceProjection) {
  const traceId = id(32, "barnacles-codex-trace", key);
  const root = id(16, "barnacles-codex-window", key);
  const spanId = (call: string, clock: string) => id(16, "barnacles-codex-span", key, call, clock);
  const measured = spans.map((row) => ({
    traceId, spanId: spanId(row.identity.call, row.clock),
    parentSpanId: row.parent === null ? root : spanId(row.parent, "async_cell"),
    name: row.name, kind: 1, startTimeUnixNano: nanos(row.start), endTimeUnixNano: nanos(row.end),
    attributes: [text("barnacles.clock", row.clock), integer("barnacles.source_line", row.line),
      ...(row.command ? [text("barnacles.submitted_command", row.command)] : []),
      ...(row.categories ? [text("barnacles.categories", row.categories), text("barnacles.tool", row.tool)] : [])],
  }));
  const modeled = estimates.map((marker) => ({
    traceId, spanId: id(16, "barnacles-model-wait-estimate", key, String(marker.line)), parentSpanId: root,
    name: "Estimated model wait", kind: 1,
    startTimeUnixNano: nanos(marker.resultAt), endTimeUnixNano: nanos(marker.at),
    attributes: [text("barnacles.clock", "model_wait_estimate"),
      text("barnacles.estimate_basis", "Tool result to recorded reasoning"),
      integer("barnacles.tool_call_line", marker.resultCallLine),
      integer("barnacles.reasoning_line", marker.line)],
  }));
  const session = {
    traceId, spanId: root, name: "Recorded session window", kind: 1,
    startTimeUnixNano: nanos(bounds.from), endTimeUnixNano: nanos(bounds.to),
    attributes: [text("barnacles.clock", "observation_window")],
    events: markers.map((marker) => ({ name: "Reasoning recorded", timeUnixNano: nanos(marker.at),
      attributes: [integer("barnacles.source_line", marker.line)] })),
  };
  const payload = { resourceSpans: [{ resource: { attributes: [text("service.name", "codex")] },
    scopeSpans: [{ scope: { name: "barnacles" }, spans: [session, ...measured, ...modeled] }] }] };
  return { traceId, payload };
}
