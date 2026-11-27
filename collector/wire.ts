import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { measureOutcomeDelay, type KernelCapture, type List, type Point, type T3Command } from "../evidence/index.ts";

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

export async function replayOutcomeDelays(file: string, scratch: string, window?: { from: number; to: number }): Promise<string> {
  const source = row(JSON.parse(boundedFile(file, 8 * 1024 * 1024).toString("utf8")));
  if (source.version !== 1) throw Error("Expected outcome-delay evidence version 1");
  const report = await measureOutcomeDelay(bendList(array(source.windows, 5000).map(delayWindow)), scratch, window);
  return JSON.stringify(report, (key, value) => {
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

export function stockT3Origin(endpoint: string) {
  const origin = new URL(endpoint);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname);
  if (!(origin.protocol === "https:" || loopback && origin.protocol === "http:") ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw Error("Expected an HTTPS T3 origin or a loopback HTTP origin");
  }
  return origin;
}

export function stockT3Id(value: unknown) {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9:._%-]*$/.test(value) ? value : "";
}

export function requireStockT3Id(value: unknown) {
  const id = stockT3Id(value);
  if (!id) throw Error("Invalid T3 history identifier");
  return id;
}

export async function stockT3Rpc(origin: URL, bearer: string, tag: string, payload: ObjectRow, limit: number, timeout = 8000) {
  const response = await fetch(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST", headers: { Authorization: `Bearer ${bearer}` }, redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SourceReadError(response.status);
  }
  const { ticket } = row(await boundedResponse(response, 8192).json());
  if (typeof ticket !== "string" || !ticket || ticket.length > 4096) throw Error("Invalid T3 websocket ticket");
  const address = new URL("/ws", origin);
  address.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  address.searchParams.set("orchestrationProtocol", "2");
  address.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(address);
  try {
    return await new Promise<ObjectRow>((fulfill, reject) => {
      function fail() { reject(Error("T3 read RPC failed")); }
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        _tag: "Request", id: "1", tag, payload, headers: [],
      })));
      socket.addEventListener("message", (message) => {
        try {
          if (typeof message.data !== "string" || message.data.length > limit) return fail();
          for (const item of [JSON.parse(message.data)].flat()) {
            const frame = row(item);
            if (frame._tag !== "Exit" || frame.requestId !== "1") continue;
            const result = row(frame.exit);
            if (result._tag !== "Success") return fail();
            fulfill(row(result.value));
          }
        } catch {
          fail();
        }
      });
      AbortSignal.timeout(timeout).addEventListener("abort", fail, { once: true });
    });
  } finally {
    socket.close();
  }
}

export function stockT3HistoryReader(endpoint: string, credential: string) {
  const origin = stockT3Origin(endpoint);
  const secret = boundedFile(credential, 8192).toString("utf8").trim();
  if (!/^[!-~]+$/.test(secret)) throw Error("Expected a T3 read bearer");
  const headers = { authorization: `Bearer ${secret}`, "x-t3-orchestration-protocol": "2" };
  async function get(url: URL, limit: number, timeout: number) {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceReadError(response.status);
    }
    return row(await boundedResponse(response, limit).json());
  }

  async function page(thread: string, cursor: string) {
    const url = new URL(`/api/orchestration/threads/${encodeURIComponent(thread)}`, origin);
    url.pathname += cursor ? "/history" : "/bounded";
    if (cursor) {
      url.searchParams.set("cursor", cursor);
      url.searchParams.set("view", "activity");
    } else {
      url.searchParams.set("dedupeBodies", "1");
    }
    return get(url, 8 * 1024 * 1024, 5000);
  }

  return { page, async inventory() {
    const bytes = 64 * 1024 * 1024;
    const [active, archived] = await Promise.all([
      get(new URL("/api/orchestration/shell", origin), bytes, 15000),
      stockT3Rpc(origin, secret, "orchestration.getArchivedShellSnapshot", {}, bytes, 15000),
    ]);
    const threads = (snapshot: ObjectRow) => array(snapshot.threads, 50_000).map(input => {
      const item = row(input);
      const updated = millis(item.updatedAt) || millis(item.createdAt);
      return { $: "Target" as const, id: requireStockT3Id(item.id), updated };
    });
    return [...threads(active), ...threads(archived)];
  } };
}

export type HistoryCodec = {
  observe(thread: string, kind: string, driver: string, strength: string, item: T3Command):
    { $: "Invalid" | "Skip" } | { $: "Keep"; command: T3Command };
  local_row(thread: string, owner: string, visibility: string): boolean;
  page_valid(previous: string, next: string, more: boolean): boolean;
  earliest(saved: number, at: number): number;
};

export function historyPage(policy: HistoryCodec, thread: string, page: ReturnType<typeof row>, cursor: string) {
  const next = cursor ? page.nextCursor : page.historyCursor;
  const sequence = page.snapshotSequence;
  if (!(next === null || typeof next === "string" && next.length <= 4096) ||
      typeof page.hasMoreHistory !== "boolean" || !policy.page_valid(cursor, next ?? "", page.hasMoreHistory) ||
      typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw Error("Invalid stock T3 page coordinates");
  }
  let items: unknown[];
  if (cursor) {
    items = array(page.items, 4096).map(row)
      .filter(item => policy.local_row(thread, str(item.sourceThreadId), str(item.visibility)))
      .map(item => item.item);
  } else {
    const projection = row(page.projection);
    if (row(projection.thread).id !== thread) throw Error("T3 snapshot belongs to another thread");
    items = array(projection.turnItems, 4096);
  }
  const commands: T3Command[] = [];
  let oldest = 0;
  for (const input of items) {
    const item = row(input);
    const ref = row(item.nativeItemRef ?? {});
    oldest = policy.earliest(oldest, millis(item.startedAt) || millis(item.completedAt) || millis(item.updatedAt));
    const result = policy.observe(thread, str(item.type), str(ref.driver), str(ref.strength), {
      $: "Command", id: stockT3Id(item.id), thread: stockT3Id(item.threadId), run: stockT3Id(item.runId),
      provider_thread: stockT3Id(item.providerThreadId), provider_turn: stockT3Id(item.providerTurnId),
      native_item: stockT3Id(ref.nativeId), status: str(item.status),
      exit_code: Number.isSafeInteger(item.exitCode) ? String(item.exitCode) : "",
      started: String(millis(item.startedAt)), completed: String(millis(item.completedAt)), updated: String(millis(item.updatedAt)),
    });
    if (result.$ === "Invalid") throw Error("Invalid native Codex command in T3 history");
    if (result.$ === "Keep") commands.push(result.command);
  }
  return { sequence, next: next ?? "", oldest, commands };
}


if (import.meta.main) import("./t3.ts").then(module => module.refreshAnalysis());
