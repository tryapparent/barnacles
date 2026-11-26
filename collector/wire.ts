import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { KernelCapture } from "../evidence/index.ts";

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

export { repository } from "../evidence/index.ts";

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

export function kernelInteger(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw Error("Invalid kernel event coordinate");
  return number;
}

function boundedFile(path: string, limit: number) {
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
