import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { after, test } from "node:test";
import { fixturePolicy, projectRollout, projectRun } from "./fixture.ts";

const workdir = mkdtempSync("/tmp/apparent-dev-plow-collect-");
after(() => rmSync(workdir, { recursive: true, force: true }));
const policy = await fixturePolicy(workdir);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("projects only fixture evidence and preserves replay identity", () => {
  const codex = fixture("codex.jsonl");
  const projected = projectRollout(policy, codex);
  assert.deepEqual(projected.map(line => JSON.parse(line)), [
    { kind: "function_call", eventId: "fixture-session:3", sessionId: "fixture-session", callId: "fixture-call", timestampMs: 1748952001000 },
    { kind: "function_call_output", eventId: "fixture-session:4", sessionId: "fixture-session", callId: "fixture-call", timestampMs: 1748952003000 },
    { kind: "function_call", eventId: "fixture-session:5", sessionId: "fixture-session", callId: "fixture-incomplete", timestampMs: 1748952004000 },
  ]);
  assert.deepEqual(projectRollout(policy, codex), projected);
  assert.deepEqual(JSON.parse(projectRun(policy, fixture("t3.json"))), {
    kind: "t3_run",
    run: { id: "fixture-run", threadId: "fixture-thread", sessionId: "fixture-session", startedMs: 1748952000000, completedMs: 1748952006000 },
  });
});

test("omits unattributed and malformed events and rejects conflicting session metadata", () => {
  const [metadata, , call] = fixture("codex.jsonl").split("\n");
  const malformed = call.replace("fixture-call", "/private/path");
  const badClock = call.replace("2025-06-03T12:00:01.000Z", "invalid");
  const output = projectRollout(policy, [call, "{", metadata, badClock, malformed, call].join("\n"));
  assert.deepEqual(output.map(line => JSON.parse(line).eventId), ["fixture-session:6"]);
  assert.throws(() => projectRollout(policy, [metadata, call, metadata.replace("fixture-session", "other")].join("\n")),
    /Invalid or conflicting Codex session identity/);
});

test("rejects an unbound or reversed T3 run", () => {
  const t3 = fixture("t3.json");
  assert.throws(() => projectRun(policy, t3.replace("fixture-session", "")), /Invalid T3 run/);
  assert.throws(() => projectRun(policy, t3.replace("12:00:06.000Z", "11:59:59.000Z")), /Invalid T3 run/);
});
