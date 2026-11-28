import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [queryFile, directFile, resultFile, comparison, ...composeArgs] = process.argv.slice(2);
const child = spawn("docker", ["compose", ...composeArgs,
  "run", "--rm", "--no-deps", "-T", "grafana-mcp",
], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let id = 0;
function send(method: string, params: unknown, requestId?: number) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: requestId }) + "\n");
}
async function request(method: string, params: unknown) {
  const requestId = ++id;
  send(method, params, requestId);
  for (;;) {
    const next = await lines.next();
    assert.ok(!next.done, "Grafana MCP closed its output");
    const response = JSON.parse(next.value);
    if (response.id !== requestId) continue;
    assert.ok(!response.error, JSON.stringify(response.error));
    return response.result;
  }
}
const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
try {
  const hello = await request("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "plow-verification", version: "1" },
  });
  assert.ok(hello.serverInfo);
  send("notifications/initialized", {});
  const tools = await request("tools/list", {});
  assert.deepEqual(tools.tools.map((tool: { name: string }) => tool.name), ["grafana_api_request"]);
  const api = (arguments_: object) => request("tools/call", {
    name: "grafana_api_request", arguments: arguments_,
  });
  const decode = (result: { structuredContent?: unknown; content: { text: string }[] }) =>
    result.structuredContent ?? JSON.parse(result.content[0].text);
  const search = decode(await api({ endpoint: "/api/search?type=dash-db" }));
  assert.equal(search.status, 200);
  assert.ok(search.data.some((entry: { uid: string }) => entry.uid === "plow-run-breakdown"));
  const dashboard = decode(await api({
    endpoint: "/api/dashboards/uid/plow-run-breakdown",
    headers: { Authorization: "Bearer invalid" },
  }));
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.meta.provisioned, true);
  const write = await api({ endpoint: "/api/dashboards/db", method: "POST", body: "{}" });
  assert.ok(write.isError);
  const admin = decode(await api({ endpoint: "/api/admin/settings" }));
  assert.equal(admin.status, 403);
  assert.equal(admin.data, "");
  const result = await api({ endpoint: "/api/ds/query", method: "POST", body: readFileSync(queryFile, "utf8") });
  assert.ok(!result.isError, JSON.stringify(result));
  const response = decode(result);
  assert.equal(response.status, 200);
  const expected = JSON.parse(readFileSync(directFile, "utf8"));
  function stableFrames(result: typeof expected) {
    if (comparison !== "--ignore-query-stats") return result;
    const stable = structuredClone(result);
    for (const query of Object.values(stable.results) as { frames?: { schema: { meta?: { stats?: unknown } } }[] }[]) {
      for (const frame of query.frames ?? []) {
        if (frame.schema.meta) delete frame.schema.meta.stats;
      }
    }
    return stable;
  }
  assert.deepEqual(stableFrames(response.data), stableFrames(expected));
  writeFileSync(resultFile, JSON.stringify(response.data) + "\n", { mode: 0o600 });
  console.log("Grafana MCP returned the same data frames as the direct dashboard query.");
} finally {
  clearTimeout(timeout);
  child.stdin.end();
}
