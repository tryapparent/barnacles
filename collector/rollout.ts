import type { RolloutEvidence } from "../evidence/source-records.ts";
// Timestamp and call pairing adapted from Apparent's rollout census. See APPARENT-LICENSE.
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { SourcePolicy } from "../evidence/source-policy.ts";
import { millis, row, str, timeParts, token, validMillis } from "./wire.ts";

type Call = {
  id: string; line: number; tool: string; start: number; end: number | null;
  cell: string; waitedCell: string; terminal: boolean; ambiguous: boolean;
  asyncEnd: number | null; terminalCall: string | null;
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

export async function readRollout(path: string, instance: string, policy: SourcePolicy): Promise<RolloutEvidence> {
  const file = await open(path);
  const calls = new Map<string, Call>();
  let session = "";
  let lineNumber = 0;
  let malformed = 0;
  let orphans = 0;
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
      if (type === "function_call" || type === "custom_tool_call") {
        const existing = calls.get(id);
        if (existing) { existing.ambiguous = true; continue; }
        const tool = policy.tool_label(str(event.name));
        calls.set(id, { id, line: lineNumber, tool, start: timestamp, end: null, cell: "",
          waitedCell: tool === "cell wait" ? waitTarget(event.arguments) : "",
          terminal: false, ambiguous: false, asyncEnd: null, terminalCall: null });
        continue;
      }
      const call = calls.get(id);
      if (!call) { orphans++; continue; }
      if (call.end !== null) { call.ambiguous = true; continue; }
      if (!policy.interval_ms(...timeParts(call.start), ...timeParts(timestamp))) {
        call.ambiguous = true;
        continue;
      }
      call.end = timestamp;
      const header = outputHeader(event.output);
      if (call.tool === "tool wrapper") call.cell = /^Script running with cell ID ([\w:.-]+)/.exec(header)?.[1] ?? "";
      call.terminal = call.tool === "cell wait" && /^Script completed(?:\s|$)/.test(header);
    }
  } finally {
    await file.close();
  }
  if (!session) throw Error("Rollout contains no Codex session metadata");
  const launches = new Map<string, Call[]>();
  const completions = new Map<string, Call[]>();
  for (const call of calls.values()) {
    if (call.cell) launches.set(call.cell, [...(launches.get(call.cell) ?? []), call]);
    if (call.waitedCell && call.terminal) {
      completions.set(call.waitedCell, [...(completions.get(call.waitedCell) ?? []), call]);
    }
  }
  for (const [cell, owners] of launches) {
    const [launch] = owners;
    const ends = completions.get(cell) ?? [];
    const [terminal] = ends;
    if (terminal && launch.end !== null && terminal.end !== null && policy.async_end(
      ...timeParts(launch.end), ...timeParts(terminal.start),
      malformed === 0 && owners.length === 1 && ends.length === 1 && !launch.ambiguous && !terminal.ambiguous,
    )) {
      launch.asyncEnd = terminal.end;
      launch.terminalCall = terminal.id;
    }
  }
  return { instance: token(instance), session, lines: lineNumber, malformed, orphans,
    calls: [...calls.values()].map(({ id, line, tool, start, end, cell, ambiguous, asyncEnd, terminalCall }) =>
      ({ id, line, tool, start: start || null, end: ambiguous ? null : end,
        async: Boolean(cell), asyncEnd, terminalCall, ambiguous })) };
}
