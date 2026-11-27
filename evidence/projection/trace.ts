import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
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

type HistoryEvent = { $: "HistoryEvent"; index: number; lane: number; start: number; end: Optional<number>;
  label: string; source: string; state: string; relation: string; clipped: boolean };
type HistorySignal = { $: "HistorySignal"; rule: string; thread: string; id: string; seconds: number; median: number; peers: number; event: Optional<number> };
type HistoryThread = { $: "HistoryThread"; id: string; sample: number; title: string; source: string;
  start: number; cutoff: number; rollout_count: number };
type HistoryEntry = { $: "HistoryEntry"; thread: HistoryThread; end: number; count: number; signals: number };
type HistoryLane = { $: "HistoryLane"; index: number; name: string; events: List<HistoryEvent> };
type HistoryProjection = { entry: HistoryEntry; lanes: List<HistoryLane>; signals: List<HistorySignal> };
type HistoryPolicy = {
  session_window_valid(start: number, cutoff: number, snapshot: number): boolean;
  project_session(thread: HistoryThread, events: List<HistoryEvent>, signals: List<HistorySignal>): HistoryProjection;
  order_sessions(entries: List<HistoryEntry>): List<HistoryEntry>;
};

const t3Source = /t3-thread:\/\/v2\/[a-f0-9-]{36}\/(?:[a-f0-9-]{36}|[a-z]+:[a-z]+:[a-f0-9]{64})(?=\)|$)/;
const githubSource = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:actions\/(?:runs|jobs)\/\d+(?:\/(?:attempts|job)\/\d+)?|pull\/\d+(?:#pullrequestreview-\d+)?|commit\/[a-f0-9]{40})$/;
const invalidStudy = () => Error("Invalid session study export. Use the frozen waterfall JSON and its matching replay.");
const studyRows = (value: unknown, limit: number): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) throw invalidStudy();
  return value;
};
const studyRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidStudy();
  return value as Record<string, unknown>;
};
const studyString = (value: unknown, limit: number): string => {
  if (typeof value !== "string" || value.length > limit) throw invalidStudy();
  return value;
};
const studyNumber = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalidStudy();
  return value;
};
const historyList = <T>(values: T[]): List<T> =>
  values.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

function studyMillis(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidStudy();
  return studyNumber(Math.round(value));
}

function studyEvent(raw: unknown, index: number): HistoryEvent {
  const [lane, start, end, label, source, state, relation, clipped] = studyRows(raw, 8);
  if (typeof clipped !== "boolean") throw invalidStudy();
  const ref = studyString(source, 512);
  const rolloutLine = /[.]jsonl(?:[.]zst)?:([1-9]\d*)$/.exec(ref);
  return { $: "HistoryEvent", index, lane: studyNumber(lane), start: studyMillis(start),
    end: end === null ? { $: "None" } : { $: "Some", value: studyMillis(end) },
    label: studyString(label, 512), source: githubSource.test(ref) || /^T3 position \d+$/.test(ref) ? ref : (rolloutLine ? "Rollout line " + rolloutLine[1] : ""),
    state: studyString(state, 128), relation: studyString(relation, 32), clipped };
}

function studySignal(raw: unknown): HistorySignal {
  const { thread, id, rule, seconds, median, peers } = studyRecord(raw);
  return { $: "HistorySignal", rule: studyString(rule, 128), thread: studyString(thread, 128),
    id: studyString(id, 256), seconds: studyNumber(seconds), median: studyNumber(median), peers: studyNumber(peers), event: { $: "None" } };
}

export async function writeSessionStudy(directory: string, capture: string, replay?: string) {
  const loadStudy = (path: string) => {
    const file = statSync(path);
    if (!file.isFile() || file.size > 64 * 1024 * 1024) throw invalidStudy();
    return studyRecord(JSON.parse(readFileSync(path, "utf8")));
  };
  const data = loadStudy(capture);
  const cutoff = studyNumber(data.cutoff, 8.64e15);
  const signals = historyList(replay ? studyRows(loadStudy(replay).findings, 20000).map(studySignal) : []);
  const staging = mkdtempSync(join(directory, ".session-study-"));
  try {
    const module = await buildPolicy(staging, new URL("../analysis/session-history.bend", import.meta.url), "session-study.mjs");
    const policy = await loadPolicy<HistoryPolicy>(module);
    const file = join(staging, "session-study.sqlite");
    closeSync(openSync(file, "wx", 0o600));
    const db = new DatabaseSync(file);
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE study(cutoff INTEGER NOT NULL, replay INTEGER NOT NULL);
        CREATE TABLE histories(id TEXT PRIMARY KEY, sample INTEGER UNIQUE NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE sessions(rank INTEGER PRIMARY KEY, entry TEXT NOT NULL);`);
      db.prepare("INSERT INTO study VALUES (?, ?)").run(cutoff, Number(replay !== undefined));
      const storeHistory = db.prepare("INSERT INTO histories VALUES (?, ?, ?)");
      const storeEntry = db.prepare("INSERT INTO sessions VALUES (?, ?)");
      const entries = studyRows(data.threads, 1000).map((raw) => {
        const item = studyRecord(raw);
        const source = t3Source.exec(studyString(item.link, 1024));
        if (!source) throw invalidStudy();
        const thread: HistoryThread = { $: "HistoryThread", id: createHash("sha256").update(source[0]).digest("hex"), source: source[0],
          sample: studyNumber(item.i), title: studyString(item.title, 512), start: studyNumber(item.start, cutoff),
          cutoff: studyNumber(item.cutoff, cutoff), rollout_count: studyNumber(item.rollouts) };
        if (!policy.session_window_valid(thread.start, thread.cutoff, cutoff)) throw invalidStudy();
        const history = policy.project_session(thread, historyList(studyRows(item.events, 40000).map(studyEvent)), signals);
        storeHistory.run(thread.id, thread.sample, JSON.stringify({
          entry: history.entry,
          lanes: rows(history.lanes).map((lane) => ({ ...lane, events: rows(lane.events) })),
          signals: rows(history.signals),
        }));
        return history.entry;
      });
      rows(policy.order_sessions(historyList(entries))).forEach((entry, rank) => storeEntry.run(rank, JSON.stringify(entry)));
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    renameSync(file, join(directory, "session-study.sqlite"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function readSessionStudy(directory: string, session?: string) {
  const file = join(directory, "session-study.sqlite");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    if (!statSync(file, { throwIfNoEntry: false })) return { study: null, sessions: [], trace: null };
    throw error;
  }
  try {
    const metadata = db.prepare("SELECT * FROM study").get();
    if (!metadata) throw invalidStudy();
    const study = { cutoff: Number(metadata.cutoff), replay: metadata.replay === 1 };
    if (session !== undefined) {
      const row = db.prepare("SELECT payload FROM histories WHERE id=?").get(session);
      return { study, trace: row ? JSON.parse(String(row.payload)) : null };
    }
    const sessions = db.prepare("SELECT entry FROM sessions ORDER BY rank").all().map((row) => JSON.parse(String(row.entry)));
    return { study, sessions };
  } finally {
    db.close();
  }
}
