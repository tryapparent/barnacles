import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { List } from "../storage/sources.ts";
import type { IntervalIdentity, ObservedInterval } from "./intervals.ts";
import { rows, type collectTiming, type ProcessAttribution, type Stats } from "./timing.ts";

export type TraceWindow = { $: "Window"; from: number; to: number };
type SessionKey = { $: "SessionKey"; instance: string; session: string };
type Optional<T> = { $: "None" } | { $: "Some"; value: T };
type Span = { $: "Span"; call: string; terminal: Optional<string>; line: number; tool: string;
  clock: "tool_envelope" | "async_cell"; start: Optional<number>; end: Optional<number>; attribution: ProcessAttribution };
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
  trace_wire(key: string, result: TraceResult): unknown;
  empty_trace_choice(): TraceChoice;
  choose_trace(best: TraceChoice, session: number, traceId: string, bounds: TraceWindow, coverage: SessionTiming, count: number):
    TraceChoice;
};

type ReasoningRow = { line: number; at: number; resultAt: number; resultCallLine: number };
type SpanRow = ObservedInterval<Extract<IntervalIdentity, { source: "codex" }>, Span["clock"]> &
  Omit<Measured, "$" | "call" | "parent" | "terminal"> & { parent: string | null; terminal: string | null };
export type TraceProjection = { bounds: TraceWindow; spans: SpanRow[]; markers: ReasoningRow[]; estimates: ReasoningRow[] };
type TracePayload = { trace_id: string; payload_bytes: string };
export type OtlpPolicy = {
  wire_key_bytes(instance: string, session: string): string;
  encode(wire: unknown): TracePayload;
};
export type TraceWriter = (key: string, trace: TraceProjection, encode: () => TracePayload) => string;

const decode = <T>(value: Optional<T>) => value.$ === "Some" ? value.value : null;
const encode = <T>(value: SQLOutputValue, convert: (value: SQLOutputValue) => T): Optional<T> =>
  value === null ? { $: "None" } : { $: "Some", value: convert(value) };
const identity = (row: Record<string, SQLOutputValue>): SessionKey =>
  ({ $: "SessionKey", instance: String(row.instance), session: String(row.session_id) });
const reasoning = ({ line, at, result_at, result_call_line }: Reasoning): ReasoningRow =>
  ({ line, at, resultAt: result_at, resultCallLine: result_call_line });

export function writeTraces(source: DatabaseSync, view: DatabaseSync, policy: TracePolicy, otlp: OtlpPolicy, timing: ReturnType<typeof collectTiming>,
  writeTrace?: TraceWriter) {
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

  const columns = ["span.*"];
  const joins = [];
  if (table("codex_process_receipts")) {
    columns.push("direct.process_status AS io_status", "direct.process_category AS io_category");
    joins.push(`LEFT JOIN codex_process_receipts direct
      ON (direct.instance, direct.session_id, direct.call_id) = (span.instance, span.session_id, span.call_id)`);
    if (table("codex_wait_attribution")) {
      columns.push("wait.cell_status", "launch.process_status AS wait_status", "launch.process_category AS wait_category");
      joins.push(`LEFT JOIN codex_wait_attribution wait
        ON (wait.instance, wait.session_id, wait.call_id) = (span.instance, span.session_id, span.call_id)
        LEFT JOIN codex_process_receipts launch
        ON (launch.instance, launch.session_id, launch.call_id) = (wait.instance, wait.session_id, wait.cell_launch_call_id)`);
    }
  }
  let groups = policy.empty_sessions();
  for (const row of scan(`SELECT ${columns.join(", ")} FROM codex_spans span ${joins.join(" ")}
    ORDER BY span.started_ms, span.source_line, span.clock`)) {
    groups = policy.note_trace_span(groups, identity(row), {
      $: "Span", call: String(row.call_id), terminal: encode(row.terminal_call_id, String), line: Number(row.source_line),
      tool: String(row.tool), clock: row.clock as Span["clock"], start: encode(row.started_ms, Number), end: encode(row.ended_ms, Number),
      attribution: { $: "ProcessAttribution", cell_status: String(row.cell_status ?? ""),
        wait_status: String(row.wait_status ?? ""), wait_category: String(row.wait_category ?? ""),
        io_status: String(row.io_status ?? ""), io_category: String(row.io_category ?? "") },
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
      timing.observeCodex(span.clock, categories, span.attribution, start ?? 0, end ?? 0);
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
    const wireKey = Buffer.from(otlp.wire_key_bytes(key.instance, key.session), "latin1").toString("utf8");
    const traceId = bounds.from && writeTrace ? writeTrace(wireKey, { bounds, spans, markers, estimates: rows(result.estimates).map(reasoning) },
      () => otlp.encode(policy.trace_wire(wireKey, result))) : null;
    windows.run(session, traceId, bounds.from || null, bounds.from ? bounds.to : null, spans.length);
    choice = policy.choose_trace(choice, session, traceId ?? "", bounds, result.coverage, result.reasoning_count);
  }
  const defaultTrace = choice.trace_id ? { session: choice.session, traceId: choice.trace_id, from: choice.from, to: choice.to, mixed: choice.mixed }
    : undefined;
  return { rolloutCount, traceSessions: sessions.length, defaultTrace };
}

type FeedRun = { $: "Run"; requested: number; started: number; completed: number; status: string };
type ProviderSpan = { $: "ProviderSpan"; a: number; b: number; operation: string };
type CiPoll = { $: "CiPoll"; a: number; b: number };
type FeedThread = { $: "Thread"; created: number; updated: number; runs: List<FeedRun>; detail: List<ProviderSpan>; ci: List<CiPoll> };
type FeedSpan = { a: number; b: number; name: string };
type FeedTrace = { start: number; end: number; work: List<FeedSpan>; wait: List<FeedSpan>; errors: List<number>; detail: List<FeedSpan>; ci: List<FeedSpan> };
type FeedPolicy = { project_feed(threads: List<FeedThread>, asOf: number): { observed: number; traces: List<FeedTrace>;
  overview: List<FeedTrace>; from: number; as_of: number } };

const feedList = <T>(values: T[]): List<T> =>
  values.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

export async function projectPlowFeed(path: string, scratch: string, asOf = Date.now()) {
  const policy = await loadPolicy<FeedPolicy>(
    await buildPolicy(scratch, new URL("../analysis/plow-feed.bend", import.meta.url), "plow-feed.mjs"));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN");
    const threads = db.prepare("SELECT instance, thread_id, created_ms, updated_ms FROM t3_threads ORDER BY instance, thread_id").all();
    const runs = db.prepare(`SELECT requested_ms, started_ms, completed_ms, status FROM t3_runs
      WHERE instance=? AND thread_id=? ORDER BY run_id`);
    const spans = db.prepare(`SELECT s.start_ns,s.end_ns,s.operation FROM t3_live_codex_links t
      JOIN t3_live_codex_span_links l ON (l.codex_instance,l.session_id)=(t.codex_instance,t.session_id)
      JOIN codex_otel_spans s ON (s.instance,s.trace_id,s.span_id)=(l.codex_instance,l.trace_id,l.span_id)
      WHERE t.t3_instance=? AND t.thread_id=? ORDER BY s.start_ns,s.trace_id,s.span_id`);
    const ci = db.prepare(`SELECT p.poll_started_ms,p.poll_result_ms FROM t3_codex_links t
      JOIN codex_process_receipts p ON (p.instance,p.session_id)=(t.codex_instance,t.session_id)
      WHERE t.t3_instance=? AND t.thread_id=? ORDER BY p.poll_started_ms,p.poll_result_ms`);
    const ms = (ns: SQLOutputValue) => Number(BigInt(String(ns)) / 1000000n);
    const projected = policy.project_feed(feedList(threads.map(thread => ({
      $: "Thread", created: Number(thread.created_ms), updated: Number(thread.updated_ms),
      runs: feedList(runs.all(thread.instance, thread.thread_id).map(run => ({
        $: "Run", requested: Number(run.requested_ms), started: Number(run.started_ms),
        completed: Number(run.completed_ms), status: String(run.status),
      }))),
      detail: feedList(spans.all(thread.instance, thread.thread_id).map(span => ({
        $: "ProviderSpan", a: ms(span.start_ns), b: ms(span.end_ns), operation: String(span.operation),
      }))),
      ci: feedList(ci.all(thread.instance, thread.thread_id).map(poll => ({
        $: "CiPoll", a: Number(poll.poll_started_ms), b: Number(poll.poll_result_ms),
      }))),
    }))), asOf);
    const encodeSpans = (list: List<FeedSpan>) => rows(list).map(({ a, b, name }) => [a / 1000, b / 1000, name]);
    const encodeTraces = (list: List<FeedTrace>) => rows(list).map(trace => ({
      startUtcMs: trace.start, end: trace.end / 1000, work: encodeSpans(trace.work), wait: encodeSpans(trace.wait),
      errors: rows(trace.errors).map(at => at / 1000), detail: encodeSpans(trace.detail), ci: encodeSpans(trace.ci),
    }));
    return { observed: projected.observed, traces: encodeTraces(projected.traces),
      overview: { from: projected.from, to: projected.as_of, traces: encodeTraces(projected.overview) } };
  } finally {
    db.close();
  }
}
