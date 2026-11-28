import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [url, dir] = process.argv.slice(2);
const read = (name: string) => readFileSync(join(dir, name), "utf8");
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
  const trace = await call("get_tempo_trace", { ...args, trace_id: direct[0] });
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
