import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { deliveryReport, saveDelivery, saveRollout, saveThread } from "../evidence/sources.ts";
import { buildPolicy } from "./build.ts";
import { pullRequest, releaseEvidence } from "./github/delivery.ts";
import { readRollout } from "./rollout.ts";
import { t3Snapshot } from "./t3.ts";

test("compiled Bend2 source decisions through the SQLite import path", async () => {
  const root = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(root);
  const job = mkdtempSync(join(root, "sources-test-"));
  try {
    const source = new URL("../evidence/sources.bend", import.meta.url);
    const policy = (await import(pathToFileURL(await buildPolicy(job, source, "sources.mjs")).href)).default;
    const time = (s: string) => `2026-01-01T12:00:${s}Z`;
    const repo = "synthetic/example";
    const merged = "a".repeat(40);
    const released = "b".repeat(40);
    const tag = `linux-main-v2-${released}`;
    const snapshot = {
      instance: "t3-test",
      thread: { threadId: "thread-1", createdAt: time("01.125"), updatedAt: time("30"),
        status: "completed", createdBy: "user", creationSource: "web" },
      recentRuns: [{ runId: "run-1", requestedAt: time("02"), startedAt: time("03") }],
      links: { nextCursor: null, pullRequests: [
        { host: "github.com", repository: repo, number: 9, source: "created", state: "merged" },
      ] },
    };
    const read = (path: string) => {
      if (path.includes("/commits?")) return [{ sha: merged, commit: { committer: { date: time("04") } } }];
      if (path.includes("/reviews?")) return [{ id: 7, submitted_at: time("06") }];
      if (path.includes("/pulls/")) return { number: 9, base: { repo: { full_name: repo } },
        merged: true, created_at: time("05"), merged_at: time("09"),
        merge_commit_sha: merged, commits: 1, updated_at: time("09") };
      if (path.includes("/releases/")) return { id: 2, tag_name: tag, draft: false,
        published_at: time("10"), assets: [{ id: 4, size: 100, state: "uploaded", name: "demo-linux-x86_64.AppImage" }] };
      if (path.includes("/git/ref/")) return { object: { type: "commit", sha: released } };
      if (path.includes("/compare/")) return {
        base_commit: { sha: merged }, merge_base_commit: { sha: merged }, status: "ahead",
      };
      throw Error("Unexpected synthetic route");
    };
    const path = join(job, "evidence.sqlite");
    const pr = pullRequest(repo, 9, policy, read);
    const failure = releaseEvidence(pr, tag, policy, read, () => ({ http: 206, bytes: 1, range: false }));
    saveDelivery(path, pr, failure);
    assert.equal(deliveryReport(path, policy)[0].pr_to_release_seconds, null);
    const proof = releaseEvidence(pr, tag, policy, read, () => ({ http: 206, bytes: 1, range: true }));
    saveDelivery(path, pr, proof);
    assert.equal(deliveryReport(path, policy)[0].pr_to_release_seconds, 5);
    assert.equal(deliveryReport(path, policy)[0].thread_to_release_seconds, null);

    const thread = t3Snapshot(snapshot, policy);
    assert.equal(thread.origin, "manual_t3");
    saveThread(path, thread);
    saveThread(path, thread);
    assert.equal(deliveryReport(path, policy)[0].thread_to_release_seconds, 8.875);
    saveThread(path, { ...thread, id: "thread-2" });
    assert.equal(deliveryReport(path, policy)[0].thread_to_release_seconds, null);
    assert.throws(() => t3Snapshot({ ...snapshot, links: { ...snapshot.links, nextCursor: "more" } }, policy),
      /Incomplete T3/);

    const rollout = join(job, "test.jsonl");
    const event = (s: string, payload: object) => ({ timestamp: time(s), type: "response_item", payload });
    writeFileSync(rollout, [
      { type: "session_meta", payload: { id: "session-test" } },
      event("02.123", { type: "custom_tool_call", name: "exec", call_id: "launch", input: "a private string" }),
      event("03", { type: "custom_tool_call_output", call_id: "launch", output: "Script running with cell ID g10:11" }),
      event("04", { type: "function_call", name: "wait", call_id: "wait", arguments: '{"cell_id":"g10:11"}' }),
      event("05", { type: "function_call_output", call_id: "wait", output: [{ text: "Script completed\nraw result" }] }),
      event("06", { type: "custom_tool_call", name: "exec", call_id: "pending" }),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const data = await readRollout(rollout, "codex-test", policy);
    saveRollout(path, data);
    saveRollout(path, data);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM codex_spans").get()?.n, 4);
      assert.equal(db.prepare("SELECT ended_ms-started_ms duration FROM codex_spans WHERE clock='async_cell'").get()?.duration, 2877);
      assert.equal(db.prepare("SELECT ended_ms FROM codex_calls WHERE call_id='pending'").get()?.ended_ms, null);
      assert.equal(db.prepare("SELECT count(*) n FROM t3_runs").get()?.n, 2);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
    assert.ok(!JSON.stringify(data).includes("raw result"));
    assert.ok(!JSON.stringify(data).includes("a private string"));
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
