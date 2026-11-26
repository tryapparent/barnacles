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

function scriptShape(input: unknown): [string, boolean, string] {
  if (typeof input !== "string") return ["", false, ""];
  const head = input.slice(0, 8192).replace(/^\/\/ @exec: [^\n]*\n/, "").trimStart();
  const first = head.replace(/^(?:(?:const|let) [\w$]+\s*=\s*|(?:text|image|audio|generatedImage)\(\s*)/, "")
    .replace(/^\(\s*/, "");
  const method = /^await\s+tools\.([\w$]+)\s*\(/.exec(first)?.[1] ?? "";
  const command = /^await\s+tools\.\w+\s*\(\s*\{\s*(?:cmd|"cmd"|'cmd')\s*:\s*(?:"((?:[^"\\\r\n]|\\.)*)"|'((?:[^'\\\r\n]|\\.)*)'|`((?:[^`\\]|\\[\s\S])*)`)\s*[,}]/.exec(first);
  const literal = command?.[1] ?? command?.[2] ?? command?.[3] ?? "";
  return [method, /^await\s+Promise\.all(?:Settled)?\s*\(\s*\[/.test(first), literal];
}

function commandArgument(input: unknown): string {
  if (typeof input !== "string" || input.length > 65536) return "";
  try {
    const cmd = row(JSON.parse(input)).cmd;
    return typeof cmd === "string" ? cmd.slice(0, 256) : "";
  } catch { return ""; }
}

function commandWords(command: string): [string, string] {
  const match = /^[ \t]*([a-z][\w-]*)(?=$|[ \t\r\n;&|<>])(?:[ \t]+([\w-]+)(?=$|[ \t\r\n;&|<>]))?/.exec(command);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

export async function readRollout(path: string, instance: string, policy: SourcePolicy): Promise<RolloutEvidence> {
  const file = await open(path);
  const calls = new Map<string, unknown>();
  const markers: RolloutEvidence["markers"] = [];
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
        const [wrapped, parallel, literal] = scriptShape(event.input);
        const observed = policy.tool(str(event.name), wrapped, parallel,
          ...commandWords(type === "function_call" ? commandArgument(event.arguments) : literal));
        calls.set(id, policy.start_call(state, lineNumber, observed, at, waitTarget(event.arguments)));
      } else {
        const header = outputHeader(event.output);
        const yielded = /^Script running with cell ID ([\w:.-]+)/.exec(header)?.[1] ?? "";
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
    records.push({ id, line: record.line, tool: record.tool, command: record.command || null, start: toMillis(record.start),
      end: toMillis(record.finish), async: record.launched, ambiguous: record.ambiguous,
      ...(links.get(id) ?? { asyncEnd: null, terminalCall: null }) });
  }
  return { instance: token(instance), session, lines: lineNumber, malformed, orphans, calls: records, markers };
}
