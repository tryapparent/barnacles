import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [url, tokenFile, queryFile, directFile, resultFile] = process.argv.slice(2);
const child = spawn("docker", [
  "run", "--rm", "-i", "--network", "host",
  "-e", "GRAFANA_URL", "-e", "GRAFANA_SERVICE_ACCOUNT_TOKEN",
  "grafana/mcp-grafana:2.3.0@sha256:c27248b5919d09d64ea273ca1b128b32902c6796f6e2dfcd11849d4f1363f9ed",
  "-t", "stdio", "--enabled-tools=api", "--disable-write", "--enable-query", "--usage-stats=disabled",
], {
  env: { ...process.env, GRAFANA_URL: url, GRAFANA_SERVICE_ACCOUNT_TOKEN: readFileSync(tokenFile, "utf8").trim() },
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
  assert.ok(tools.tools.some((tool: { name: string }) => tool.name === "grafana_api_request"));
  const result = await request("tools/call", {
    name: "grafana_api_request",
    arguments: { endpoint: "/api/ds/query", method: "POST", body: readFileSync(queryFile, "utf8") },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const response = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.equal(response.status, 200);
  const expected = JSON.parse(readFileSync(directFile, "utf8"));
  assert.deepEqual(response.data, expected);
  writeFileSync(resultFile, JSON.stringify(response.data) + "\n", { mode: 0o600 });
  console.log("Grafana MCP returned the same analysis frames as the direct dashboard query.");
} finally {
  clearTimeout(timeout);
  child.stdin.end();
}
