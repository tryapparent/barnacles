import { createHash } from "node:crypto";
import { rows, type TraceAttribute, type TraceWire } from "../evidence/read.ts";

function id(length: number, parts: string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, length);
}

function attribute({ $, key, value }: TraceAttribute) {
  return { key, value: $ === "IntAttribute" ? { intValue: value } : { stringValue: value } };
}

export function encodeTrace(wire: TraceWire) {
  const traceId = id(32, rows(wire.id));
  const spans = rows(wire.spans).map((span) => ({
    traceId, spanId: id(16, rows(span.id)),
    ...(span.parent.$ === "Some" ? { parentSpanId: id(16, rows(span.parent.value)) } : {}),
    name: span.name, kind: span.kind, startTimeUnixNano: span.start, endTimeUnixNano: span.end,
    attributes: rows(span.attributes).map(attribute),
    ...(span.events.$ === "Some" ? { events: rows(span.events.value).map((event) => ({
      name: event.name, timeUnixNano: event.time, attributes: rows(event.attributes).map(attribute),
    })) } : {}),
  }));
  const payload = { resourceSpans: [{ resource: { attributes: rows(wire.resource).map(attribute) },
    scopeSpans: [{ scope: { name: wire.scope }, spans }] }] };
  return { traceId, payload };
}
