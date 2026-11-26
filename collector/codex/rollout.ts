import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { CommandMix, List, Point, RolloutEvidence, ShellCommand, SourcePolicy, ToolInvocation } from "../../evidence/index.ts";
import { rolloutSyntax, type SyntaxPolicy } from "./rollout-syntax.ts";
import { bendValues, millis, point, row, str, toMillis, token, validMillis } from "../wire.ts";

type Receipt = { $: "NoReceipt" } | { $: "Receipt"; seconds: number; code: number; running: boolean };
type RolloutRecord = {
  id: string;
  record: Extract<ReturnType<SourcePolicy["call_record"]>, { $: "Observed" }>;
  link: ReturnType<SourcePolicy["cell_link"]>;
  sample: { $: "NoSample" } | { $: "Sample"; mix: Extract<CommandMix, { $: "Mix" }>; seconds: number };
};
type RolloutMetadata = { session: string; malformed: number };
type ReasoningMarker = { line: number; observed: Point; input: string };
type RolloutPolicy = SourcePolicy & SyntaxPolicy & {
  empty_rollout_calls(): unknown;
  accepts_model_script(name: string): boolean;
  rollout_needs_receipt(calls: unknown, id: string): boolean;
  rollout_timestamp(original: Point, envelope: Point): Point;
  empty_rollout_metadata(): RolloutMetadata;
  rollout_bad_line(meta: RolloutMetadata): RolloutMetadata;
  rollout_markers(meta: RolloutMetadata): List<ReasoningMarker>;
  rollout_metadata(meta: RolloutMetadata, envelope: string, kind: string, id: string,
    session: string, line: number, observed: Point): { state: RolloutMetadata; action: "" | "start" | "finish" | "conflict" };
  rollout_start(calls: unknown, id: string, line: number, name: string, stamp: Point, target: string,
    direct: List<ShellCommand>, wrapped: List<ToolInvocation>, sequential: List<ShellCommand>): unknown;
  rollout_finish(calls: unknown, id: string, stamp: Point, yielded: string, completed: boolean, receipt: Receipt): unknown;
  finish_rollout_calls(calls: unknown, malformed: number): { orphans: number; records: List<RolloutRecord> };
};

function outputHeader(output: unknown): string {
  const item = Array.isArray(output) ? output[0]?.text : output;
  return typeof item === "string" ? item.slice(0, 256).split("\n", 1)[0] : "";
}

function waitTarget(input: unknown): string {
  if (typeof input !== "string" || input.length > 1024) return "";
  try {
    const args = row(JSON.parse(input));
    const cell = str(args.cell_id);
    return /^[\w:.-]+$/.test(cell) ? cell : "";
  } catch { return ""; }
}

function execReceipt(output: unknown) {
  if (!Array.isArray(output) || output.length !== 2) return undefined;
  const [header, body] = output;
  if (header?.type !== "input_text" || body?.type !== "input_text" || typeof body.text !== "string" ||
      body.text.length > 256 * 1024 ||
      !/^Script completed\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/.test(str(header.text))) return undefined;
  try {
    const result = row(JSON.parse(body.text));
    const seconds = result.wall_time_seconds;
    const code = result.exit_code;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || typeof code !== "number" ||
        !Number.isInteger(code) || code < 0 || code > 255 || typeof result.chunk_id !== "string" ||
        typeof result.output !== "string" || !Number.isSafeInteger(result.original_token_count)) return undefined;
    return { $: "Receipt" as const, seconds, code, running: Object.hasOwn(result, "session_id") };
  } catch { return undefined; }
}

export async function readRollout(path: string, instance: string, rules: SourcePolicy): Promise<RolloutEvidence> {
  const policy = rules as RolloutPolicy;
  const syntax = await rolloutSyntax(policy);
  const file = await open(path);
  let calls = policy.empty_rollout_calls();
  let meta = policy.empty_rollout_metadata();
  let lineNumber = 0;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > 128 * 1024 * 1024) {
      throw Error("Expected one retained Codex rollout file of at most 128 MiB");
    }
    const lines = createInterface({ input: file.createReadStream({ end: info.size - 1, autoClose: false }),
      crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber++;
      let envelope, event;
      try {
        envelope = row(JSON.parse(line));
        event = envelope.type === "session_meta" || envelope.type === "response_item" || envelope.type === "event_msg"
          ? row(envelope.payload) : {};
      } catch { meta = policy.rollout_bad_line(meta); continue; }
      const envelopeType = str(envelope.type);
      const id = str(event.call_id);
      const session = envelopeType === "session_meta" ? token(event.id ?? event.session_id) : "";
      const original = (event.internal_chat_message_metadata_passthrough as { create_time?: unknown } | undefined)?.create_time;
      const originalTime = point(typeof original === "number" ? validMillis(Math.round(original * 1000)) : 0);
      const at = policy.rollout_timestamp(originalTime, point(millis(envelope.timestamp)));
      const { state, action } = policy.rollout_metadata(meta, envelopeType, str(event.type), id, session, lineNumber, at);
      meta = state;
      if (!action) continue;
      if (action === "conflict") throw Error("Rollout contains conflicting session IDs");
      if (action === "start") {
        const name = str(event.name);
        calls = policy.rollout_start(calls, id, lineNumber, name, at, waitTarget(event.arguments),
          syntax.direct(event.arguments), syntax.wrapped(event.input), policy.accepts_model_script(name) ? syntax.sequential(event.input) : { $: "Nil" });
      } else {
        const header = outputHeader(event.output);
        const yielded = /^Script running with cell ID ([\w:.-]+)/.exec(header)?.[1] ?? "";
        calls = policy.rollout_finish(calls, id, at, yielded, /^Script completed(?:\s|$)/.test(header),
          (policy.rollout_needs_receipt(calls, id) ? execReceipt(event.output) : undefined) ?? { $: "NoReceipt" });
      }
    }
  } finally {
    await file.close();
  }
  if (!meta.session) throw Error("Rollout contains no Codex session metadata");
  const summary = policy.finish_rollout_calls(calls, meta.malformed);
  const markers = Array.from(bendValues(policy.rollout_markers(meta)), ({ line, observed, input }) => ({
    line, at: toMillis(observed)!, ...(input ? { resultCall: input } : {}),
  }));
  const records = Array.from(bendValues(summary.records), ({ id, record, link, sample }) => ({
    id, line: record.line, tool: record.tool, command: record.command || null, categories: record.categories,
    start: toMillis(record.start), end: toMillis(record.finish), async: record.launched, ambiguous: record.ambiguous,
    mix: sample.$ === "Sample" ? { ...sample.mix, seconds: sample.seconds } : undefined,
    asyncEnd: link.$ === "Linked" ? toMillis(link.end) : null,
    terminalCall: link.$ === "Linked" ? link.call_id : null,
  }));
  return { instance: token(instance), session: meta.session, lines: lineNumber,
    malformed: meta.malformed, orphans: summary.orphans, calls: records, markers };
}
