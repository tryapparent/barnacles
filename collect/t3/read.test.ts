import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("bounded T3 read projects an exact local run and rejects ambiguous bindings", async () => {
  const scratch = mkdtempSync("/tmp/apparent-dev-plow-t3-fixture-");
  const token = join(scratch, "token");
  writeFileSync(token, "synthetic-read-token\n", { mode: 0o600 });
  const refs = [{ appThreadId: "fixture-thread", driver: "codex", nativeThreadRef: {
    driver: "codex", strength: "strong", nativeId: "fixture-session",
  } }];
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/orchestration/threads/fixture-thread/bounded?dedupeBodies=1");
    assert.equal(request.headers.authorization, "Bearer synthetic-read-token");
    assert.equal(request.headers["x-t3-orchestration-protocol"], "2");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ projection: {
      thread: { id: "fixture-thread", title: "fixture private canary" },
      providerThreads: refs,
      runs: [{ threadId: "fixture-thread", id: "run:fixture", startedAt: "2025-06-03T12:00:00Z",
        completedAt: "2025-06-03T12:00:10Z" }],
    } }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const args = [fileURLToPath(new URL("./read.ts", import.meta.url)), "fixture-thread", "run:fixture"];
    const env = { ...process.env, PLOW_T3_ORIGIN: "http://127.0.0.1:" + address.port, PLOW_T3_READ_TOKEN_FILE: token };
    const run = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.on("error", reject);
      child.on("close", code => resolve({ code, output }));
    });
    const result = await run();
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.output), { kind: "t3_run", run: {
      id: "run:fixture", threadId: "fixture-thread", sessionId: "fixture-session",
      startedMs: 1748952000000, completedMs: 1748952010000,
    } });
    refs.push({ ...refs[0], nativeThreadRef: { ...refs[0].nativeThreadRef, nativeId: "another-session" } });
    assert.deepEqual(await run(), { code: 1, output: "" });
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
