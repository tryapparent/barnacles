import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const command = fileURLToPath(new URL("./main.ts", import.meta.url));
const first = "1748951940123456789";
const last = "1748952060123456789";
const upper = "1748952070123456789";
const cutover = "1748952080123456789";
const trace = "af".repeat(16);
const occupied = "df".repeat(16);
const crossing = "b1".repeat(16);
const missing = "c1".repeat(16);
const root = "89".repeat(8);
const child = "ab".repeat(8);
const eventAt = "1748951950123456789";
const session = "12345678-1111-1111-1111-123456789abc";

function fixture(t: { after: (fn: () => void) => void }) {
  const base = process.env.PLOW_TEST_DIRECTORY;
  const directory = mkdtempSync(base ? join(base, "trace-replay-") : "/tmp/apparent-dev-plow-trace-replay-test-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.sqlite");
  const path = join(directory, "manifest.json");
  const checkpoint = join(directory, "checkpoint");
  mkdirSync(checkpoint, { mode: 0o700 });
  const db = new DatabaseSync(source);
  db.exec(`CREATE TABLE codex_otel_spans (
    instance TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT,
    operation TEXT NOT NULL, start_ns TEXT NOT NULL, end_ns TEXT NOT NULL, status_code INTEGER NOT NULL,
    conversation_id TEXT, turn_id TEXT, call_id TEXT, fingerprint TEXT NOT NULL,
    PRIMARY KEY(instance,trace_id,span_id)) STRICT;
    CREATE TABLE codex_otel_span_events (
      instance TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, event_index INTEGER NOT NULL,
      event TEXT NOT NULL, observed_ns TEXT NOT NULL, conversation_id TEXT, turn_id TEXT, call_id TEXT,
      reported_duration_ms INTEGER, success INTEGER, PRIMARY KEY(instance,trace_id,span_id,event_index)) STRICT;`);
  const insert = db.prepare("INSERT INTO codex_otel_spans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  insert.run("fixture", trace, root, null, "run_turn", first, last, 2, session, null, null, "private-fixture");
  insert.run("fixture", trace, child, root, "private-fixture", first, last, 0, "private-fixture", session, "call_example", "x");
  insert.run("fixture", occupied, root, null, "run_turn", first, last, 1, null, null, null, "x");
  insert.run("fixture", crossing, root, null, "run_turn", first, upper, 0, null, null, null, "x");
  insert.run("other", missing, root, null, "run_turn", first, last, 0, null, null, null, "x");
  db.prepare("INSERT INTO codex_otel_span_events VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("fixture", trace, child, 0, "codex.tool_result", eventAt, null, null, "private-fixture", 302, 0);
  db.close();

  function manifest(ids: string[], liveSinceNs = cutover) {
    writeFileSync(path, JSON.stringify({ instance: "fixture", fromNs: first, toNs: upper, liveSinceNs, traceIds: ids }));
  }

  async function run(extra: string[] = []) {
    const { stdout } = await exec(process.execPath, [
      command, "--source", source, "--manifest", path, ...extra,
    ], { timeout: 80_000 });
    return JSON.parse(stdout);
  }

  function apply(query: string, ingest = query) {
    return ["--apply", "--quiescent", "--query", query, "--ingest", ingest, "--checkpoint", checkpoint];
  }

  function state(id: string) {
    const receipt = new DatabaseSync(join(checkpoint, "checkpoint.sqlite"), { readOnly: true });
    try {
      return receipt.prepare("SELECT state FROM replay WHERE trace_id=?").get(id)?.state;
    } finally {
      receipt.close();
    }
  }

  return { source, manifest, run, apply, state };
}

const hex = (value: string) => Buffer.from(value, "base64").toString("hex");
const base64 = (value: string) => Buffer.from(value, "hex").toString("base64");
type Span = { traceId: string; spanId: string; parentSpanId?: string };

test("bounded legacy replay, collision avoidance and recovery", { timeout: 180_000 }, async t => {
  const input = fixture(t);
  const before = readFileSync(input.source);
  let posts = 0;
  let loseResponse = true;
  let discardWrite = false;
  let stored: { resourceSpans: unknown[] } | undefined;
  let lastBody = "";
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      const id = req.url?.split("/").at(-1);
      let traceBody = id === trace ? stored : undefined;
      if (id === occupied) traceBody = { resourceSpans: [{ scopeSpans: [{ spans: [
        { traceId: base64(occupied), spanId: base64(child) },
      ] }] }] };
      res.end(JSON.stringify({ trace: traceBody ?? {}, metrics: {} }));
      return;
    }

    posts++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    lastBody = Buffer.concat(chunks).toString("utf8");
    const received = JSON.parse(lastBody);
    for (const group of received.resourceSpans) {
      for (const scope of group.scopeSpans) {
        for (const span of scope.spans as Span[]) {
          span.traceId = base64(span.traceId);
          span.spanId = base64(span.spanId);
          if (span.parentSpanId) span.parentSpanId = base64(span.parentSpanId);
        }
      }
    }
    if (!discardWrite) stored = received;
    if (loseResponse) res.statusCode = 503;
    res.end(JSON.stringify({ partialSuccess: {} }));
  }).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const apply = input.apply(`http://127.0.0.1:${address.port}`);

  input.manifest([trace, crossing, missing]);
  const dry = await input.run();
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.coverage, "partial");
  assert.deepEqual(dry.traces, [
    { item: 1, result: "ready", spans: 2, events: 1 },
    { item: 2, result: "invalid-or-outside-window", spans: 1, events: 0 },
    { item: 3, result: "source-absent", spans: 0, events: 0 },
  ]);
  assert.equal(posts, 0);
  input.manifest([trace], first);
  await assert.rejects(input.run(), /historical interval/);
  input.manifest([trace, trace]);
  await assert.rejects(input.run(), /distinct native trace IDs/);

  input.manifest([occupied, trace]);
  await assert.rejects(input.run(apply), /HTTP 503/);
  assert.equal(posts, 1);
  assert.equal(input.state(trace), "pending");
  assert.equal(input.state(occupied), undefined);
  assert.doesNotMatch(lastBody, /private-fixture/);
  const { resourceSpans: [batch] } = JSON.parse(lastBody);
  assert.deepEqual(batch.resource.attributes.map((a: { key: string; value: { stringValue: string } }) =>
    [a.key, a.value.stringValue]), [
    ["service.name", "plow.codex"], ["plow.replay.source", "legacy-sqlite"], ["plow.replay.coverage", "partial"],
  ]);
  const [rootSpan, childSpan] = batch.scopeSpans[0].spans;
  assert.equal(rootSpan.traceId, trace);
  assert.equal(rootSpan.spanId, root);
  assert.equal(rootSpan.startTimeUnixNano, first);
  assert.equal(rootSpan.endTimeUnixNano, last);
  assert.equal(rootSpan.status.code, 2);
  assert.equal(rootSpan.kind, undefined);
  assert.equal(childSpan.parentSpanId, root);
  assert.equal(childSpan.status, undefined);
  assert.equal(childSpan.name, "codex.span");
  assert.deepEqual(childSpan.events, [{
    name: "codex.tool_result", timeUnixNano: eventAt,
    attributes: [
      { key: "duration_ms", value: { stringValue: "302" } },
      { key: "success", value: { stringValue: "false" } },
    ],
  }]);

  const recovered = await input.run(apply);
  assert.deepEqual(recovered.traces.map((row: { result: string }) => row.result), ["already-present", "recovered"]);
  assert.equal(input.state(trace), "done");
  const replayed = await input.run(apply);
  assert.equal(replayed.traces[1].result, "checkpointed");
  assert.equal(posts, 1);
  assert.deepEqual(readFileSync(input.source), before);

  const next = fixture(t);
  const retry = next.apply(`http://127.0.0.1:${address.port}`);
  next.manifest([trace]);
  stored = undefined;
  discardWrite = true;
  await assert.rejects(next.run(retry), /HTTP 503/);
  assert.equal(next.state(trace), "pending");
  await assert.rejects(next.run(retry), /pending-absent/);
  assert.equal(posts, 2);
  discardWrite = false;
  loseResponse = false;
  assert.equal((await next.run([...retry, "--retry-pending"])).traces[0].result, "written");
  assert.equal(posts, 3);
});

const query = process.env.PLOW_REPLAY_TEST_QUERY;
const ingest = process.env.PLOW_REPLAY_TEST_INGEST;

test("pinned Tempo preserves native coordinates and omitted kind", {
  skip: !(query && ingest), timeout: 80_000,
}, async t => {
  const input = fixture(t);
  input.manifest([trace, crossing]);
  const applied = await input.run(input.apply(query!, ingest!));
  assert.deepEqual(applied.traces.map((row: { result: string }) => row.result), ["written", "invalid-or-outside-window"]);
  const response = await fetch(new URL(`/api/v2/traces/${trace}`, query), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const { trace: result } = await response.json();
  const [batch] = result.resourceSpans;
  const scope = batch.scopeSpans[0];
  const rootSpan = scope.spans.find((span: Span) => hex(span.spanId) === root);
  const childSpan = scope.spans.find((span: Span) => hex(span.spanId) === child);
  assert.equal(scope.scope.name, "plow.codex");
  assert.equal(scope.spans.length, 2);
  assert.equal(hex(rootSpan.traceId), trace);
  assert.equal(hex(childSpan.parentSpanId), root);
  assert.equal(rootSpan.startTimeUnixNano, first);
  assert.equal(rootSpan.endTimeUnixNano, last);
  assert.equal(rootSpan.status.code, "STATUS_CODE_ERROR");
  assert.equal(rootSpan.kind, undefined);
  assert.equal(childSpan.events[0].timeUnixNano, eventAt);
  assert.equal(childSpan.events[0].name, "codex.tool_result");
  assert.equal(batch.resource.attributes.find((a: {key: string}) =>
    a.key === "plow.replay.coverage").value.stringValue, "partial");
  assert.equal((await input.run(input.apply(query!, ingest!))).traces[0].result, "checkpointed");
});
