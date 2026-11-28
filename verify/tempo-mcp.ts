import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [url, dir] = process.argv.slice(2);
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const data = (name: string) => JSON.parse(read(name + ".json"));
const result = (name: string) => data(name).results.A;

function assertFixtureResults() {
  const mixedId = "11111111111111111111111111111111";
  const unsetId = "55555555555555555555555555555555";
  for (const [name, ids] of [
    ["any", [mixedId, unsetId]], ["search", [mixedId]], ["ok", [mixedId]], ["unset", [unsetId]], ["empty", []],
  ] as const) {
    assert.equal(result(name).status, 200, name);
    assert.deepEqual(result(name).frames[0].data.values[0].sort(), ids, name);
  }
  const missing = result("missing");
  assert.ok(missing.status >= 400 && !missing.frames?.length);
  assert.match(missing.error, /not found/i);

  const { spans, event } = data("legacy");
  const originals = data("fixture-" + mixedId).resourceSpans[0].scopeSpans[0].spans;
  const tempoSpans = data("tempo").batches[0].scopeSpans[0].spans;
  assert.equal(spans.length, originals.length);
  assert.equal(tempoSpans.length, originals.length);
  for (const [index, legacySpan] of spans.entries()) {
    const original = originals[index];
    const tempoSpan = tempoSpans.find((span: { spanId: string }) =>
      Buffer.from(span.spanId, "base64").toString("hex") === original.spanId);
    assert.equal(legacySpan.span_id, original.spanId);
    assert.equal(legacySpan.parent_span_id ?? "", original.parentSpanId ?? "");
    assert.equal(legacySpan.start_ns, original.startTimeUnixNano);
    assert.equal(legacySpan.end_ns, original.endTimeUnixNano);
    assert.equal(legacySpan.status_code, original.status.code);
    assert.equal(tempoSpan.startTimeUnixNano, legacySpan.start_ns);
    assert.equal(tempoSpan.endTimeUnixNano, legacySpan.end_ns);
    assert.equal(Buffer.from(tempoSpan.traceId, "base64").toString("hex"), mixedId);
    assert.equal(Buffer.from(tempoSpan.parentSpanId ?? "", "base64").toString("hex"), legacySpan.parent_span_id ?? "");
  }
  assert.equal(spans[1].call_id, "call_fixture");
  assert.equal(event.event, "codex.tool_result");
  assert.equal(event.success, 0);
  assert.equal(event.observed_ns, originals[1].endTimeUnixNano);
  const child = tempoSpans.find((span: { parentSpanId?: string }) => span.parentSpanId);
  assert.ok(child.events.some((entry: { name: string; timeUnixNano: string }) =>
    entry.name === event.event && entry.timeUnixNano === event.observed_ns));

  assert.equal(result("exact").status, 200);
  const frame = result("exact").frames[0];
  const column = (name: string) => frame.data.values[frame.schema.fields.findIndex((field: { name: string }) => field.name === name)];
  assert.deepEqual(column("traceID"), [mixedId, mixedId]);
  assert.deepEqual(column("spanID").toSorted(), spans.map((span: { span_id: string }) => span.span_id));
  assert.deepEqual(column("instrumentationLibraryName"), ["plow.codex", "plow.codex"]);
  const childIndex = column("spanID").indexOf(spans[1].span_id);
  assert.equal(column("parentSpanID")[childIndex], spans[0].span_id);
  assert.equal(column("operationName")[childIndex], spans[1].operation);
  assert.equal(column("statusCode")[childIndex], spans[1].status_code);
  for (const name of ["legacy", "tempo", "any", "search", "exact"]) {
    assert.ok(!read(name + ".json").includes("synthetic-private-trace-canary"), name);
  }
}

assertFixtureResults();
const child = spawn("docker", [
  "run", "--rm", "-i", "--network", "host",
  "-e", "GRAFANA_URL", "-e", "GRAFANA_SERVICE_ACCOUNT_TOKEN",
  "grafana/mcp-grafana:2.3.0@sha256:c27248b5919d09d64ea273ca1b128b32902c6796f6e2dfcd11849d4f1363f9ed",
  "-t", "stdio", "--enabled-tools=tempo", "--disable-write", "--enable-query", "--usage-stats=disabled",
], {
  env: { ...process.env, GRAFANA_URL: url, GRAFANA_SERVICE_ACCOUNT_TOKEN: read("mcp-token").trim() },
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let id = 0;
async function request(method: string, params: unknown) {
  const requestId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: requestId }) + "\n");
  for (;;) {
    const next = await lines.next();
    assert.ok(!next.done, "Grafana MCP closed its output");
    const response = JSON.parse(next.value);
    if (response.id !== requestId) continue;
    assert.ok(!response.error, JSON.stringify(response.error));
    return response.result;
  }
}
async function call(name: string, args: object) {
  const result = await request("tools/call", { name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((part: { type: string }) => part.type === "text").text);
}

const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
try {
  const hello = await request("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "plow-tempo-verification", version: "1" },
  });
  assert.ok(hello.serverInfo);
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const tools = await request("tools/list", {});
  for (const name of ["search_tempo_traces", "get_tempo_trace"]) {
    assert.ok(tools.tools.some((tool: { name: string }) => tool.name === name));
  }
  const { from, to, queries: [target] } = JSON.parse(read("search-query.json"));
  const args = {
    datasourceUid: target.datasource.uid,
    start: new Date(Number(from)).toISOString(),
    end: new Date(Number(to)).toISOString(),
  };
  const search = await call("search_tempo_traces", { ...args, query: target.query, limit: target.limit, spss: target.spss });
  const direct = JSON.parse(read("search.json")).results.A.frames[0].data.values[0];
  assert.deepEqual(search.traces.map((trace: { traceID: string }) => trace.traceID), direct);
  const trace = await call("get_tempo_trace", { datasourceUid: target.datasource.uid, trace_id: direct[0] });
  writeFileSync(join(dir, "mcp-tempo.json"), JSON.stringify({ search, trace }) + "\n", { mode: 0o600 });
  assert.equal(trace.traceId, direct[0]);
  const frame = JSON.parse(read("exact.json")).results.A.frames[0];
  const column = (name: string) => frame.data.values[frame.schema.fields.findIndex((field: { name: string }) => field.name === name)];
  const expected = column("spanID").map((spanId: string, index: number) => [
    spanId, column("parentSpanID")[index], column("operationName")[index],
    column("startTime")[index], column("duration")[index],
  ]);
  const observed = trace.services.flatMap((service: { spans: Record<string, unknown>[] }) => service.spans.map((span) => [
    span.spanId, span.parentSpanId ?? "", span.name, span.startTimeMs, span.durationMs,
  ]));
  assert.deepEqual(observed.sort(), expected.sort());
  assert.ok(!JSON.stringify({ search, trace }).includes("synthetic-private-trace-canary"));
  console.log("Native Grafana MCP search and trace lookup returned the same fixture trace and spans as Grafana.");
} finally {
  clearTimeout(timeout);
  child.stdin.end();
}
