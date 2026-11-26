import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { constants } from "node:fs";
import type { CallRecord, CommandMix, Point, ProcessInput, ProcessReceipt, RolloutAdmission, RolloutEvidence, RolloutImport, SourcePolicy } from "../../evidence/index.ts";
import { processReceipt, rolloutArguments, rolloutSyntax, sessionHandle } from "./rollout-syntax.ts";
import { millis, row, str, timeParts, token, validMillis } from "../wire.ts";

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

function callCoverage(policy: SourcePolicy, calls: RolloutEvidence["calls"], mixes: ReadonlyMap<string, CommandMix>,
  point: (timestamp: number) => Point) {
  return calls.reduce((quality, call) => policy.rollout_call_quality(quality, point(call.start ?? 0), point(call.end ?? 0),
    call.async, point(call.asyncEnd ?? 0), call.ambiguous, call.categories ?? "", mixes.get(call.id) ?? { $: "NoMix" },
    Boolean(call.mix)), {
    $: "Quality" as const, missing_start: 0, missing_end: 0, missing_async_end: 0, ambiguous_calls: 0,
    mix_candidates: 0, mix_receipts: 0, mixed_calls: 0, mixed_without_receipt: 0,
  });
}

const unseen = { $: "Unseen", orphans: 0 };
const noCell = { $: "NoCell" };
const noPair = { $: "Pair", launch: noCell, terminal: noCell, duplicate: false };

function point(timestamp: number): Point {
  const [s, ms] = timeParts(timestamp);
  return { $: "Time", s, ms };
}

const toMillis = ({ s, ms }: Point) => s ? s * 1000 + ms : null;

function outputHeader(output: unknown): string {
  const item = Array.isArray(output) ? output[0]?.text : output;
  return typeof item === "string" ? item.slice(0, 256).split("\n", 1)[0] : "";
}

function cellId(value: unknown): string {
  const id = str(value);
  return /^[\w:.-]+$/.test(id) ? id : "";
}

const absentReceipt: ProcessReceipt = { $: "MissingReceipt" };

export async function inspectRollout(path: string, instance: string, policy: SourcePolicy, source?: string):
  Promise<{ receipt: RolloutImport; data?: RolloutEvidence }> {
  const receipt = rolloutReceipt(instance, path, source);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!file) {
    receipt.status = policy.rollout_file_status(false, false, false, false);
    return { receipt };
  }
  const calls = new Map<string, unknown>();
  const mixes = new Map<string, CommandMix>();
  const inputs = new Map<string, ProcessInput>();
  const receipts = new Map<number, ProcessReceipt>();
  const directCalls = new Set<string>();
  const markers: RolloutEvidence["markers"] = [];
  let admission = awaitingMetadata;
  let clocks = { $: "Clocks" as const, first: point(0), last: point(0) };
  let previousResult = "";
  let readFailed = false;
  try {
    const info = await file.stat().catch(() => null);
    receipt.fileBytes = info?.size ?? null;
    receipt.status = policy.rollout_file_status(info !== null, info?.isFile() ?? false,
      info?.size === 0, (info?.size ?? 0) > fileLimit);
    if (receipt.status !== "scan" || !info) return { receipt };
    const syntax = await rolloutSyntax();
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
      if (!admission.keep) {
        previousResult = "";
        continue;
      }
      if (!decoded || decoded.malformed) { previousResult = ""; continue; }
      clocks = policy.rollout_clock(clocks, point(millis(envelope.timestamp)));
      const type = str(event.type);
      const id = str(event.call_id);
      const resultCall = previousResult;
      previousResult = policy.model_wait_input(previousResult, str(envelope.type), type, id);
      if (envelope.type !== "response_item") continue;
      const metadata = event.internal_chat_message_metadata_passthrough as { create_time?: unknown } | undefined;
      const original = metadata?.create_time;
      const timestamp = (typeof original === "number" ? validMillis(Math.round(original * 1000)) : 0) || millis(envelope.timestamp);
      const at = point(timestamp);
      if (policy.reasoning(type, at)) markers.push({ line: lineNumber, at: timestamp,
        ...(resultCall ? { resultCall } : {}) });
      if (type !== "function_call" && type !== "custom_tool_call" &&
          type !== "function_call_output" && type !== "custom_tool_call_output") continue;
      if (!/^[\w:-]+$/.test(id)) { receipt.malformed++; continue; }
      const state = calls.get(id) ?? unseen;
      if (type === "function_call" || type === "custom_tool_call") {
        const name = str(event.name);
        const args = rolloutArguments(event.arguments);
        const wrapped = syntax.wrapped(event.input);
        const observed = policy.tool(name, syntax.direct(args.cmd), wrapped);
        if (name === "exec") {
          const mix = policy.command_mix(syntax.sequential(event.input));
          if (mix.$ === "Mix") mixes.set(id, mix);
        }
        if (name === "exec_command" || name === "write_stdin") directCalls.add(id);
        if (!inputs.has(id)) inputs.set(id, policy.process_input(name, syntax.exact(args.cmd), wrapped, sessionHandle(args.session_id),
          !Object.hasOwn(args, "chars") || args.chars === "", observed));
        calls.set(id, policy.start_call(state, lineNumber, observed, at, cellId(args.cell_id)));
      } else {
        const header = outputHeader(event.output);
        const yielded = cellId(/^Script running with cell ID (\S+)$/.exec(header)?.[1]);
        const receipt = processReceipt(event.output, directCalls.has(id), policy);
        if (receipt.$ !== "MissingReceipt") receipts.set(lineNumber, receipt);
        calls.set(id, policy.finish_call(state, lineNumber, at, yielded, /^Script completed(?:\s|$)/.test(header)));
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
  const cells = new Map<string, unknown>();
  const observations = new Map<string, Extract<CallRecord, { $: "Observed" }>>();
  let orphans = 0;
  for (const [id, state] of calls) {
    const record = policy.call_record(state);
    orphans += record.orphans;
    if (record.$ === "Observed") observations.set(id, record);
    const fact = policy.cell_fact(id, state);
    if (fact.$ !== "NoCell") cells.set(fact.key, policy.add_cell_fact(cells.get(fact.key) ?? noPair, fact));
  }
  const clean = policy.clean_rollout(malformed, orphans);
  const links = new Map<string, { asyncEnd: number | null; terminalCall: string | null }>();
  for (const pair of cells.values()) {
    const link = policy.cell_link(pair, clean);
    if (link.$ === "Linked") links.set(link.owner, { asyncEnd: toMillis(link.end), terminalCall: link.call_id });
  }
  const waitAttribution: NonNullable<RolloutEvidence["waitAttribution"]> = { waits: [], observations: [] };
  const records: RolloutEvidence["calls"] = [];
  const processOperations = [];
  for (const [id, record] of observations) {
    const link = links.get(id) ?? { asyncEnd: null, terminalCall: null };
    const wait = policy.wait_cell(calls.get(id), cells.get(record.target) ?? noPair, clean);
    if (wait.$ === "WaitCell") waitAttribution.waits.push({
      call: id, cell: record.target || null, status: wait.status, owner: wait.owner || null,
    });
    const mix = mixes.get(id);
    const receipt = receipts.get(record.result_line) ?? absentReceipt;
    const measured = mix?.$ === "Mix" && receipt.$ === "ExitReceipt" &&
      policy.keep_mix_receipt(receipt.seconds, receipt.code, false,
        toMillis(record.finish) !== null, record.ambiguous) ? { ...mix, seconds: receipt.seconds } : undefined;
    records.push({ id, line: record.line, tool: record.tool, command: record.command || null, categories: record.categories,
      start: toMillis(record.start), end: toMillis(record.finish), async: record.launched, ambiguous: record.ambiguous,
      mix: measured, ...link });
    const input = inputs.get(id);
    if (!input || input.$ === "NoProcess") continue;
    const result = observations.get(link.terminalCall ?? id) ?? record;
    processOperations.push({ id, record, input, result, resultCall: link.terminalCall ?? id });
  }

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
      policy.valid_process_result(clean, ambiguous, record.start, result.finish));
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
    malformed, orphans, calls: records, markers, receipt, waitAttribution,
    quality: { ...callCoverage(policy, records, mixes, point), first: toMillis(clocks.first), last: toMillis(clocks.last) } } };
}

export async function readRollout(path: string, instance: string, policy: SourcePolicy): Promise<RolloutEvidence> {
  const { receipt, data } = await inspectRollout(path, instance, policy);
  if (!data) throw Error(`Rollout admission failed (${receipt.status})`);
  return data;
}
