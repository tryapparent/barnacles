import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { KernelCapture, List, Point } from "../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";

export type ObjectRow = Record<string, unknown>;

export function row(value: unknown): ObjectRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected a source object");
  return value as ObjectRow;
}

export function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw Error("Invalid or oversized source array");
  return value;
}

export function str(value: unknown): string {
  return typeof value === "string" && value.length <= 128 ? value : "";
}

export function token(value: unknown): string {
  const input = str(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(input)) throw Error("Invalid source identifier");
  return input;
}

export function clockSecond(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw Error("Expected an unsigned Unix second");
  }
  return value;
}

export function factText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Error("Expected a bounded fact label");
  }
  return value;
}

export function bendBool(value: unknown): boolean {
  if (typeof value !== "boolean") throw Error("Expected a boolean fact");
  return value;
}

export function sha(value: unknown): string {
  const input = str(value);
  if (!/^[0-9a-f]{40}$/.test(input)) throw Error("Expected a full commit SHA");
  return input;
}

export function millis(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return 0;
  const parsed = Date.parse(value);
  return validMillis(parsed);
}

export function validMillis(value: number): number {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff * 1000 ? value : 0;
}

export function seconds(value: unknown): number {
  return Math.floor(millis(value) / 1000);
}

export const timeParts = (ms: number): [number, number] => [Math.floor(ms / 1000), ms % 1000];

export function bendList<T>(values: T[]): List<T> {
  return values.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
}

export function* bendValues<T>(values: List<T>): Generator<T> {
  for (let next = values; next.$ === "Con"; next = next.tail) yield next.head;
}

export function point(timestamp: number): Point {
  const [s, ms] = timeParts(timestamp);
  return { $: "Time", s, ms };
}

export function toMillis({ s, ms }: Point): number | null {
  return s ? s * 1000 + ms : null;
}

export function kernelInteger(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw Error("Invalid kernel event coordinate");
  return number;
}

export function boundedFile(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw Error("Expected a bounded capture file");
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset !== info.size) throw Error("Capture changed during the read");
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function delayClock(value: unknown): number {
  if (value == null || value === 0) return 0;
  if (typeof value !== "number" || !validMillis(value)) throw Error("Invalid outcome-delay clock");
  return value;
}

const optionalToken = (value: unknown) => value == null || value === "" ? "" : token(value);

function delayBlocker(value: unknown) {
  const b = row(value);
  return { $: "Blocker", occurrence: token(b.occurrence), pattern: token(b.pattern), condition: optionalToken(b.condition),
    scope: optionalToken(b.scope), fromMs: delayClock(b.fromMs), untilMs: delayClock(b.untilMs),
    pending: optionalToken(b.pending), released: optionalToken(b.released) };
}

function delayWindow(value: unknown) {
  const w = row(value);
  return { $: "DelayWindow", id: token(w.id), outcome: token(w.outcome), scope: optionalToken(w.scope), stage: token(w.stage),
    basis: optionalToken(w.basis), readyMs: delayClock(w.readyMs), possibleMs: delayClock(w.possibleMs),
    readiness: optionalToken(w.readiness), availability: optionalToken(w.availability),
    blockers: bendList(array(w.blockers, 64).map(delayBlocker)) };
}

export async function replayOutcomeDelays(file: string, scratch: string): Promise<string> {
  const source = row(JSON.parse(boundedFile(file, 8 * 1024 * 1024).toString("utf8")));
  if (source.version !== 1) throw Error("Expected outcome-delay evidence version 1");
  const windows = bendList(array(source.windows, 5000).map(delayWindow));
  const policy = await loadPolicy<{ outcome_delays(windows: typeof windows): unknown }>(
    await buildPolicy(scratch, new URL("../evidence/analysis/outcome-delay.bend", import.meta.url), "outcome-delay.mjs"));
  return JSON.stringify(policy.outcome_delays(windows), (key, value) => {
    if (key === "$") return undefined;
    if (value?.$ === "Nil" || value?.$ === "Con") return Array.from(bendValues(value));
    if (value?.$ === "None") return null;
    if (value?.$ === "Some") return value.value;
    return value;
  }, 2);
}

export function kernelCapture(anchorPath: string, eventsPath: string, diagnosticsPath: string): KernelCapture {
  const bytes = boundedFile(eventsPath, 256 * 1024);
  const capture = createHash("sha256").update(bytes).digest("hex");
  const anchor = row(JSON.parse(boundedFile(anchorPath, 4096).toString("utf8")));
  if (anchor.eventsSha256 !== capture) throw Error("Capture checksum differs from the binding");
  const lines = bytes.toString("utf8").trimEnd().split("\n").filter(Boolean);
  if (lines.shift() !== "ready" || lines.pop() !== "done" || lines.length > 4096) {
    throw Error("Expected a bounded observer receipt with ready and done markers");
  }
  const events = lines.reduceRight<KernelCapture["events"]>((tail, line) => {
    const event = /^(root|fork|exec|exit) (\d{1,20}) (\d{1,10})(?: ([a-z0-9_-]{1,16}))?$/.exec(line);
    if (!event) throw Error("Invalid kernel event row");
    const [, kind, clock, subject, detail] = event;
    const at = kernelInteger(Number(BigInt(clock) / 1000n));
    const pid = kernelInteger(subject);
    if (kind === "fork") return { $: "Con", head: { $: "ProcessFork", at, parent: pid, pid: kernelInteger(detail) }, tail };
    if (kind === "exec" && detail) return { $: "Con", head: { $: "ProcessExec", at, pid, image: detail }, tail };
    if (!detail && (kind === "root" || kind === "exit")) {
      return { $: "Con", head: { $: kind === "root" ? "ProcessRoot" : "ProcessExit", at, pid }, tail };
    }
    throw Error("Invalid kernel event shape");
  }, { $: "Nil" });
  return { capture, instance: token(anchor.instance), session: token(anchor.session), call: token(anchor.call),
    start: millis(anchor.startedAt), line: kernelInteger(anchor.line), events, count: lines.length,
    quiet: boundedFile(diagnosticsPath, 16384).length === 0 };
}

export class SourceReadError extends Error {
  readonly status: number;
  readonly limited: boolean;
  readonly expired: boolean;
  readonly budget: boolean;

  constructor(status: number, limited = false, expired = false, budget = false) {
    super(status ? `Source read failed (HTTP ${status})` : "Source read failed or request budget exhausted");
    this.status = status;
    this.limited = limited;
    this.expired = expired;
    this.budget = budget;
  }
}

export function boundedResponse(response: Response, limit: number): Response {
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, stream) {
      bytes += chunk.byteLength;
      if (bytes > limit) stream.error(Error("Source response exceeded the size limit"));
      else stream.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, headers: response.headers });
}

async function mcpReply(response: Response, id: number) {
  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) return row(await response.json());
  if (!response.body) throw Error("Missing MCP reply stream");
  const events = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const chunk = await events.read();
      if (chunk.done) throw Error("Missing MCP response");
      pending += chunk.value;
      const frames = pending.split(/\r?\n\r?\n|\r\r/);
      pending = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) {
          const reply = row(JSON.parse(data));
          if (reply.id === id) return reply;
        }
      }
    }
  } finally {
    await events.cancel().catch(() => {});
  }
}

export function t3HistoryReader(env = process.env) {
  let endpoint: URL;
  let secret: string;
  try {
    endpoint = new URL(env.PLOW_T3_HISTORY_MCP_URL ?? "");
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
    if ((!loopback || endpoint.protocol !== "http:") && endpoint.protocol !== "https:") throw Error();
    if (endpoint.username || endpoint.password || endpoint.hash) throw Error();
    secret = boundedFile(env.PLOW_T3_HISTORY_CREDENTIAL_FILE ?? "", 8192).toString("utf8").trim();
    if (!secret) throw Error();
  } catch {
    throw new SourceReadError(401);
  }

  const deadline = performance.now() + 45_000;
  const offered = "2025-06-18";
  let protocol = "";
  let session = "";
  let id = 0;
  async function post(method: string, params: unknown, notification = false) {
    const time = Math.floor(deadline - performance.now());
    if (time <= 0 || id >= 11) throw new SourceReadError(0, false, false, true);
    const requestId = notification ? undefined : ++id;
    const headers = new Headers({
      "content-type": "application/json", accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
    });
    if (protocol) headers.set("mcp-protocol-version", protocol);
    if (session) headers.set("mcp-session-id", session);
    const response = await fetch(endpoint, { method: "POST", headers, redirect: "error",
      signal: AbortSignal.timeout(Math.min(time, 10_000)),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceReadError(response.status, response.status === 403 && response.headers.has("retry-after"),
        !!session && response.status === 404);
    }
    if (notification) {
      await response.body?.cancel();
      return {};
    }
    const reply = await mcpReply(boundedResponse(response, 512 * 1024), requestId!);
    if (reply.id !== requestId || reply.jsonrpc !== "2.0" || reply.error) throw Error("Invalid or failed T3 RPC response");
    if (method === "initialize") session = response.headers.get("mcp-session-id") ?? "";
    return row(reply.result);
  }

  return async (name: "t3_environment_read" | "t3_project_read" | "t3_thread_read", args: ObjectRow) => {
    if (!protocol) {
      const initialized = await post("initialize", {
        protocolVersion: offered, capabilities: {}, clientInfo: { name: "plow-history", version: "1" },
      });
      if (initialized.protocolVersion !== offered && initialized.protocolVersion !== "2025-03-26") {
        throw Error("Unsupported T3 MCP protocol version");
      }
      protocol = initialized.protocolVersion;
      await post("notifications/initialized", {}, true);
    }
    const result = await post("tools/call", { name, arguments: args });
    if (result.isError === true) throw Error("T3 did not return coverage for the requested target");
    return row(result.structuredContent);
  };
}
