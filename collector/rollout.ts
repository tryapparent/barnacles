// Timestamp and call pairing adapted from Apparent's rollout census. See APPARENT-LICENSE.
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { CommandMix, Point, RolloutEvidence, SourcePolicy } from "../evidence/sources.ts";
import { rolloutSyntax } from "./rollout-syntax.ts";
import { millis, row, str, timeParts, token, validMillis } from "./wire.ts";

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
    return { seconds, code, running: Object.hasOwn(result, "session_id") };
  } catch { return undefined; }
}

export async function readRollout(path: string, instance: string, policy: SourcePolicy): Promise<RolloutEvidence> {
  const syntax = await rolloutSyntax();
  const file = await open(path);
  const calls = new Map<string, unknown>();
  const mixes = new Map<string, CommandMix>();
  const receipts = new Map<string, NonNullable<ReturnType<typeof execReceipt>>>();
  const markers: RolloutEvidence["markers"] = [];
  let session = "";
  let lineNumber = 0;
  let malformed = 0;
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
        if (envelope.type !== "session_meta" && envelope.type !== "response_item") continue;
        event = row(envelope.payload);
      } catch { malformed++; continue; }
      if (envelope.type === "session_meta") {
        const observed = token(event.id ?? event.session_id);
        if (session && observed !== session) throw Error("Rollout contains conflicting session IDs");
        session = observed;
        continue;
      }
      if (!session) { malformed++; continue; }
      const type = str(event.type);
      const metadata = event.internal_chat_message_metadata_passthrough as { create_time?: unknown } | undefined;
      const original = metadata?.create_time;
      const timestamp = (typeof original === "number" ? validMillis(Math.round(original * 1000)) : 0) || millis(envelope.timestamp);
      const at = point(timestamp);
      if (policy.reasoning(type, at)) markers.push({ line: lineNumber, at: timestamp });
      if (type !== "function_call" && type !== "custom_tool_call" &&
          type !== "function_call_output" && type !== "custom_tool_call_output") continue;
      const id = str(event.call_id);
      if (!/^[\w:-]+$/.test(id)) { malformed++; continue; }
      const state = calls.get(id) ?? unseen;
      if (type === "function_call" || type === "custom_tool_call") {
        const observed = policy.tool(str(event.name), syntax.direct(event.arguments), syntax.wrapped(event.input));
        if (event.name === "exec") {
          const mix = policy.command_mix(syntax.sequential(event.input));
          if (mix.$ === "Mix") mixes.set(id, mix);
        }
        calls.set(id, policy.start_call(state, lineNumber, observed, at, waitTarget(event.arguments)));
      } else {
        const header = outputHeader(event.output);
        const yielded = /^Script running with cell ID ([\w:.-]+)/.exec(header)?.[1] ?? "";
        if (mixes.has(id)) {
          const receipt = execReceipt(event.output);
          if (receipt) receipts.set(id, receipt);
        }
        calls.set(id, policy.finish_call(state, at, yielded, /^Script completed(?:\s|$)/.test(header)));
      }
    }
  } finally {
    await file.close();
  }
  if (!session) throw Error("Rollout contains no Codex session metadata");
  const cells = new Map<string, unknown>();
  for (const [id, state] of calls) {
    const fact = policy.cell_fact(id, state);
    if (fact.$ !== "NoCell") cells.set(fact.key, policy.add_cell_fact(cells.get(fact.key) ?? noPair, fact));
  }
  const links = new Map<string, { asyncEnd: number | null; terminalCall: string | null }>();
  for (const pair of cells.values()) {
    const link = policy.cell_link(pair, malformed);
    if (link.$ === "Linked") links.set(link.owner, { asyncEnd: toMillis(link.end), terminalCall: link.call_id });
  }
  let orphans = 0;
  const records: RolloutEvidence["calls"] = [];
  for (const [id, state] of calls) {
    const record = policy.call_record(state);
    orphans += record.orphans;
    if (record.$ === "Ignored") continue;
    const mix = mixes.get(id);
    const receipt = receipts.get(id);
    const measured = mix?.$ === "Mix" && receipt &&
      policy.keep_mix_receipt(receipt.seconds, receipt.code, receipt.running,
        toMillis(record.finish) !== null, record.ambiguous) ? { ...mix, seconds: receipt.seconds } : undefined;
    records.push({ id, line: record.line, tool: record.tool, command: record.command || null, categories: record.categories, start: toMillis(record.start),
      end: toMillis(record.finish), async: record.launched, ambiguous: record.ambiguous,
      mix: measured,
      ...(links.get(id) ?? { asyncEnd: null, terminalCall: null }) });
  }
  return { instance: token(instance), session, lines: lineNumber, malformed, orphans, calls: records, markers };
}
