import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { List } from "../storage/sources.ts";
import type { IntervalIdentity, ObservedInterval } from "./intervals.ts";
import { rows, type collectTiming, type Stats } from "./timing.ts";

export type TraceWindow = { $: "Window"; from: number; to: number };
type SessionKey = { $: "SessionKey"; instance: string; session: string };
type Optional<T> = { $: "None" } | { $: "Some"; value: T };
type Span = { $: "Span"; call: string; terminal: Optional<string>; line: number; tool: string;
  clock: "tool_envelope" | "async_cell"; start: Optional<number>; end: Optional<number> };
type Measured = { $: "Measured"; call: string; terminal: Optional<string>; parent: Optional<string>; line: number; tool: string; command: string;
  categories: string; clock: Span["clock"]; start: number; end: number; name: string };
type Reasoning = { line: number; at: number; result_at: number; result_call_line: number };
type SessionTiming = { $: "SessionTiming"; envelopes: Stats; cells: Stats };
type TraceResult = { observations: List<{ span: Span; categories: string; operation: string; clock: string }>; bounds: TraceWindow;
  spans: List<Measured>; markers: List<Reasoning>; estimates: List<Reasoning>;
  coverage: SessionTiming; reasoning_count: number };
type TraceChoice = { session: number; trace_id: string; from: number; to: number; mixed: boolean };

export type TracePolicy = {
  empty_sessions(): unknown;
  empty_trace_facts(): unknown;
  note_trace_label(facts: unknown, key: SessionKey, name: string, id: string, value: string): unknown;
  note_reasoning_input(facts: unknown, key: SessionKey, line: number, call: string): unknown;
  note_result_clock(facts: unknown, key: SessionKey, call: string, result: { $: "ResultClock"; at: number; line: number }): unknown;
  note_trace_rollout(facts: unknown, key: SessionKey, malformed: number, orphans: number): unknown;
  note_trace_span(sessions: unknown, key: SessionKey, span: Span): unknown;
  note_trace_marker(sessions: unknown, key: SessionKey, marker: { $: "Marker"; line: number; at: number }): unknown;
  trace_sessions(sessions: unknown): List<SessionKey>;
  project_trace(sessions: unknown, key: SessionKey, facts: unknown): TraceResult;
  trace_wire(key: string, result: TraceResult): TraceWire;
  empty_trace_choice(): TraceChoice;
  choose_trace(best: TraceChoice, session: number, traceId: string, bounds: TraceWindow, coverage: SessionTiming, count: number):
    TraceChoice;
};

type ReasoningRow = { line: number; at: number; resultAt: number; resultCallLine: number };
type SpanRow = ObservedInterval<Extract<IntervalIdentity, { source: "codex" }>, Span["clock"]> &
  Omit<Measured, "$" | "call" | "parent" | "terminal"> & { parent: string | null; terminal: string | null };
export type TraceProjection = { bounds: TraceWindow; spans: SpanRow[]; markers: ReasoningRow[]; estimates: ReasoningRow[] };
export type TraceAttribute = { $: "TextAttribute" | "IntAttribute"; key: string; value: string };
type TraceEvent = { name: string; time: string; attributes: List<TraceAttribute> };
type TraceWireSpan = { id: List<string>; parent: Optional<List<string>>; name: string; kind: number; start: string;
  end: string; attributes: List<TraceAttribute>; events: Optional<List<TraceEvent>> };
export type TraceWire = { id: List<string>; resource: List<TraceAttribute>; scope: string; spans: List<TraceWireSpan> };
export type TraceWriter = (key: string, trace: TraceProjection, wire: () => TraceWire) => string;

const decode = <T>(value: Optional<T>) => value.$ === "Some" ? value.value : null;
const encode = <T>(value: SQLOutputValue, convert: (value: SQLOutputValue) => T): Optional<T> =>
  value === null ? { $: "None" } : { $: "Some", value: convert(value) };
const identity = (row: Record<string, SQLOutputValue>): SessionKey =>
  ({ $: "SessionKey", instance: String(row.instance), session: String(row.session_id) });
const reasoning = ({ line, at, result_at, result_call_line }: Reasoning): ReasoningRow =>
  ({ line, at, resultAt: result_at, resultCallLine: result_call_line });

export function writeTraces(source: DatabaseSync, view: DatabaseSync, policy: TracePolicy, timing: ReturnType<typeof collectTiming>,
  writeTrace: TraceWriter) {
  const table = (name: string) => Boolean(source.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
  const scan = (sql: string) => source.prepare(sql).iterate();
  const rolloutCount = table("codex_rollouts") ? Number(source.prepare("SELECT count(*) AS count FROM codex_rollouts").get()?.count) : 0;
  if (!table("codex_spans")) return { rolloutCount, traceSessions: 0, defaultTrace: undefined };
  let facts = policy.empty_trace_facts();
  for (const row of scan("SELECT * FROM codex_rollouts")) {
    facts = policy.note_trace_rollout(facts, identity(row), Number(row.malformed_count), Number(row.orphan_count));
  }
  if (table("codex_commands")) for (const row of scan("SELECT * FROM codex_commands")) {
    facts = policy.note_trace_label(facts, identity(row), "command", String(row.call_id), String(row.command));
  }
  if (table("codex_categories")) for (const row of scan("SELECT * FROM codex_categories")) {
    facts = policy.note_trace_label(facts, identity(row), "categories", String(row.call_id), String(row.categories));
  }
  if (table("codex_reasoning_inputs")) {
    for (const row of scan("SELECT * FROM codex_reasoning_inputs")) {
      facts = policy.note_reasoning_input(facts, identity(row), Number(row.source_line), String(row.result_call_id));
    }
    for (const row of scan("SELECT * FROM codex_calls")) {
      facts = policy.note_result_clock(facts, identity(row), String(row.call_id),
        { $: "ResultClock", at: Number(row.ended_ms ?? 0), line: Number(row.source_line) });
    }
  }

  let groups = policy.empty_sessions();
  for (const row of scan("SELECT * FROM codex_spans ORDER BY started_ms, source_line, clock")) {
    groups = policy.note_trace_span(groups, identity(row), {
      $: "Span", call: String(row.call_id), terminal: encode(row.terminal_call_id, String), line: Number(row.source_line),
      tool: String(row.tool), clock: row.clock as Span["clock"], start: encode(row.started_ms, Number), end: encode(row.ended_ms, Number),
    });
  }
  if (table("codex_reasoning")) for (const row of scan("SELECT * FROM codex_reasoning ORDER BY observed_ms, source_line")) {
    const at = Number(row.observed_ms);
    timing.observe("Codex", at);
    groups = policy.note_trace_marker(groups, identity(row), { $: "Marker", line: Number(row.source_line), at });
  }

  const insert = view.prepare("INSERT INTO trace VALUES (?, ?, ?, ?, ?, ?)");
  const mark = view.prepare("INSERT INTO trace_reasoning VALUES (?, ?, ?)");
  const windows = view.prepare("INSERT INTO trace_windows VALUES (?, ?, ?, ?, ?)");
  const coverage = view.prepare("INSERT INTO trace_coverage VALUES (?, ?, ?, ?, ?)");
  let choice = policy.empty_trace_choice();
  const sessions = rows(policy.trace_sessions(groups));
  for (const [index, key] of sessions.entries()) {
    const session = index + 1;
    const result = policy.project_trace(groups, key, facts);
    const observations = rows(result.observations);
    for (const { span, categories, operation, clock } of observations) {
      const start = decode(span.start);
      const end = decode(span.end);
      timing.observeCodex(span.clock, categories, start ?? 0, end ?? 0);
      insert.run(session, span.line, operation, clock, start, end);
    }
    const { envelopes, cells } = result.coverage;
    coverage.run(session, 0, "Tool envelopes", envelopes.count, envelopes.missing);
    coverage.run(session, 1, "Async cells", cells.count, cells.missing);
    coverage.run(session, 2, "Reasoning events", result.reasoning_count, null);
    const markers = rows(result.markers).map(reasoning);
    for (const marker of markers) mark.run(session, marker.line, marker.at);
    const spans = rows(result.spans).map(({ $, call, terminal, parent, ...span }): SpanRow => ({
      ...span, parent: decode(parent), terminal: decode(terminal),
      identity: { source: "codex", instance: key.instance, session: key.session, call },
    }));
    const { bounds } = result;
    const wireKey = JSON.stringify([key.instance, key.session]);
    const traceId = bounds.from ? writeTrace(wireKey, { bounds, spans, markers, estimates: rows(result.estimates).map(reasoning) },
      () => policy.trace_wire(wireKey, result)) : null;
    windows.run(session, traceId, bounds.from || null, bounds.from ? bounds.to : null, spans.length);
    choice = policy.choose_trace(choice, session, traceId ?? "", bounds, result.coverage, result.reasoning_count);
  }
  const defaultTrace = choice.trace_id ? { session: choice.session, traceId: choice.trace_id, from: choice.from, to: choice.to, mixed: choice.mixed }
    : undefined;
  return { rolloutCount, traceSessions: sessions.length, defaultTrace };
}
