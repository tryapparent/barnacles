import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";

type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
type ReplayEvent = { $: "ReplayEvent"; name: string; at: string; conversation: string; turn: string;
  call: string; duration: string; success: string };
type ReplaySpan = { $: "ReplaySpan"; id: string; parent: string; name: string; start: string; end: string;
  status: number; conversation: string; turn: string; call: string; events: List<ReplayEvent> };
type ReplayExisting = { $: "ReplayExisting"; trace: string; id: string; parent: string; start: string; end: string; service: string;
  scope: string; source: string; coverage: string };
type Plan = { $: "ReplaySkipped"; reason: string } | { $: "ReplayReady"; body: string };
type Policy = {
  trace_limit(): number;
  span_limit(): number;
  event_limit(): number;
  manifest(instance: string, first: string, last: string, cutover: string, ids: List<string>): boolean;
  plan(trace: string, spans: List<ReplaySpan>, first: string, last: string, events: number): Plan;
  skipped_action(reason: string, hasCheckpoint: boolean): string;
  confirmed(trace: string, spans: List<ReplaySpan>, existing: List<ReplayExisting>): boolean;
  next_action(trace: string, spans: List<ReplaySpan>, existing: List<ReplayExisting>, state: string,
    identical: boolean, retry: boolean): string;
};
type Trace = { id: string; spans: ReplaySpan[]; events: number };
type Manifest = { instance: string; fromNs: string; toNs: string; liveSinceNs: string; traceIds: string[] };
type Destination = { query: URL; ingest: URL; directory: string; retry: boolean };

class ReplayError extends Error {}
const fail = (message: string): never => { throw new ReplayError(message); };
const sqliteBusy = (error: unknown) => error instanceof Error && "errcode" in error &&
  (error.errcode === 5 || error.errcode === 6);
const str = (value: unknown): string => typeof value === "string" ? value : "";
const decimal = (value: unknown): string => typeof value === "number" ? String(value) : "";
const list = <T>(items: T[]): List<T> => items.reduceRight<List<T>>(
  (tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a JSON object");
  return value as Record<string, unknown>;
};
const repeated = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : fail("Expected a repeated wire field");

function readManifest(file: string, policy: Policy): Manifest {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const max = 16 * 1024;
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) fail("Expected a regular manifest of at most 16 KiB");
    const bytes = Buffer.alloc(max + 1);
    const count = readSync(fd, bytes);
    if (count > max) fail("Manifest exceeds the byte limit");
    const value = record(JSON.parse(bytes.subarray(0, count).toString("utf8")));
    const { instance, fromNs, toNs, liveSinceNs, traceIds } = value;
    if (!Array.isArray(traceIds) || traceIds.length > policy.trace_limit() ||
        !policy.manifest(str(instance), str(fromNs), str(toNs), str(liveSinceNs), list(traceIds.map(str)))) {
      fail("Manifest requires a source instance, distinct native trace IDs, and a historical interval within the replay limits");
    }
    return value as Manifest;
  } finally {
    closeSync(fd);
  }
}

function readTraces(file: string, manifest: Manifest, policy: Policy): Trace[] {
  if (!lstatSync(file).isFile()) fail("Expected a regular source SQLite file");
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN");
    const spans = source.prepare(`SELECT span_id,parent_span_id,operation,start_ns,end_ns,status_code,
        conversation_id,turn_id,call_id FROM codex_otel_spans
        WHERE instance=? AND trace_id=? ORDER BY span_id LIMIT ?`);
    const events = source.prepare(`SELECT span_id,event,observed_ns,conversation_id,turn_id,call_id,
        reported_duration_ms,success FROM codex_otel_span_events
        WHERE instance=? AND trace_id=? ORDER BY span_id,event_index LIMIT ?`);
    return manifest.traceIds.map(id => {
      const rows = spans.all(manifest.instance, id, policy.span_limit() + 1);
      const eventRows = events.all(manifest.instance, id, policy.event_limit() + 1);
      const bySpan = new Map<string, ReplayEvent[]>();
      for (const row of eventRows) {
        const id = str(row.span_id);
        const group = bySpan.get(id) ?? [];
        group.push({
          $: "ReplayEvent", name: str(row.event), at: str(row.observed_ns),
          conversation: str(row.conversation_id), turn: str(row.turn_id), call: str(row.call_id),
          duration: decimal(row.reported_duration_ms),
          success: row.success === 1 ? "true" : row.success === 0 ? "false" : "",
        });
        bySpan.set(id, group);
      }
      const decoded: ReplaySpan[] = rows.map(row => ({
        $: "ReplaySpan", id: str(row.span_id), parent: row.parent_span_id === null ? "" : str(row.parent_span_id) || "!",
        name: str(row.operation), start: str(row.start_ns), end: str(row.end_ns),
        status: Number.isSafeInteger(row.status_code) && Number(row.status_code) >= 0 &&
          Number(row.status_code) <= 0xffffffff ? Number(row.status_code) : 0xffffffff,
        conversation: str(row.conversation_id), turn: str(row.turn_id), call: str(row.call_id),
        events: list(bySpan.get(str(row.span_id)) ?? []),
      }));
      return { id, spans: decoded, events: eventRows.length };
    });
  } catch (error) {
    if (sqliteBusy(error)) fail("Source SQLite is busy. Use a verified read-only snapshot or retry during a quiet interval");
    throw error;
  } finally {
    source.close();
  }
}

function endpoint(value: string | undefined): URL {
  if (!value) fail("Apply requires explicit Tempo loopback endpoints");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    fail("Expected a bare http://127.0.0.1 origin with an explicit port");
  }
  return url;
}

async function tempoJson(url: URL, method: "GET" | "POST", body?: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      method, body, redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json", ...(body && { "content-type": "application/json" }) },
    });
  } catch {
    return fail(`Tempo ${method} request failed or timed out`);
  }
  if (response.status !== 200 || !response.body || !response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    return fail(`Unexpected Tempo ${method} response (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4 * 1024 * 1024) fail("Tempo response exceeds the byte limit");
      chunks.push(next.value);
    }
    return record(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
  } catch {
    await reader.cancel().catch(() => {});
    return fail(`Could not decode bounded Tempo ${method} response`);
  }
}

function wireId(value: unknown): string {
  const encoded = str(value);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.toString("base64") === encoded ? bytes.toString("hex") : fail("Invalid Tempo identifier encoding");
}

async function lookup(query: URL, id: string): Promise<List<ReplayExisting>> {
  const url = new URL(`/api/v2/traces/${id}`, query);
  const response = await tempoJson(url, "GET");
  if (![undefined, "COMPLETE", 0].includes(response.status as string | number | undefined) ||
      response.message || !response.metrics) {
    return fail("Tempo lookup did not establish a complete result");
  }
  const spans: ReplayExisting[] = [];
  const groups = record(response.trace);
  for (const rawGroup of repeated(groups.resourceSpans)) {
    const group = record(rawGroup);
    const resource = record(group.resource ?? {});
    const attributes = new Map(repeated(resource.attributes).map(raw => {
      const { key, value } = record(raw);
      return [str(key), str(record(value).stringValue)] as const;
    }));
    for (const rawScope of repeated(group.scopeSpans)) {
      const scope = record(rawScope);
      const scopeName = str(record(scope.scope ?? {}).name);
      for (const item of repeated(scope.spans)) {
        const span = record(item);
        spans.push({
          $: "ReplayExisting", trace: wireId(span.traceId), id: wireId(span.spanId),
          parent: wireId(span.parentSpanId), start: str(span.startTimeUnixNano), end: str(span.endTimeUnixNano),
          service: attributes.get("service.name") ?? "", scope: scopeName,
          source: attributes.get("plow.replay.source") ?? "",
          coverage: attributes.get("plow.replay.coverage") ?? "",
        });
      }
    }
  }
  return list(spans);
}

function privateDatabase(directory: string, name: string) {
  const path = join(directory, name);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.uid !== process.getuid?.() || (existing.mode & 0o077))) {
    fail("Checkpoint files must be private regular files owned by the caller");
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
  return new DatabaseSync(path);
}

async function withDestination(destination: Destination, work: (db: DatabaseSync) => Promise<void>) {
  const { directory, query, ingest } = destination;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    fail("Expected a private checkpoint directory owned by the caller");
  }
  const lock = privateDatabase(directory, "writer.sqlite");
  try {
    try {
      lock.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (sqliteBusy(error)) fail("A replay process already holds the destination checkpoint");
      throw error;
    }
    const checkpoint = privateDatabase(directory, "checkpoint.sqlite");
    try {
      checkpoint.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS destination (key INTEGER PRIMARY KEY CHECK(key=1), query TEXT NOT NULL, ingest TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS replay (trace_id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL) STRICT;`);
      checkpoint.prepare("INSERT OR IGNORE INTO destination VALUES (1,?,?)").run(query.origin, ingest.origin);
      const bound = checkpoint.prepare("SELECT query,ingest FROM destination WHERE key=1").get();
      if (bound?.query !== query.origin || bound.ingest !== ingest.origin) fail("Checkpoint belongs to another destination");
      await work(checkpoint);
    } finally {
      checkpoint.close();
    }
  } finally {
    lock.close();
  }
}

async function transfer(trace: Trace, body: string, target: Destination, db: DatabaseSync, policy: Policy) {
  const digest = createHash("sha256").update(body).digest("hex");
  const prior = db.prepare("SELECT digest,state FROM replay WHERE trace_id=?").get(trace.id);
  const save = db.prepare(`INSERT INTO replay VALUES (?,?,?)
    ON CONFLICT(trace_id) DO UPDATE SET state=excluded.state`);
  const spans = list(trace.spans);
  const existing = await lookup(target.query, trace.id);
  const action = policy.next_action(trace.id, spans, existing, str(prior?.state), prior?.digest === digest, target.retry);
  switch (action) {
    case "already-present":
    case "checkpointed":
      return action;
    case "confirmed":
      save.run(trace.id, digest, "done");
      return "recovered";
    case "write": {
      save.run(trace.id, digest, "pending");
      const response = await tempoJson(new URL("/v1/traces", target.ingest), "POST", body);
      const partial = record(response.partialSuccess ?? {});
      if (![undefined, "0", 0].includes(partial.rejectedSpans as string | number | undefined) || partial.errorMessage) {
        return fail("Tempo reported partial acceptance. Checkpoint remains pending");
      }
      if (!policy.confirmed(trace.id, spans, await lookup(target.query, trace.id))) {
        return fail("Tempo did not confirm the exact replay. Checkpoint remains pending");
      }
      save.run(trace.id, digest, "done");
      return "written";
    }
    default:
      return fail(`Replay stopped (${action})`);
  }
}

export async function runReplay(args: string[]) {
  const { values } = parseArgs({ args, options: {
    source: { type: "string" }, manifest: { type: "string" },
    apply: { type: "boolean" }, quiescent: { type: "boolean" }, "retry-pending": { type: "boolean" },
    query: { type: "string" }, ingest: { type: "string" }, checkpoint: { type: "string" },
  } });
  const { source, manifest, apply, quiescent, query, ingest, checkpoint, "retry-pending": retry } = values;
  if (!source || !manifest) return fail("Required arguments are --source and --manifest");
  if (apply && (!quiescent || !checkpoint)) {
    return fail("Apply requires --quiescent confirmation for the selected IDs and a private --checkpoint directory");
  }
  if (!apply && (quiescent || query || ingest || checkpoint || retry)) return fail("Destination and retry options require --apply");
  const target = apply ? {
    query: endpoint(query), ingest: endpoint(ingest), directory: resolve(checkpoint!), retry: retry ?? false,
  } : undefined;
  const job = mkdtempSync("/tmp/apparent-dev-plow-trace-policy-");
  try {
    const policy = await loadPolicy<Policy>(await buildPolicy(job, new URL("./policy.bend", import.meta.url), "replay.mjs"));
    const input = readManifest(manifest, policy);
    const traces = readTraces(source, input, policy);
    const results: { item: number; result: string; spans: number; events: number }[] = [];
    async function replay(db?: DatabaseSync) {
      const checkpointExists = db?.prepare("SELECT 1 FROM replay WHERE trace_id=?");
      for (const [index, trace] of traces.entries()) {
        const plan = policy.plan(trace.id, list(trace.spans), input.fromNs, input.toNs, trace.events);
        const result = plan.$ === "ReplaySkipped"
          ? policy.skipped_action(plan.reason, Boolean(checkpointExists?.get(trace.id)))
          : target && db ? await transfer(trace, plan.body, target, db, policy) : "ready";
        if (result === "checkpoint-source-changed") fail("Replay stopped (checkpoint-source-changed)");
        results.push({ item: index + 1, result, spans: trace.spans.length, events: trace.events });
      }
    }
    if (target) await withDestination(target, replay);
    else await replay();
    return { mode: target ? "apply" : "dry-run", source: "legacy-sqlite", coverage: "partial", traces: results };
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.umask(0o077);
  try {
    console.log(JSON.stringify(await runReplay(process.argv.slice(2))));
  } catch (error) {
    const message = error instanceof SyntaxError ? "Invalid JSON input" :
      error instanceof ReplayError ? error.message : "Replay input or I/O failed";
    console.error(message);
    process.exitCode = 1;
  }
}
