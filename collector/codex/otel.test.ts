import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testParent = process.env.BARNACLES_TEST_DIRECTORY;
const backendToken = "synthetic-backend-secret-at-least-32-characters";
const trace = "0a".repeat(16);
const turn = "00000000-0000-4000-8000-000000000001";
const conversation = "00000000-0000-4000-8000-000000000002";
const start = "1795080000000000001";
const end = "1795080000100000002";
const marker = "SYNTHETIC_PRIVATE_CONTENT";
const key = (key: string, stringValue: string) => ({ key, value: { stringValue } });

function span(id: string, parent = "") {
  return {
    traceId: trace, spanId: id.repeat(8), parentSpanId: parent, name: "exec_command",
    startTimeUnixNano: start, endTimeUnixNano: end, status: { code: 1, message: marker },
    attributes: [key("conversation.id", conversation), key("turn.id", turn), key("call_id", "call_A1"), key("arguments", marker)],
    events: [
      { name: "codex.tool_result", timeUnixNano: end, attributes: [key("call_id", "call_A1"), key("duration_ms", "100"), key("success", "true"), key("output", marker)] },
      { name: marker, timeUnixNano: end },
    ],
  };
}

test("Codex OTLP keeps exact provider clocks and rolls back conflicting or invalid batches", { timeout: 30_000 }, async () => {
  const job = mkdtempSync(testParent ? join(testParent, "codex-otel-") : "/tmp/apparent-dev-plow-otel-test-");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./otel.ts", import.meta.url)), job, "server-scoped"], {
    env: { ...process.env, PLOW_OTLP_EVIDENCE_PORT: "0", PLOW_OTLP_EVIDENCE_TOKEN: backendToken },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text) => { stderr += text; });
  const lines = createInterface({ input: child.stdout });
  try {
    const line = await Promise.race([
      once(lines, "line").then(([line]) => String(line)),
      exited.then(([code]) => { throw Error(`OTLP process exited (${code}): ${stderr}`); }),
    ]);
    const port = /^Codex OTLP evidence ready on 127\.0\.0\.1:(\d+)$/.exec(line)?.[1];
    assert.ok(port, line);
    const endpoint = `http://127.0.0.1:${port}`;
    const send = (spans: object[], signal = "traces", bearer = backendToken) => fetch(`${endpoint}/v1/${signal}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
    }).then((response) => response.status);
    const first = span("01", "02".repeat(8));
    assert.equal(await send([first], "traces", ""), 401);
    assert.equal(await send([first], "logs"), 404);
    assert.equal(await send([first]), 200);
    assert.equal(await send([first]), 200);
    assert.equal(await send([span("03"), { ...first, endTimeUnixNano: "1795080000100000003" }]), 409);
    assert.equal(await send([span("04"), { ...span("05"), endTimeUnixNano: "0" }]), 400);

    const file = join(job, "evidence.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT instance, parent_span_id, start_ns, end_ns, conversation_id, turn_id, call_id
        FROM codex_otel_spans`).all().map((row) => ({ ...row }));
      assert.deepEqual(rows, [{
        instance: "server-scoped", parent_span_id: "02".repeat(8), start_ns: start, end_ns: end,
        conversation_id: conversation, turn_id: turn, call_id: "call_A1",
      }]);
      const events = db.prepare(`SELECT event, observed_ns, reported_duration_ms, success
        FROM codex_otel_span_events`).all().map((row) => ({ ...row }));
      assert.deepEqual(events, [{ event: "codex.tool_result", observed_ns: end, reported_duration_ms: 100, success: 1 }]);
    } finally {
      db.close();
    }
    assert.ok(!readFileSync(file).includes(Buffer.from(marker)));
  } finally {
    child.kill();
    await exited;
    lines.close();
    rmSync(job, { recursive: true, force: true });
  }
});
