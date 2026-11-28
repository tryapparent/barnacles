import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";

type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
type Binding = { $: "T3Binding"; owner: string; driver: string; native_driver: string; strength: string; session: string };
type Run = { $: "T3Run"; owner: string; id: string; started: string; completed: string };
type Policy = { t3_run(thread: string, requested: string, refs: List<Binding>, runs: List<Run>): string };

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid T3 response");
  return input as Record<string, unknown>;
}

function list<T>(input: unknown, cap: number, decode: (input: unknown) => T): List<T> {
  if (!Array.isArray(input) || input.length > cap) throw Error("Invalid or oversized T3 result list");
  return input.reduceRight<List<T>>((tail, entry) => ({ $: "Con", head: decode(entry), tail }), { $: "Nil" });
}

const text = (input: unknown) => typeof input === "string" ? input : "";
const ms = (input: unknown) => String(Date.parse(text(input)));

export async function projectT3Run(scratch: string, thread: string, requested: string, input: unknown) {
  const projection = object(object(input).projection);
  if (object(projection.thread).id !== thread) throw Error("T3 response belongs to another thread");
  const ref = list<Binding>(projection.providerThreads, 64, value => {
    const item = object(value);
    const native = object(item.nativeThreadRef ?? {});
    return { $: "T3Binding", owner: text(item.appThreadId), driver: text(item.driver),
      native_driver: text(native.driver), strength: text(native.strength), session: text(native.nativeId) };
  });
  const runs = list<Run>(projection.runs, 4096, value => {
    const item = object(value);
    return { $: "T3Run", owner: text(item.threadId), id: text(item.id),
      started: ms(item.startedAt), completed: ms(item.completedAt) };
  });
  const module = await buildPolicy(scratch, new URL("../project.bend", import.meta.url), "t3-run.mjs");
  const policy = await loadPolicy<Policy>(module);
  const result = policy.t3_run(thread, requested, ref, runs);
  if (!result) throw Error("T3 run or Codex session binding is missing or ambiguous");
  return result;
}

async function read(origin: string, token: string, thread: string) {
  const url = new URL("/api/orchestration/threads/" + encodeURIComponent(thread) + "/bounded", origin);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
    throw Error("Use HTTPS or a loopback fixture T3 origin");
  }
  url.searchParams.set("dedupeBodies", "1");
  const response = await fetch(url, { headers: { authorization: "Bearer " + token, "x-t3-orchestration-protocol": "2" },
    redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) throw Error("T3 snapshot query failed with HTTP " + response.status);
  const reader = response.body.getReader();
  const blocks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const block = await reader.read();
      if (block.done) break;
      bytes += block.value.length;
      if (bytes > 8 * 1024 * 1024) throw Error("T3 snapshot exceeded 8 MiB");
      blocks.push(block.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(blocks)));
}

if (import.meta.main) {
  const [thread, run, ...extra] = process.argv.slice(2);
  const { PLOW_T3_ORIGIN: origin, PLOW_T3_READ_TOKEN_FILE: tokenFile } = process.env;
  if (!origin || !tokenFile || !thread || !run || extra.length) {
    throw Error("Set PLOW_T3_ORIGIN and PLOW_T3_READ_TOKEN_FILE and pass THREAD RUN");
  }
  const scratch = mkdtempSync("/tmp/apparent-dev-plow-t3-run-");
  try {
    const data = await read(origin, readFileSync(tokenFile, "utf8").trim(), thread);
    process.stdout.write(await projectT3Run(scratch, thread, run, data) + "\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
