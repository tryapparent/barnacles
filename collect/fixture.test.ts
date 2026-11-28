import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { capturePolicy, fixturePolicy, projectRollout, projectRun, publish } from "./fixture.ts";

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

test("history chunks distinguish shared prefixes and remain immutable on replay", () => {
  const directory = join(workdir, "fingerprints");
  const [start, end] = projectRollout(policy, fixture("codex.jsonl"));
  publish(directory, "fixture-live", [start], 1024);
  publish(directory, "fixture-live", [start, end], 1024);
  publish(directory, "fixture-live", [start, end], 1024);
  const chunks = readdirSync(directory).map(file => readFileSync(join(directory, file)));
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(chunk => chunk.length >= 1024));
  assert.notDeepEqual(chunks[0].subarray(0, 1024), chunks[1].subarray(0, 1024));
  for (const chunk of chunks) {
    const { chunkId, ...event } = JSON.parse(chunk.toString().split("\n")[0]);
    assert.match(chunkId, /^[a-f0-9]{64}$/);
    assert.deepEqual(event, JSON.parse(start));
  }
});

test("T3 versioned-only reads require exact counterparts for every legacy chunk", () => {
  const directory = join(workdir, "t3-legacy");
  const row = projectRun(policy, fixture("t3.json"));
  const deploy = fileURLToPath(new URL("../infra/lgtm/deploy.sh", import.meta.url));
  const audit = () => spawnSync("bash", [deploy, "--verify-t3-v2", directory]).status;
  assert.equal(audit(), 0);
  publish(directory, "fixture-live", [row]);
  const [legacy] = readdirSync(directory);
  assert.equal(audit(), 1);
  publish(directory, "fixture-backfill", [row], 128);
  assert.equal(audit(), 1);
  publish(directory, "fixture-live", [row], 128);
  assert.equal(audit(), 0);
  const arbitrary = join(directory, "unversioned.jsonl");
  writeFileSync(arbitrary, row + "\n");
  assert.equal(audit(), 1);
  rmSync(arbitrary);
  const versioned = legacy.replace("-live-", "-live-v2-");
  appendFileSync(join(directory, versioned), row + "\n");
  assert.equal(audit(), 1);
});

test("Codex capture restarts, admits new arrivals beside backfill and preserves fork replay identities", async () => {
  const root = join(workdir, "retained");
  const spool = join(workdir, "spool");
  const state = join(workdir, "state");
  mkdirSync(root);
  await capturePolicy(workdir);
  const env = { ...process.env, PLOW_CODEX_ROOTS: root, PLOW_CAPTURE_SCOPE: "fixture",
    PLOW_CAPTURE_STATE: state, PLOW_CAPTURE_SPOOL: spool,
    PLOW_CAPTURE_MODULE: join(workdir, "capture.mjs"), PLOW_COLLECT_MODULE: join(workdir, "collect.mjs") };
  function capture(lane: string) {
    return execFileSync(process.execPath, [fileURLToPath(new URL("./fixture.ts", import.meta.url)), "--capture", lane, "--once"],
      { env, timeout: 15_000, encoding: "utf8" });
  }
  const rows = (directory: string) => readdirSync(join(spool, directory)).flatMap(file =>
    readFileSync(join(spool, directory, file), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  const old = new Date("2025-06-03T12:00:00Z");
  const archived = join(root, "rollout-archive.jsonl.gz");
  writeFileSync(archived, gzipSync(fixture("codex.jsonl").replaceAll("fixture-session", "old-synthetic-session")));
  utimesSync(archived, old, old);
  const zstd = join(root, "rollout-archive.jsonl.zst");
  writeFileSync(zstd, zstdCompressSync(fixture("codex.jsonl").replaceAll("fixture-session", "zstd-synthetic-session")
    .replaceAll("function_call", "custom_tool_call")));
  utimesSync(zstd, old, old);
  capture("live");
  assert.equal(rows("codex").filter(row => row.sessionId).length, 0);
  const active = join(root, "rollout-active.jsonl");
  const first = fixture("codex.jsonl").split("\n").slice(0, 3).join("\n");
  writeFileSync(active, first);
  const tick = new Date(Date.now() + 10_000);
  utimesSync(active, tick, tick);
  capture("live");
  assert.equal(rows("codex").filter(row => row.sessionId).length, 0);
  appendFileSync(active, "\n");
  capture("live");
  const firstRow = rows("codex").find(row => row.sessionId === "fixture-session");
  assert.ok(firstRow);
  const rotated = join(root, "rollout-rotated.jsonl");
  renameSync(active, rotated);
  writeFileSync(active, fixture("codex.jsonl"));
  capture("backfill");
  const projected = rows("codex").filter(row => row.sessionId);
  assert.equal(new Set(projected.map(row => row.eventId)).size, 9);
  assert.equal(projected.filter(row => row.sessionId === "zstd-synthetic-session").length, 3);
  assert.ok(projected.filter(row => row.eventId === firstRow.eventId).length > 1);
  const events = projected.length;
  capture("backfill");
  capture("backfill");
  assert.equal(rows("codex").filter(row => row.sessionId).length, events);
  assert.ok(rows("health").some(row => row.lane === "backfill" && row.status === "complete" && row.scannedUnits === 4 && row.scanProgress === "100.0%"));
  assert.doesNotMatch(JSON.stringify(rows("health")), /retained|rollout-/);
});
