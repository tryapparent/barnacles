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
