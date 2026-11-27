import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("T3 OTLP admits only source evidence and preserves the first commit across replay and rejection", { timeout: 30_000 }, async () => {
  const job = mkdtempSync(testParent ? join(testParent, "t3-otel-") : "/tmp/apparent-dev-plow-t3-otel-test-");
  const credential = join(job, "credential");
  writeFileSync(credential, backendToken + "\n", { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("./otel.ts", import.meta.url)), "--t3", job, "trusted-instance"], {
    env: { ...process.env, PLOW_T3_EVIDENCE_PORT: "0", PLOW_T3_EVIDENCE_TOKEN_FILE: credential },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (line) => { stderr += line; });
  const lines = createInterface({ input: child.stdout });
  try {
    const line = await Promise.race([
      once(lines, "line").then(([line]) => String(line)),
      exited.then(([code]) => { throw Error(`T3 OTLP process exited (${code}): ${stderr}`); }),
    ]);
    const port = /^T3 OTLP evidence ready on 127\.0\.0\.1:(\d+)$/.exec(line)?.[1];
    assert.ok(port, line);
    const send = async (spans: object[], signal = "traces", bearer = backendToken, service = "t3code-server", source = "trusted-instance") => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/${signal}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ resourceSpans: [{
          resource: { attributes: [key("service.name", service), key("plow.t3.instance", source), key("instance", marker)] },
          scopeSpans: [{ scope: { name: marker }, spans }],
        }] }),
      });
      await response.text();
      return response.status;
    };
    const first = {
      ...span("01", "02".repeat(8)),
      name: "orchestrationV2.dispatch.withReceipt",
      traceState: marker,
      attributes: [key("orchestration_v2.thread_id", conversation), key("orchestration_v2.command_id", turn),
        key("orchestration_v2.command_type", "thread.create"), key("instance", marker), key("prompt", marker)],
    };
    const changed = { ...first, endTimeUnixNano: "1795080000100000003" };
    const newSpan = { ...first, spanId: "03".repeat(8) };
    const differentTrace = { ...first, traceId: "fe".repeat(16), attributes: [
      key("orchestration_v2.thread_id", marker), key("orchestration_v2.command_id", marker),
      key("orchestration_v2.command_type", marker),
    ] };
    assert.equal(await send([first], "traces", "wrong"), 401);
    assert.equal(await send([first], "logs"), 404);
    assert.equal(await send([first], "metrics"), 404);
    assert.equal(await send([changed], "traces", backendToken, "codex"), 200);
    assert.equal(await send([first], "traces", backendToken, "t3code-server", marker), 400);
    assert.equal(await send([{ ...first, name: marker }]), 200);
    assert.equal(await send([first, first, differentTrace]), 200);

    const file = join(job, "evidence.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const observations = () => db.prepare("SELECT * FROM t3_otel_spans ORDER BY trace_id, span_id").all().map((row) => ({ ...row }));
      const [original, redacted] = observations();
      assert.deepEqual(original, {
        instance: "trusted-instance", trace_id: trace, span_id: first.spanId, parent_span_id: first.parentSpanId,
        operation: first.name, start_ns: start, end_ns: end, thread_id: conversation, command_id: turn,
        command_type: "thread.create", ingested_ms: original?.ingested_ms,
      });
      assert.ok(typeof original.ingested_ms === "number" && original.ingested_ms > 0);
      assert.equal(redacted.thread_id, null);
      assert.equal(redacted.command_id, null);
      assert.equal(redacted.command_type, null);
      assert.equal(await send([first, differentTrace]), 200);
      assert.equal(await send([newSpan, changed]), 409);
      assert.equal(await send([newSpan, { ...newSpan, endTimeUnixNano: changed.endTimeUnixNano }]), 409);
      assert.equal(await send([newSpan, { ...first, endTimeUnixNano: "0" }]), 400);
      assert.equal(await send([newSpan, { ...first, parentSpanId: "x".repeat(129) }]), 400);
      assert.deepEqual(observations(), [original, redacted]);
    } finally {
      db.close();
    }
    assert.ok(!readFileSync(file).includes(Buffer.from(marker)));
    assert.ok(!stderr.includes(marker));
  } finally {
    child.kill();
    await exited;
    lines.close();
    rmSync(job, { recursive: true, force: true });
  }
});
