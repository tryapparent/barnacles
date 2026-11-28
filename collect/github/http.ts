import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export type Row = Record<string, unknown>;
export type Reply = { data: unknown; next: number; last: number; cooldown: number };
export class SourceError extends Error {
  status: number;
  limited: boolean;
  retryAt: number;
  invalid: boolean;

  constructor(status = 0, limited = false, retryAt = 0, invalid = false) {
    super("GitHub source read failed");
    this.status = status;
    this.limited = limited;
    this.retryAt = retryAt;
    this.invalid = invalid;
  }
}
export class Budget extends Error {
  constructor() { super("GitHub request budget reached"); }
}

export function object(input: unknown): Row {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SourceError(0, false, 0, true);
  return input as Row;
}

export function rows(input: unknown): Row[] {
  if (!Array.isArray(input) || input.length > 100) throw new SourceError(0, false, 0, true);
  return input.map(object);
}

export const text = (input: unknown) => typeof input === "string" && input.length <= 256 ? input : "";
export const id = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) ? String(input) : text(input);
export const u32 = (input: unknown) => Number.isInteger(input) && Number(input) >= 0 && Number(input) <= 0xffffffff
  ? Number(input) : 0;
export const count = (input: unknown) => {
  if (input !== 0 && !u32(input)) throw new SourceError(0, false, 0, true);
  return u32(input);
};

export function clock(input: unknown): number {
  const raw = text(input);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(raw)) return 0;
  const parsed = Date.parse(raw);
  if (parsed <= 0 || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw.replace(/(?<!\.\d{3})Z$/, ".000Z")) return 0;
  return parsed;
}

export const seconds = (input: unknown) => u32(Number(Math.floor(clock(input) / 1000)));
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const iso = (value: number) => new Date(value * 1000).toISOString().replace(".000Z", "Z");

export function credential(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || (metadata.mode & 0o077) || metadata.size < 1 || metadata.size > 4096) {
      throw Error("GitHub credential must be a private bounded regular file");
    }
    const value = readFileSync(fd, "utf8").trim();
    if (!/^[a-zA-Z0-9_.-]{1,4096}$/.test(value)) throw Error("Invalid GitHub credential format");
    return value;
  } finally {
    closeSync(fd);
  }
}

function pagination(headers: Headers, source: URL) {
  const links = { next: 0, last: 0 };
  for (const link of (headers.get("link") ?? "").split(/,\s*(?=<)/)) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|last)"\s*$/.exec(link);
    if (!match) continue;
    const url = new URL(match[1], source);
    const page = u32(Number(url.searchParams.get("page")));
    const relation = match[2] as "next" | "last";
    if (url.origin !== source.origin || !page || links[relation]) throw new SourceError(0, false, 0, true);
    links[relation] = page;
  }
  return links;
}

async function body(response: Response) {
  if (!response.body) throw new SourceError(0, false, 0, true);
  const reader = response.body.getReader();
  const blocks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      size += read.value.length;
      if (size > 8 * 1024 * 1024) throw new SourceError(0, false, 0, true);
      blocks.push(read.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(blocks)),
    (_key, value, context) => typeof value === "number" && !Number.isSafeInteger(value) && /^\d+$/.test(context?.source ?? "")
      ? context.source : value);
}

function retryAt(headers: Headers, now: number, limited: boolean) {
  const retry = headers.get("retry-after");
  const after = retry && /^\d+$/.test(retry) ? now + Number(retry) : Math.ceil(Date.parse(retry ?? "") / 1000);
  const reset = limited ? Number(headers.get("x-ratelimit-reset")) : 0;
  return Math.max(u32(after), u32(reset ? reset + 1 : 0), limited ? now + 60 : 0);
}

export function github(origin: string, token: string, requests: number) {
  const base = new URL(origin);
  if ((base.origin !== "https://api.github.com" && !(base.protocol === "http:" && base.hostname === "127.0.0.1")) ||
      base.href !== base.origin + "/") throw Error("Use the GitHub API or a loopback HTTP fixture");
  const deadline = performance.now() + 120_000;
  let remaining = requests;
  return async (repo: string, endpoint: string): Promise<Reply> => {
    const time = Math.floor(deadline - performance.now());
    if (remaining-- <= 0 || time < 1) throw new Budget();
    const prefix = "/repos/" + repo + "/";
    const url = new URL(prefix + endpoint, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) throw Error("GitHub request escaped repository scope");
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(Math.min(time, 10_000)),
        headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json",
          "user-agent": "plow-github-history", "x-github-api-version": "2022-11-28" } });
      const now = nowSeconds();
      let limited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0"
        || (response.status === 403 && response.headers.has("retry-after"));
      if (!response.ok) {
        if (response.status === 403 && !limited) {
          const error = await body(response).catch(() => null);
          const message = error && typeof error === "object" ? text(error.message) : "";
          limited = /secondary rate limit|abuse detection/i.test(message);
        } else {
          await response.body?.cancel();
        }
        throw new SourceError(response.status, limited, retryAt(response.headers, now, limited));
      }
      return { ...pagination(response.headers, base), data: await body(response),
        cooldown: limited ? retryAt(response.headers, now, limited) : 0 };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError();
    }
  };
}
