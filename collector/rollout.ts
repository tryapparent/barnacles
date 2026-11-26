// Timestamp and call pairing adapted from Apparent's rollout census. See APPARENT-LICENSE.
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Point, RolloutEvidence, SourcePolicy } from "../evidence/sources.ts";
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

export async function readRollout(path: string, instance: string, policy: SourcePolicy): Promise<RolloutEvidence> {
  const file = await open(path);
  const calls = new Map<string, unknown>();
  let session = "";
  let lineNumber = 0;
  let malformed = 0;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size === 0 || info.size > 64 * 1024 * 1024) {
      throw Error("Expected one retained Codex rollout file of at most 64 MiB");
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
      const type = event.type;
      if (type !== "function_call" && type !== "custom_tool_call" &&
          type !== "function_call_output" && type !== "custom_tool_call_output") continue;
      const id = str(event.call_id);
      if (!/^[\w:-]+$/.test(id)) { malformed++; continue; }
      const metadata = event.internal_chat_message_metadata_passthrough as { create_time?: unknown } | undefined;
      const original = metadata?.create_time;
      const timestamp = typeof original === "number" ? validMillis(Math.round(original * 1000)) : millis(envelope.timestamp);
      const state = calls.get(id) ?? unseen;
      if (type === "function_call" || type === "custom_tool_call") {
        calls.set(id, policy.start_call(state, lineNumber, str(event.name), point(timestamp), waitTarget(event.arguments)));
      } else {
        const header = outputHeader(event.output);
        const yielded = /^Script running with cell ID ([\w:.-]+)/.exec(header)?.[1] ?? "";
        calls.set(id, policy.finish_call(state, point(timestamp), yielded, /^Script completed(?:\s|$)/.test(header)));
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
    records.push({ id, line: record.line, tool: record.tool, start: toMillis(record.start),
      end: toMillis(record.finish), async: record.launched, ambiguous: record.ambiguous,
      ...(links.get(id) ?? { asyncEnd: null, terminalCall: null }) });
  }
  return { instance: token(instance), session, lines: lineNumber, malformed, orphans, calls: records };
}
