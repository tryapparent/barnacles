import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { CodexOtelConflict, codexOtelPolicy, saveCodexOtel, type CodexOtelFact, type CodexOtelPolicy } from "../../evidence/index.ts";
import { T3OtelConflict, openT3Otel, t3OtelPolicy, type T3OtelSpan, type T3OtelPolicy } from "../../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { openT3History } from "../../evidence/index.ts";
import { array, bendList, bendValues, boundedFile, historyPage, row, SourceReadError, stockT3HistoryReader, requireStockT3Id, str, token, type HistoryCodec } from "../wire.ts";
import type { List } from "../../evidence/index.ts";

const bodyLimit = 8 * 1024 * 1024;

function arrayField(value: unknown) {
  return value === undefined ? [] : array(value, 4096);
}

function decodeAttributes(value: unknown) {
  const attributes = new Map<string, string>();
  for (const entry of arrayField(value)) {
    const { key, value } = row(entry);
    attributes.set(str(key), str(row(value).stringValue));
  }
  return (key: string) => attributes.get(key) ?? "";
}

function statusCode(value: unknown) {
  const code = value === undefined ? undefined : row(value).code;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 0xffffffff ? code : 0;
}

function decodeSpans(value: unknown, policy: CodexOtelPolicy) {
  const facts: CodexOtelFact[] = [];
  for (const resource of arrayField(row(value).resourceSpans)) {
    for (const scope of arrayField(row(resource).scopeSpans)) {
      for (const input of arrayField(row(scope).spans)) {
        const span = row(input);
        const attribute = decodeAttributes(span.attributes);
        const result = policy.observe_span(str(span.traceId), str(span.spanId), str(span.parentSpanId), str(span.name),
          str(span.startTimeUnixNano), str(span.endTimeUnixNano), attribute("conversation.id"), attribute("turn.id"),
          attribute("call_id"), statusCode(span.status));
        if (result.$ === "InvalidSpan") throw Error("Invalid trace span");
        if (result.$ !== "ObservedSpan") continue;
        const events: CodexOtelFact["events"] = [];
        for (const input of arrayField(span.events)) {
          const event = row(input);
          const attribute = decodeAttributes(event.attributes);
          const outcome = policy.observe_event(str(event.name), str(event.timeUnixNano), attribute("conversation.id"),
            attribute("turn.id"), attribute("call_id"), attribute("duration_ms"), attribute("success"));
          if (outcome.$ === "InvalidEvent") throw Error("Invalid trace event");
          if (outcome.$ === "ObservedEvent") events.push(outcome.fact);
        }
        facts.push({ span: result.fact, events });
      }
    }
  }
  return facts;
}

function decodeT3Spans(value: unknown, policy: T3OtelPolicy, instance: string) {
  const facts: T3OtelSpan[] = [];
  for (const input of arrayField(row(value).resourceSpans)) {
    const resource = row(input);
    const resourceAttributes = resource.resource === undefined ? undefined : row(resource.resource).attributes;
    const attributes = decodeAttributes(resourceAttributes);
    if (!policy.source_service(attributes("service.name"))) continue;
    if (!policy.source_instance(instance, attributes("plow.t3.instance"))) throw Error("Invalid trace source binding");
    for (const scope of arrayField(resource.scopeSpans)) {
      for (const input of arrayField(row(scope).spans)) {
        const span = row(input);
        const attribute = decodeAttributes(span.attributes);
        const parent = span.parentSpanId === undefined || span.parentSpanId === "" ? "" : str(span.parentSpanId) || "!";
        const result = policy.observe_span(str(span.traceId), str(span.spanId), parent, str(span.name),
          str(span.startTimeUnixNano), str(span.endTimeUnixNano), attribute("orchestration_v2.thread_id"),
          attribute("orchestration_v2.command_id"), attribute("orchestration_v2.command_type"));
        if (result.$ === "InvalidSpan") throw Error("Invalid trace span");
        if (result.$ === "ObservedSpan") facts.push(result.fact);
      }
    }
  }
  return facts;
}

async function readBody(request: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes <= bodyLimit) chunks.push(chunk);
  }
  return bytes <= bodyLimit ? Buffer.concat(chunks, bytes) : null;
}

function verifyBearer(received: string | undefined, expected: Buffer) {
  const header = Buffer.from(received ?? "");
  return header.length === expected.length && timingSafeEqual(header, expected);
}

async function compile<T>(directory: string, source: URL, name: string): Promise<T> {
  const scratch = mkdtempSync(join(directory, name + "-"));
  try {
    return await loadPolicy(await buildPolicy(scratch, source, name + ".mjs"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type EvidenceWriter = (value: unknown) => () => void;

function receive(port: number, host: string, secret: string, source: string, prepare: EvidenceWriter) {
  const bearer = Buffer.from(`Bearer ${secret}`);
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/traces") return response.writeHead(404).end();
    if (!verifyBearer(request.headers.authorization, bearer)) return response.writeHead(401).end();
    if (request.headers["content-type"] !== "application/json" || request.headers["content-encoding"]) {
      return response.writeHead(415).end();
    }
    if (Number(request.headers["content-length"]) > bodyLimit) return response.writeHead(413).end();
    let write: () => void;
    try {
      const body = await readBody(request);
      if (!body) return response.writeHead(413).end();
      write = prepare(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    } catch {
      if (source === "T3") console.warn("T3 OTLP rejected an invalid batch");
      return response.writeHead(400).end();
    }
    try {
      write();
    } catch (error) {
      if (error instanceof T3OtelConflict) console.warn("T3 OTLP rejected a conflicting batch");
      if (error instanceof CodexOtelConflict || error instanceof T3OtelConflict) return response.writeHead(409).end();
      console.error(`${source} OTLP evidence write failed`);
      return response.writeHead(503).end();
    }
    return response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address !== "string") console.log(`${source} OTLP evidence ready on ${host}:${address.port}`);
  });
  return server;
}

async function serveCodex([job, instance, ...extra]: string[]) {
  const port = Number(process.env.PLOW_OTLP_EVIDENCE_PORT ?? "4320");
  const secret = process.env.PLOW_OTLP_EVIDENCE_TOKEN ?? "";
  if (!job || !instance || extra.length || !Number.isInteger(port) || port < 0 || port > 65535 || secret.length < 32) {
    throw Error("Usage: PLOW_OTLP_EVIDENCE_TOKEN=<private secret of at least 32 characters> node collector/codex/otel.ts JOB_DIRECTORY INSTANCE");
  }
  const scope = token(instance);
  const directory = resolve(job);
  const database = join(directory, "evidence.sqlite");
  const policy = await compile<CodexOtelPolicy>(directory, codexOtelPolicy, "codex-otel");
  receive(port, "127.0.0.1", secret, "Codex", (value) => {
    const facts = decodeSpans(value, policy);
    return () => {
      if (facts.length) saveCodexOtel(database, scope, facts, policy);
    };
  });
}

async function serveT3([job, instance, ...extra]: string[]) {
  const port = Number(process.env.PLOW_T3_EVIDENCE_PORT ?? "4320");
  const host = process.env.PLOW_T3_EVIDENCE_HOST ?? "127.0.0.1";
  const credential = process.env.PLOW_T3_EVIDENCE_TOKEN_FILE ?? "/run/secrets/t3_backend";
  const secret = readFileSync(credential, "utf8").trim();
  if (!job || !instance || extra.length || !Number.isInteger(port) || port < 0 || port > 65535 ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(secret) || !["127.0.0.1", "0.0.0.0"].includes(host)) {
    throw Error("Invalid T3 OTLP evidence settings");
  }
  const scope = token(instance);
  const directory = resolve(job);
  const policy = await compile<T3OtelPolicy>(process.env.TMPDIR ?? directory, t3OtelPolicy, "t3-otel");
  const { save, close } = openT3Otel(join(directory, "evidence.sqlite"), scope, policy);
  const server = receive(port, host, secret, "T3", (value) => {
    const facts = decodeT3Spans(value, policy, scope);
    const ingestedMs = Date.now();
    return () => {
      if (facts.length) save(facts, ingestedMs);
    };
  });
  process.once("SIGTERM", () => server.close(close));
}

function t3HistoryTargets(env = process.env) {
  switch (env.PLOW_T3_HISTORY_SCOPE ?? "allowlist") {
    case "all": return null;
    case "allowlist": {
      const ids = [...new Set(array(JSON.parse(boundedFile(env.PLOW_T3_HISTORY_TARGETS_FILE ?? "", 20_000)
        .toString("utf8")), 32).map(requireStockT3Id))];
      if (!ids.length) throw Error("Configure at least one T3 history thread");
      return ids;
    }
    default: throw Error("Invalid T3 history scope");
  }
}

type Target = { $: "Target"; id: string; updated: number };
type Task = { $: "Task"; id: string; cursor: string; priority: number; revision: number; keep: boolean };
export type HistoryPolicy = HistoryCodec & {
  begin_scan(saved: string, head: string): string;
  replay: Parameters<typeof openT3History>[2];
  inventory(input: List<Target>): List<Target>;
  recent(input: List<Target>): List<Target>;
  plan(target: Target, cursor: string, known: boolean, revision: number, frontier: number, refresh: boolean):
    { $: "Some"; value: Task } | { $: "None" };
  batch(input: List<Task>): List<Task>;
  older_frontier(previous: number, oldest: number): number;
  pacing(previous: number, elapsed: number, failed: boolean): { workers: number; pause: number };
};

async function pollT3History([job, instance, flag, ...extra]: string[]) {
  if (!job || !instance || flag && flag !== "--once" || extra.length) throw Error("Invalid T3 history invocation");
  const targets = t3HistoryTargets();
  const source = stockT3HistoryReader(process.env.PLOW_T3_HISTORY_ORIGIN ?? "",
    process.env.PLOW_T3_HISTORY_READ_TOKEN_FILE ?? "/run/secrets/t3_history_read");
  const policy = await compile<HistoryPolicy>(process.env.TMPDIR ?? resolve(job),
    new URL("../t3-otel/history.bend", import.meta.url), "t3-history");
  const store = openT3History(join(resolve(job), "evidence.sqlite"), token(instance), policy.replay);
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  const wait = (ms: number) => sleep(ms, undefined, { signal: stop.signal }).catch(() => {});
  const read = async (id: string, cursor: string) => {
    try {
      return historyPage(policy, id, await source.page(id, cursor), cursor);
    } catch (error) {
      if (cursor && error instanceof SourceReadError && error.status === 400) store.commit(id, cursor, "", 0, [], null);
      throw error;
    }
  };
  let pace = policy.pacing(0, 0, false);
  try {
    do {
      const deadline = performance.now() + 900_000;
      const coverage = { headPages: 0, olderPages: 0, complete: 0, failed: 0 };
      if (targets) {
        for (const id of targets) {
          if (stop.signal.aborted) break;
          try {
            const saved = store.cursor(id);
            const head = await read(id, "");
            const cursor = policy.begin_scan(saved, head.next);
            store.commit(id, saved, cursor, head.sequence, head.commands);
            coverage.headPages++;
            if (cursor && !stop.signal.aborted) {
              const older = await read(id, cursor);
              store.commit(id, cursor, older.next, older.sequence, older.commands);
              coverage.olderPages++;
            }
            if (!store.cursor(id)) coverage.complete++;
          } catch { coverage.failed++; }
        }
      } else {
        let inventory: List<Target> = { $: "Nil" };
        try {
          inventory = policy.inventory(bendList(await source.inventory()));
        } catch {
          console.error("T3 thread discovery failed");
          coverage.failed++;
          pace = policy.pacing(pace.pause, 0, true);
        }
        const all = [...bendValues(inventory)];
        const refresh = new Set(flag ? [] : [...bendValues(policy.recent(inventory))].map(item => item.id));
        const deferred = new Set<string>();
        const checkpoints = store.checkpoints();
        console.log(JSON.stringify({ discovered: all.length }));
        let used = 0;
        const running = () => !stop.signal.aborted && performance.now() < deadline && (!flag || used < 32);
        while (running()) {
          const tasks: Task[] = [];
          for (const target of all) {
            if (deferred.has(target.id)) continue;
            const saved = checkpoints.get(target.id);
            const task = policy.plan(target, saved?.cursor ?? "", !!saved?.mark,
              saved?.mark?.revision ?? 0, saved?.mark?.frontier ?? 0, refresh.has(target.id));
            if (task.$ === "Some") tasks.push(task.value);
          }
          const batch = [...bendValues(policy.batch(bendList(tasks)))];
          if (!batch.length) break;
          for (let start = 0; start < batch.length && running();) {
            const wave = batch.slice(start, start + Math.min(pace.workers, flag ? 32 - used : pace.workers));
            start += wave.length;
            used += wave.length;
            const began = performance.now();
            const results = await Promise.all(wave.map(async ({ id, cursor, priority, revision, keep }) => {
              const saved = checkpoints.get(id)?.cursor ?? "";
              refresh.delete(id);
              try {
                const page = await read(id, cursor);
                const next = keep ? saved : page.next;
                const mark = { revision, frontier: policy.older_frontier(priority, page.oldest) };
                store.commit(id, saved, next, page.sequence, page.commands, keep ? undefined : mark);
                if (!keep) checkpoints.set(id, { cursor: next, mark });
                if (cursor) coverage.olderPages++;
                else coverage.headPages++;
                if (!next) coverage.complete++;
                return true;
              } catch {
                deferred.add(id);
                coverage.failed++;
                return false;
              }
            }));
            pace = policy.pacing(pace.pause, Math.floor(performance.now() - began), results.includes(false));
            if (running()) await wait(pace.pause);
          }
          console.log(JSON.stringify({ backfill: used, ...coverage }));
        }
      }
      console.log(JSON.stringify(coverage));
      if (flag) {
        if (coverage.failed) process.exitCode = 1;
        return;
      }
      await wait(targets ? 900_000 : Math.max(0, deadline - performance.now()));
    } while (!stop.signal.aborted);
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--t3-history") {
    try {
      await pollT3History(args.slice(1));
    } catch {
      console.error("T3 history collector startup failed");
      process.exitCode = 1;
    }
  } else if (args[0] === "--t3") {
    try {
      await serveT3(args.slice(1));
    } catch {
      console.error("T3 OTLP evidence startup failed");
      process.exitCode = 1;
    }
  } else {
    await serveCodex(args);
  }
}
