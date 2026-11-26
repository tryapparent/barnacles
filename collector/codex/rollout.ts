import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { constants } from "node:fs";
import type { CommandMix, List, Point, ProcessInput, ProcessReceipt, RolloutAdmission, RolloutImport, RolloutEvidence, ShellCommand, SourcePolicy, ToolInvocation } from "../../evidence/index.ts";
import { processReceipt, rolloutArguments, rolloutSyntax, sessionHandle, type SyntaxPolicy } from "./rollout-syntax.ts";
import { bendValues, millis, point, row, str, toMillis, token, validMillis } from "../wire.ts";

type Receipt = { $: "NoReceipt" } | { $: "Receipt"; seconds: number; code: number; running: boolean };
type RolloutRecord = {
  id: string;
  record: Extract<ReturnType<SourcePolicy["call_record"]>, { $: "Observed" }>;
  candidate: CommandMix;
  link: ReturnType<SourcePolicy["cell_link"]>;
  sample: { $: "NoSample" } | { $: "Sample"; mix: Extract<CommandMix, { $: "Mix" }>; seconds: number };
};
type RolloutMetadata = { session: string; malformed: number };
type ReasoningMarker = { line: number; observed: Point; input: string };
type RolloutPolicy = SourcePolicy & SyntaxPolicy & {
  empty_rollout_calls(): unknown;
  accepts_model_script(name: string): boolean;
  rollout_timestamp(original: Point, envelope: Point): Point;
  empty_rollout_metadata(): RolloutMetadata;
  rollout_clear_result(meta: RolloutMetadata, session: string): RolloutMetadata;
  rollout_markers(meta: RolloutMetadata): List<ReasoningMarker>;
  rollout_metadata(meta: RolloutMetadata, envelope: string, kind: string, id: string,
    session: string, line: number, observed: Point): { state: RolloutMetadata; action: "" | "start" | "finish" | "conflict" };
  rollout_start(calls: unknown, id: string, line: number, name: string, stamp: Point, target: string,
    direct: List<ShellCommand>, wrapped: List<ToolInvocation>, sequential: List<ShellCommand>): unknown;
  rollout_finish(calls: unknown, id: string, line: number, stamp: Point, yielded: string, completed: boolean, receipt: Receipt): unknown;
  finish_rollout_calls(calls: unknown, malformed: number): { orphans: number; records: List<RolloutRecord>; cells: unknown; clean: boolean };
  rollout_wait(calls: unknown, id: string, target: string, cells: unknown, clean: boolean): ReturnType<SourcePolicy["wait_cell"]>;
};

const fileLimit = 128 * 1024 * 1024;
const lineLimit = 8 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function rolloutReceipt(instance: string, path: string, source?: string): RolloutImport {
  const sourceKey = source === undefined ? createHash("sha256").update(resolve(path)).digest("hex") : token(source);
  return { instance: token(instance), sourceKey, status: "unavailable", session: null,
    parent: null, historyStartOrdinal: null, fileBytes: null, readBytes: 0, lines: 0, inherited: 0, unassigned: 0,
    malformed: 0, oversized: 0, cutoffLines: 0, cutoffBytes: 0 };
}

const awaitingMetadata: RolloutAdmission = {
  $: "Gate", status: "awaiting_metadata", session: "", parent: "", boundary: 0, inherited: 0, unassigned: 0, keep: false,
};

function identifier(value: unknown) {
  try { return token(value); }
  catch { return ""; }
}

function admitLine(policy: SourcePolicy, state: RolloutAdmission, envelope: Record<string, unknown>,
  event: Record<string, unknown>, line: number, decoded: boolean) {
  const meta = envelope.type === "session_meta";
  const value = meta ? event.subagent_history_start_ordinal : undefined;
  const boundary = Number.isInteger(value) && Number(value) > 0 && Number(value) < 0xffffffff ? Number(value)
    : value === undefined || value === null || value === 0 ? 0 : 0xffffffff;
  return policy.rollout_line(state, meta, meta ? identifier(event.id ?? event.session_id) : "",
    meta ? identifier(event.parent_thread_id) : "", meta ? identifier(event.forked_from_id) : "",
    meta ? identifier(event.session_id) : "", boundary, line, decoded && envelope.ordinal === line - 1, decoded);
}

function decodeLine(bytes: Buffer) {
  const envelope = row(JSON.parse(decoder.decode(bytes)));
  const type = str(envelope.type);
  if (!type) throw Error("Missing rollout record type");
  try {
    const event = type === "session_meta" || type === "response_item" || type === "event_msg" ? row(envelope.payload) : {};
    return { envelope, event, malformed: false };
  } catch {
    return { envelope, event: {}, malformed: true };
  }
}

async function* boundedLines(file: FileHandle, size: number, receipt: RolloutImport) {
  let segments: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of file.createReadStream({ end: size - 1, autoClose: false })) {
    receipt.readBytes += chunk.length;
    for (let start = 0; start < chunk.length;) {
      const lf = chunk.indexOf(10, start);
      const end = lf === -1 ? chunk.length : lf;
      bytes += end - start;
      if (bytes <= lineLimit) segments.push(chunk.subarray(start, end));
      if (lf === -1) break;
      receipt.lines++;
      yield bytes <= lineLimit ? Buffer.concat(segments, bytes) : null;
      segments = [];
      bytes = 0;
      start = lf + 1;
    }
  }
  receipt.cutoffLines = Number(bytes > 0);
  receipt.cutoffBytes = bytes;
}

function outputHeader(output: unknown): string {
  const item = Array.isArray(output) ? output[0]?.text : output;
  return typeof item === "string" ? item.slice(0, 256).split("\n", 1)[0] : "";
}

function cellId(value: unknown): string {
  const id = str(value);
  return /^[\w:.-]+$/.test(id) ? id : "";
}

const absentReceipt: ProcessReceipt = { $: "MissingReceipt" };

export async function inspectRollout(path: string, instance: string, rules: SourcePolicy, source?: string):
  Promise<{ receipt: RolloutImport; data?: RolloutEvidence }> {
  const policy = rules as RolloutPolicy;
  const receipt = rolloutReceipt(instance, path, source);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) {
    receipt.status = policy.rollout_file_status(false, false, false, false);
    return { receipt };
  }
  let calls = policy.empty_rollout_calls();
  let meta = policy.empty_rollout_metadata();
  const inputs = new Map<string, ProcessInput>();
  const receipts = new Map<number, ProcessReceipt>();
  const directCalls = new Set<string>();
  let admission = awaitingMetadata;
  let clocks = { $: "Clocks" as const, first: point(0), last: point(0) };
  let readFailed = false;
  try {
    const info = await file.stat().catch(() => null);
    receipt.fileBytes = info?.size ?? null;
    receipt.status = policy.rollout_file_status(info !== null, info?.isFile() ?? false,
      info?.size === 0, (info?.size ?? 0) > fileLimit);
    if (receipt.status !== "scan" || !info) return { receipt };
    const syntax = await rolloutSyntax(policy);
    for await (const bytes of boundedLines(file, info.size, receipt)) {
      const lineNumber = receipt.lines;
      let decoded;
      if (bytes) {
        try { decoded = decodeLine(bytes); }
        catch { receipt.malformed++; }
      } else {
        receipt.oversized++;
      }
      if (decoded?.malformed) receipt.malformed++;
      const { envelope, event } = decoded ?? { envelope: {}, event: {} };
      admission = admitLine(policy, admission, envelope, event, lineNumber, Boolean(decoded && !decoded.malformed));
      if (!admission.keep || !decoded || decoded.malformed) {
        meta = policy.rollout_clear_result(meta, admission.session);
        continue;
      }
      clocks = policy.rollout_clock(clocks, point(millis(envelope.timestamp)));
      const envelopeType = str(envelope.type);
      const id = str(event.call_id);
      const original = (event.internal_chat_message_metadata_passthrough as { create_time?: unknown } | undefined)?.create_time;
      const originalTime = point(typeof original === "number" ? validMillis(Math.round(original * 1000)) : 0);
      const at = policy.rollout_timestamp(originalTime, point(millis(envelope.timestamp)));
      const { state, action } = policy.rollout_metadata(meta, envelopeType, str(event.type), id, admission.session, lineNumber, at);
      receipt.malformed += state.malformed - meta.malformed;
      meta = state;
      if (!action) continue;
      if (action === "conflict") throw Error("Rollout contains conflicting session IDs");
      if (action === "start") {
        const name = str(event.name);
        const args = rolloutArguments(event.arguments);
        const direct = syntax.direct(args.cmd);
        const wrapped = syntax.wrapped(event.input);
        if (name === "exec_command" || name === "write_stdin") directCalls.add(id);
        if (!inputs.has(id)) inputs.set(id, policy.process_input(name, syntax.exact(args.cmd), wrapped, sessionHandle(args.session_id),
          !Object.hasOwn(args, "chars") || args.chars === "", policy.tool(name, direct, wrapped)));
        calls = policy.rollout_start(calls, id, lineNumber, name, at, cellId(args.cell_id), direct, wrapped,
          policy.accepts_model_script(name) ? syntax.sequential(event.input) : { $: "Nil" });
      } else {
        const header = outputHeader(event.output);
        const yielded = cellId(/^Script running with cell ID (\S+)$/.exec(header)?.[1]);
        const observed = processReceipt(event.output, directCalls.has(id), policy);
        if (observed.$ !== "MissingReceipt") receipts.set(lineNumber, observed);
        calls = policy.rollout_finish(calls, id, lineNumber, at, yielded, /^Script completed(?:\s|$)/.test(header),
          observed.$ === "ExitReceipt" ? { $: "Receipt", seconds: observed.seconds, code: observed.code, running: false } : { $: "NoReceipt" });
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "syscall" in error)) throw error;
    readFailed = true;
  } finally {
    await file.close();
  }
  receipt.status = policy.rollout_status(admission, receipt.lines, !readFailed && receipt.readBytes === receipt.fileBytes);
  receipt.session = admission.session || null;
  receipt.parent = admission.parent || null;
  receipt.historyStartOrdinal = admission.boundary || null;
  receipt.inherited = admission.inherited;
  receipt.unassigned = admission.unassigned;
  if (!policy.rollout_admitted(receipt.status)) return { receipt };
  const malformed = policy.rollout_pairing_gaps(receipt.malformed, receipt.oversized, receipt.cutoffLines, receipt.unassigned);
  const summary = policy.finish_rollout_calls(calls, malformed);
  const markers = Array.from(bendValues(policy.rollout_markers(meta)), ({ line, observed, input }) => ({
    line, at: toMillis(observed)!, ...(input ? { resultCall: input } : {}),
  }));
  let quality = {
    $: "Quality" as const, missing_start: 0, missing_end: 0, missing_async_end: 0, ambiguous_calls: 0,
    mix_candidates: 0, mix_receipts: 0, mixed_calls: 0, mixed_without_receipt: 0,
  };
  const rows = Array.from(bendValues(summary.records));
  const observations = new Map(rows.map(({ id, record }) => [id, record]));
  const waitAttribution: NonNullable<RolloutEvidence["waitAttribution"]> = { waits: [], observations: [] };
  const processOperations = [];
  const records = rows.map(({ id, record, link, candidate, sample }) => {
    const wait = policy.rollout_wait(calls, id, record.target, summary.cells, summary.clean);
    if (wait.$ === "WaitCell") waitAttribution.waits.push({
      call: id, cell: record.target || null, status: wait.status, owner: wait.owner || null,
    });
    const input = inputs.get(id);
    const terminalCall = link.$ === "Linked" ? link.call_id : null;
    if (input && input.$ !== "NoProcess") {
      const resultCall = terminalCall ?? id;
      processOperations.push({ id, record, input, result: observations.get(resultCall) ?? record, resultCall });
    }
    quality = policy.rollout_call_quality(quality, record.start, record.finish, record.launched,
      link.$ === "Linked" ? link.end : point(0), record.ambiguous, record.categories, candidate, sample.$ === "Sample");
    return {
      id, line: record.line, tool: record.tool, command: record.command || null, categories: record.categories,
      start: toMillis(record.start), end: toMillis(record.finish), async: record.launched, ambiguous: record.ambiguous,
      mix: sample.$ === "Sample" ? { ...sample.mix, seconds: sample.seconds } : undefined,
      asyncEnd: link.$ === "Linked" ? toMillis(link.end) : null,
      terminalCall,
    };
  });

  const slots = new Map<string, ReturnType<SourcePolicy["process_result"]>["slot"]>();
  let barrier = 0;
  for (const { id, record, input, result, resultCall } of processOperations.sort(
    (a, b) => (a.result.result_line || a.record.line) - (b.result.result_line || b.record.line),
  )) {
    const receipt = receipts.get(result.result_line) ?? absentReceipt;
    const handle = policy.process_key(input, receipt);
    const ambiguous = record.ambiguous || result.ambiguous;
    const slot = policy.observed_slot(slots.get(handle) ?? { $: "Vacant" }, barrier);
    const step = policy.process_result(input, slot, receipt, id,
      record.line, record.start, result.result_line, result.finish,
      policy.valid_process_result(summary.clean, ambiguous, record.start, result.finish));
    if (policy.process_barrier(input, receipt, handle, ambiguous)) barrier = result.result_line || record.line;
    if (handle) slots.set(handle, step.slot);
    const extra = policy.process_taint(input, receipt);
    if (extra) slots.set(extra, { $: "Conflict" });
    waitAttribution.observations.push({
      call: id, resultCall: result.result_line ? resultCall : null, resultLine: result.result_line || null,
      handle: handle || null, fact: step.fact, observer: policy.process_observer(step.fact),
      start: toMillis(record.start), end: toMillis(result.finish),
    });
  }
  return { receipt, data: { instance: receipt.instance, session: admission.session, lines: receipt.lines,
    malformed, orphans: summary.orphans, calls: records, markers, receipt, waitAttribution,
    quality: { ...quality, first: toMillis(clocks.first), last: toMillis(clocks.last) } } };
}

export async function readRollout(path: string, instance: string, policy: SourcePolicy): Promise<RolloutEvidence> {
  const { receipt, data } = await inspectRollout(path, instance, policy);
  if (!data) throw Error(`Rollout admission failed (${receipt.status})`);
  return data;
}
