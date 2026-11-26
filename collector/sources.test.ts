import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      if (path.includes("/commits?")) return [
        { sha: released, commit: { committer: { date: time("07") } } },
        { sha: merged, commit: { committer: { date: time("04") } } },
      ];
      if (path.includes("/reviews?")) return [
        { id: 8, submitted_at: time("07") }, { id: 1, submitted_at: time("01") },
        { id: 7, submitted_at: time("06") },
      ];
      if (path.includes("/actions/runs?")) {
        const workflow = { event: "pull_request", status: "completed", conclusion: "success", run_attempt: 1,
          repository: { id: 4 }, head_repository: { id: 5 }, head_branch: "stage-test", head_sha: released,
          pull_requests: [], run_started_at: time("07") };
        return { total_count: 4, workflow_runs: [
          { ...workflow, id: 102 },
          { ...workflow, id: 103, head_sha: "d".repeat(40), run_started_at: time("06") },
          { ...workflow, id: 104, run_attempt: 2, run_started_at: time("06") },
          { ...workflow, id: 105, pull_requests: [{ number: 8, base: { repo: { id: 4 } } }], run_started_at: time("06") },
        ] };
      }
      if (path.includes("/actions/workflows/verification.yml/runs?")) return { total_count: 1, workflow_runs: [{
        id: 205, event: "workflow_dispatch", conclusion: "success", display_title: `main · source ${released} · candidate run 205`,
        created_at: time("09"), updated_at: time("11"),
      }] };
      if (path.includes("/pulls/")) return { number: 9, base: { repo: { full_name: repo, id: 4 } },
        head: { ref: "stage-test", repo: { id: 5 } },
        merged: true, created_at: time("05"), merged_at: time("09"),
        merge_commit_sha: merged, commits: 2, updated_at: time("09") };
      if (path.includes("/releases/")) return { id: 2, tag_name: tag, draft: false,
        published_at: time("10"), assets: [{ id: 4, size: 100, state: "uploaded", name: "demo-linux-x86_64.AppImage" }] };
      if (path.includes("/git/ref/")) return { object: { type: "commit", sha: released } };
      if (path.includes("/compare/")) return {
        base_commit: { sha: merged }, merge_base_commit: { sha: merged }, status: "ahead",
      };
      throw Error("Unexpected synthetic route");
    };
    const path = join(job, "evidence.sqlite");
    const pr = pullRequest(repo, 9, policy, read, true);
    assert.equal(pr.firstCommit?.sha, merged);
    assert.equal(pr.firstReview?.id, 7);
    assert.deepEqual(pr.firstCI, { id: 102, at: Date.parse(time("07")) / 1000 });
    const failure = releaseEvidence(pr, tag, policy, read, () => ({ http: 206, bytes: 1, range: false }));
    saveDelivery(path, pr, failure);
    assert.equal(deliveryReport(path, policy)[0].pr_to_release_seconds, null);
    const proof = releaseEvidence(pr, tag, policy, read, () => ({ http: 206, bytes: 1, range: true }), true);
    saveDelivery(path, pr, proof);
    assert.equal(deliveryReport(path, policy)[0].first_ci_run, 102);
    assert.equal(deliveryReport(path, policy)[0].release_run, 205);
    saveDelivery(path, pr, { ...proof, id: 1, published: proof.published! + 1 });
    saveDelivery(path, pr, { ...proof, id: 12 });
    assert.equal(deliveryReport(path, policy)[0].release_id, 2);
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
    const receipt = (call_id: string, exit_code: number) => ({ type: "custom_tool_call_output", call_id, output: [
      { type: "input_text", text: "Script completed\nWall time 4 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ chunk_id: "fixture", wall_time_seconds: 3.5, exit_code,
        original_token_count: 42, output: "fixture output ".repeat(20) }) },
    ] });
    writeFileSync(rollout, [
      { type: "session_meta", payload: { id: "session-test" } },
      event("02.123", { type: "custom_tool_call", name: "exec", call_id: "launch",
        input: 'const receipt = await tools.exec_command({cmd:"git status /private/source && a private string"});' }),
      event("02.500", { type: "reasoning", summary: [{ text: "private reasoning" }] }),
      event("03", { type: "custom_tool_call_output", call_id: "launch", output: "Script running with cell ID g10:11" }),
      event("unknown", { type: "reasoning", content: [{ text: "unclocked reasoning" }] }),
      event("04", { type: "function_call", name: "wait", call_id: "wait", arguments: '{"cell_id":"g10:11"}' }),
      event("05", { type: "function_call_output", call_id: "wait", output: [{ text: "Script completed\nraw result" }] }),
      { type: "event_msg", payload: { type: "token_count" } },
      event("05.100", { type: "reasoning" }),
      event("05.200", { type: "reasoning" }),
      event("06", { type: "custom_tool_call", name: "exec", call_id: "pending", input: 'text("await tools.apply_patch(");' }),
      event("06.200", { type: "function_call", name: "exec_command", call_id: "direct",
        arguments: '{"cmd":"node --test /private/source"}' }),
      event("06.300", { type: "function_call", name: "exec_command", call_id: "unknown-command",
        arguments: '{"cmd":"internal-executable private-target"}' }),
      event("06.400", { type: "custom_tool_call", name: "exec", call_id: "dynamic",
        input: 'await tools.exec_command({cmd:"rg" + privateValue});' }),
      event("06.500", { type: "custom_tool_call", name: "exec", call_id: "build-and-push",
        input: 'await tools.exec_command({cmd:`echo "cargo test"\nmkdir -p /private/build\nenv RUSTFLAGS=-g cargo +stable build && git -C /private/build push origin HEAD\nt3-build --jobs 2 -- cargo build`});' }),
      event("06.600", { type: "custom_tool_call", name: "exec", call_id: "parallel",
        input: 'await Promise.all([tools.write_stdin({session_id:12}), tools.exec_command({cmd:"cargo check"})]);' }),
      event("06.700", { type: "function_call", name: "exec_command", call_id: "literal",
        arguments: '{"cmd":"echo cargo build"}' }),
      event("06.710", { type: "custom_tool_call", name: "exec", call_id: "eligible",
        input: 'const r = await tools.exec_command({cmd:"cat a && cat b && git status"}); text(r);' }),
      event("06.720", { type: "custom_tool_call", name: "exec", call_id: "pipeline",
        input: 'text(await tools.exec_command({cmd:"cat a | cat b"}));' }),
      event("06.730", { type: "custom_tool_call", name: "exec", call_id: "failed",
        input: 'text(await tools.exec_command({cmd:"git status"}));' }),
      event("11", receipt("eligible", 0)),
      event("12", receipt("pipeline", 0)),
      event("13", receipt("failed", 1)),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const data = await readRollout(rollout, "codex-test", policy);
    assert.deepEqual(data.markers, [{ line: 3, at: Date.parse(time("02.500")) },
      { line: 9, at: Date.parse(time("05.100")), resultCall: "wait" },
      { line: 10, at: Date.parse(time("05.200")) }]);
    assert.deepEqual(data.calls.map(({ tool, command }) => [tool, command]),
      [["Shell command", "git status"], ["Cell wait", null], ["Tool script", null],
        ["Shell command", "node --test"], ["Shell command", null], ["Shell command", null],
        ["Shell command", null], ["Parallel tool script", null], ["Shell command", null],
        ["Shell command", "cat"], ["Shell command", "cat"], ["Shell command", "git status"]]);
    assert.deepEqual(data.calls.map(({ categories }) => categories),
      ["Git inspection + Unknown command", "Cell wait", "Unknown script", "JavaScript test", "Unknown command", "Unknown command",
        "Rust build + Git push + Shell output + File preparation", "Rust check + Process I/O", "Shell output",
        "Git inspection + File inspection", "File inspection", "Git inspection"]);
    saveRollout(path, data);
    saveRollout(path, data);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM codex_spans").get()?.n, 13);
      assert.equal(db.prepare("SELECT ended_ms-started_ms duration FROM codex_spans WHERE clock='async_cell'").get()?.duration, 2877);
      assert.equal(db.prepare("SELECT ended_ms FROM codex_calls WHERE call_id='pending'").get()?.ended_ms, null);
      const marker = db.prepare("SELECT source_line, observed_ms FROM codex_reasoning").all();
      assert.deepEqual(marker.map(Object.values),
        [[3, Date.parse(time("02.500"))], [9, Date.parse(time("05.100"))], [10, Date.parse(time("05.200"))]]);
      assert.deepEqual(db.prepare("SELECT source_line, result_call_id FROM codex_reasoning_inputs").all().map(Object.values),
        [[9, "wait"]]);
      assert.deepEqual(db.prepare("SELECT command FROM codex_commands ORDER BY command").all().map(Object.values),
        [["cat"], ["cat"], ["git status"], ["git status"], ["node --test"]]);
      assert.deepEqual(db.prepare("SELECT file_count, git_count, build_count, push_count, seconds FROM codex_command_mixes")
        .all().map(Object.values), [[2, 1, 0, 0, 3.5]]);
      assert.equal(db.prepare("SELECT count(*) n FROM codex_categories").get()?.n, data.calls.length);
      assert.equal(db.prepare("SELECT count(*) n FROM t3_runs").get()?.n, 2);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
    assert.ok(!JSON.stringify(data).includes("raw result"));
    assert.ok(!JSON.stringify(data).includes("a private string"));
    assert.ok(!JSON.stringify(data).includes("/private/source"));
    assert.ok(!JSON.stringify(data).includes("internal-executable"));
    assert.ok(!JSON.stringify(data).includes("private reasoning"));
    appendFileSync(rollout, [
      event("07", { type: "function_call", name: "wait", call_id: "duplicate", arguments: '{"cell_id":"g10:11"}' }),
      event("08", { type: "function_call_output", call_id: "duplicate", output: "Script completed" }),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    const ambiguous = await readRollout(rollout, "codex-test", policy);
    assert.equal(ambiguous.calls.find(({ id }) => id === "launch")?.asyncEnd, null);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
