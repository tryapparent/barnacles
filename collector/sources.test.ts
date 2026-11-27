import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { sourcePolicy, admissionPolicy, deliveryPolicy, type AdmissionPolicy, type DeliveryPolicy, deliveryReport, loadEvidence, waitReport, watchOverlaps, type PullRequest, type ReleaseEvidence, type RolloutEvidence, type SourcePolicy, type ThreadEvidence } from "../evidence/index.ts";
import { buildPolicies, loadPolicy } from "../tooling/bend.ts";
import { fileURLToPath } from "node:url";
import { pullRequest, releaseEvidence } from "./github/delivery.ts";
import { inspectRollout, readRollout } from "./codex/rollout.ts";
import { t3Snapshot } from "./t3.ts";

test("compiled Bend2 source decisions through the SQLite import path", async () => {
  const root = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(root);
  const job = mkdtempSync(join(root, "sources-test-"));
  try {
    const [sourceFile, admissionFile, deliveryFile] = await buildPolicies(job, [[sourcePolicy, "sources.mjs"], [admissionPolicy, "admission.mjs"], [deliveryPolicy, "delivery.mjs"]]);
    const policy = await loadPolicy<SourcePolicy>(sourceFile);
    const admission = await loadPolicy<AdmissionPolicy>(admissionFile);
    const reportPolicy = await loadPolicy<DeliveryPolicy>(deliveryFile);
    const time = (s: string) => `2026-01-01T12:00:${s}Z`;
    const repo = "synthetic/example";
    const merged = "a".repeat(40);
    const released = "b".repeat(40);
    const tag = `linux-main-v2-${released}`;
    const snapshot = {
      instance: "t3-test",
      thread: { threadId: "thread-1", createdAt: time("01.125"), updatedAt: time("30"),
        status: "completed", createdBy: "user", creationSource: "web", title: "  Review the release timeline  " },
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
    const saveDelivery = (pullRequest: PullRequest, release?: ReleaseEvidence) =>
      loadEvidence(path, { source: "github-delivery", pullRequest, release }, admission);
    const saveRollout = (rollout: RolloutEvidence) => loadEvidence(path, { source: "codex", rollout }, admission);
    const saveThread = (thread: ThreadEvidence) => loadEvidence(path, { source: "t3", thread }, admission);
    const pr = pullRequest(repo, 9, policy, read, true);
    assert.equal(pr.firstCommit?.sha, merged);
    assert.equal(pr.firstReview?.id, 7);
    assert.deepEqual(pr.firstCI, { id: 102, at: Date.parse(time("07")) / 1000 });
    const alternateRuns = (replace: (inventory: { total_count: number; workflow_runs: unknown[] }) => unknown) =>
      (path: string) => path.includes("/actions/runs?") ? replace(read(path) as { total_count: number; workflow_runs: unknown[] }) : read(path);
    assert.equal(pullRequest(repo, 9, policy, alternateRuns((runs) => ({ ...runs, total_count: 5 })), true).firstCI, null);
    assert.equal(pullRequest(repo, 9, policy, alternateRuns((runs) => ({
      total_count: 2, workflow_runs: [runs.workflow_runs[0], runs.workflow_runs[0]],
    })), true).firstCI, null);
    const repeatedCommits = (path: string) => {
      if (!path.includes("/commits?")) return read(path);
      const [first] = read(path) as object[];
      return [first, first];
    };
    const incomplete = pullRequest(repo, 9, policy, repeatedCommits, true);
    assert.equal(incomplete.commitsComplete, false);
    assert.equal(incomplete.firstCommit, null);
    assert.equal(incomplete.firstCI, null);
    const explicit = (path: string) => path.includes("/commits?") ? [] : alternateRuns((runs) => ({
      total_count: 1, workflow_runs: [{ ...(runs.workflow_runs[0] as object), head_repository: { id: 77 },
        pull_requests: [{ number: 9, base: { repo: { id: 4 } } }] }],
    }))(path);
    assert.equal(pullRequest(repo, 9, policy, (path) => path.includes("/commits?") ? [] : read(path), true).firstCI, null);
    assert.equal(pullRequest(repo, 9, policy, explicit, true).firstCI?.id, 102);
    const repeatedAssets = (path: string) => {
      if (!path.includes("/releases/")) return read(path);
      const release = read(path) as { assets: unknown[] };
      return { ...release, assets: [...release.assets, ...release.assets] };
    };
    const noProbe = releaseEvidence(pr, tag, policy, repeatedAssets, () => assert.fail("Ambiguous assets must not be probed"));
    assert.equal(noProbe.assetId, null);
    assert.equal(noProbe.shipped, false);
    const repeatedDispatch = (path: string) => {
      if (!path.includes("/actions/workflows/verification.yml/runs?")) return read(path);
      const releaseRuns = read(path) as { workflow_runs: unknown[] };
      return { total_count: 2, workflow_runs: [...releaseRuns.workflow_runs, ...releaseRuns.workflow_runs] };
    };
    const available = () => ({ http: 206, bytes: 1, range: true });
    assert.equal(releaseEvidence(pr, tag, policy, repeatedDispatch, available, true).dispatch, null);
    const failure = releaseEvidence(pr, tag, policy, read, () => ({ http: 206, bytes: 1, range: false }));
    saveDelivery(pr, failure);
    const unverified = deliveryReport(path, reportPolicy)[0];
    assert.equal(unverified.pr_to_release_seconds, null);
    assert.equal(unverified.coverage.release_link, "release_unverified");
    assert.equal(unverified.coverage.endpoints.published, "missing");
    assert.equal(unverified.coverage.stages.merge_to_publication, "missing_end");
    const proof = releaseEvidence(pr, tag, policy, read, () => ({ http: 206, bytes: 1, range: true }), true);
    saveDelivery(pr, proof);
    assert.equal(deliveryReport(path, reportPolicy)[0].first_ci_run, 102);
    assert.equal(deliveryReport(path, reportPolicy)[0].release_run, 205);
    saveDelivery(pr, { ...proof, id: 1, published: proof.published! + 1 });
    saveDelivery(pr, { ...proof, id: 12 });
    assert.equal(deliveryReport(path, reportPolicy)[0].release_id, 2);
    assert.equal(deliveryReport(path, reportPolicy)[0].pr_to_release_seconds, 5);
    assert.equal(deliveryReport(path, reportPolicy)[0].thread_to_release_seconds, null);

    const thread = t3Snapshot(snapshot, policy);
    assert.equal(thread.origin, "manual_t3");
    saveThread(thread);
    saveThread(thread);
    const delivered = deliveryReport(path, reportPolicy)[0];
    assert.equal(delivered.thread_to_release_seconds, 8.875);
    assert.equal(delivered.coverage.thread_link, "verified");
    assert.equal(delivered.thread_title, "Review the release timeline");
    assert.equal(delivered.coverage.release_link, "verified");
    assert.equal(delivered.coverage.stages.thread_to_commit, "observed");
    assert.equal(delivered.coverage.active_thread_work, "unknown");
    assert.equal(delivered.coverage.landed_ci_lineage, "unknown");
    assert.equal(delivered.coverage.human_blocking, "unknown");
    assert.equal(reportPolicy.delivery_thread_window({ $: "Time", s: Date.parse(time("01")) / 1000, ms: 125 },
      { $: "Time", s: Date.parse(time("02")) / 1000, ms: 0 }), "before_window_start");
    saveThread({ ...thread, id: "thread-2" });
    const ambiguousOwner = deliveryReport(path, reportPolicy)[0];
    assert.equal(ambiguousOwner.thread_to_release_seconds, null);
    assert.equal(ambiguousOwner.coverage.thread_link, "ambiguous_owner");
    assert.equal(ambiguousOwner.thread_title, null);
    assert.equal(ambiguousOwner.coverage.stages.thread_to_commit, "missing_start");
    saveThread({ ...thread, id: "thread-2", pullRequests: [] });
    saveThread({ ...thread, created: Date.parse(time("08")) });
    const badClock = deliveryReport(path, reportPolicy)[0];
    assert.equal(badClock.coverage.thread_link, "thread_clock_conflict");
    assert.equal(badClock.thread_title, null);
    assert.equal(badClock.coverage.stages.thread_to_publication, "clock_conflict");
    assert.equal(badClock.thread_to_release_seconds, null);
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
    saveRollout(data);
    saveRollout(data);
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
    assert.equal(ambiguous.quality?.missing_async_end, 1);
    assert.equal(ambiguous.quality?.mix_receipts, 1);
    assert.equal(ambiguous.quality?.mix_candidates, 2);
    assert.equal(ambiguous.quality?.mixed_without_receipt, 3);

    appendFileSync(rollout, [
      event("13.500", { type: "custom_tool_call", name: "exec", call_id: "substitution",
        input: 'text(await tools.exec_command({cmd:"cat $(git status)"}));' }),
      event("13.600", { type: "custom_tool_call", name: "exec", call_id: "wrong-binding",
        input: 'const r = await tools.exec_command({cmd:"git status"}); text(other);' }),
      event("13.700", receipt("substitution", 0)),
      event("13.800", receipt("wrong-binding", 0)),
      event("14", receipt("eligible", 0)),
      event("15", receipt("unseen", 0)),
      event("10", { type: "function_call", call_id: "unseen", name: "apply_patch" }),
      event("16", receipt("invalid identifier", 0)),
      event("17", { type: "reasoning" }),
    ].map((line) => JSON.stringify(line)).join("\n") + "\n{malformed\n");
    const broken = await readRollout(rollout, "codex-test", policy);
    assert.equal(broken.malformed, 2);
    assert.equal(broken.markers.at(-1)?.resultCall, undefined);
    assert.equal(broken.markers.at(-1)?.at, Date.parse(time("17")));
    assert.equal(broken.orphans, 1);
    assert.equal(broken.calls.at(-1)?.id, "unseen");
    assert.equal(broken.calls.at(-1)?.end, null);
    for (const call of ["eligible", "substitution", "wrong-binding"]) {
      const rejected = broken.calls.find(({ id }) => id === call);
      assert.ok(rejected);
      assert.equal(rejected.mix, undefined);
    }

    const damaged = join(job, "damaged.jsonl");
    writeFileSync(damaged, JSON.stringify({ type: "session_meta", payload: { id: "valid" } }) + "\n" +
      "{invalid}\n" + "x".repeat(8 * 1024 * 1024 + 1) + "\n" +
      JSON.stringify(event("04", { type: "function_call", name: "exec_command", call_id: "after-gap" })) + "\n" +
      JSON.stringify(event("05", { type: "function_call_output", call_id: "after-gap" })));
    const { data: partial, receipt: diagnostic } = await inspectRollout(damaged, "codex-test", policy);
    assert.equal(partial?.calls[0].line, 4);
    assert.equal(partial?.calls[0].end, null);
    assert.equal(partial?.quality?.missing_end, 1);
    assert.equal(diagnostic.malformed, 1);
    assert.equal(diagnostic.oversized, 1);
    assert.equal(diagnostic.cutoffLines, 1);
    assert.ok(diagnostic.cutoffBytes > 0);
    assert.equal(diagnostic.lines, 4);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("rollout CLI keeps fork lineage, rejects unproven input, and preserves replay", () => {
  const root = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(root);
  const job = mkdtempSync(join(root, "fork-test-"));
  try {
    const input = join(job, "synthetic.jsonl");
    const archive = join(job, "synthetic.jsonl.zst");
    const time = "2026-01-01T12:00:00Z";
    const meta = (payload: object) => ({ type: "session_meta", payload });
    const item = (type: string, call_id: string) => ({ type: "response_item", timestamp: time,
      payload: { type, call_id, name: "exec_command" } });
    const fork = [
      meta({ id: "child", session_id: "parent", parent_thread_id: "parent", forked_from_id: "parent",
        subagent_history_start_ordinal: 4 }),
      meta({ id: "parent", session_id: "parent" }),
      item("function_call", "inherited-only"),
      item("function_call", "shared-call"),
      item("function_call_output", "inherited-only"),
      item("function_call", "shared-call"),
      item("function_call_output", "shared-call"),
    ];
    const jsonl = (records: object[]) =>
      records.map((record, ordinal) => JSON.stringify({ ordinal, ...record })).join("\n") + "\n";
    const write = (records: object[]) => writeFileSync(input, jsonl(records));
    const cli = (command: string, ...args: string[]) => spawnSync(process.execPath,
      [fileURLToPath(new URL("./import-sources.ts", import.meta.url)), job, command, ...args], { encoding: "utf8" });
    write(fork);
    for (let replay = 0; replay < 2; replay++) {
      const result = cli("rollout", "synthetic", input, "fork-file");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "admitted_fork_suffix");
    }
    writeFileSync(archive, zstdCompressSync(Buffer.from(jsonl(fork))));
    const compressed = cli("rollout", "synthetic", archive, "fork-file");
    assert.equal(compressed.status, 0, compressed.stderr);
    assert.equal(JSON.parse(compressed.stdout).status, "admitted_fork_suffix");
    writeFileSync(archive, Buffer.from("invalid compressed data"));
    const invalidArchive = cli("rollout", "synthetic", archive, "invalid-archive");
    assert.equal(invalidArchive.status, 1);
    assert.match(invalidArchive.stderr, /read_failed/);
    writeFileSync(archive, zstdCompressSync(Buffer.alloc(128 * 1024 * 1024 + 1, 120)));
    const expanded = cli("rollout", "synthetic", archive, "expanded-file");
    assert.equal(expanded.status, 1);
    assert.match(expanded.stderr, /oversized/);
    write([...fork, { ...item("function_call", "bad-ordinal"), ordinal: 10 }]);
    const unproven = cli("rollout", "synthetic", input, "unproven-file");
    assert.equal(unproven.status, 1);
    assert.match(unproven.stderr, /unproven_fork/);
    write([meta({ id: "one" }), item("function_call", "discarded"), meta({ id: "two" })]);
    const conflict = cli("rollout", "synthetic", input, "conflicting-file");
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /conflicting_metadata/);
    truncateSync(input, 128 * 1024 * 1024 + 1);
    const oversized = cli("rollout", "synthetic", input, "oversized-file");
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /oversized/);
    const result = cli("rollout-coverage");
    assert.equal(result.status, 0, result.stderr);
    const coverage = JSON.parse(result.stdout);
    assert.deepEqual(coverage.imports.map(({ source_key, status, inherited_lines, read_bytes }) =>
      [source_key, status, inherited_lines, read_bytes > 0]), [
      ["conflicting-file", "conflicting_metadata", 0, true],
      ["expanded-file", "oversized", 0, true],
      ["fork-file", "admitted_fork_suffix", 3, true],
      ["invalid-archive", "read_failed", 0, true],
      ["oversized-file", "oversized", 0, false],
      ["unproven-file", "unproven_fork", 3, true],
    ]);
    assert.deepEqual(coverage.sessions.map(({ session_id, source_key, orphan_count }) =>
      [session_id, source_key, orphan_count]), [["child", "fork-file", 1]]);
    const db = new DatabaseSync(join(job, "evidence.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT session_id, call_id, source_line FROM codex_calls").all().map(Object.values),
        [["child", "shared-call", 6]]);
    } finally { db.close(); }
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("nested wait receipts, recycled handles and exact watcher overlap through the source importer", async (t) => {
  const root = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(root);
  const job = mkdtempSync(join(root, "waits-test-"));
  try {
    const rollout = join(job, "waits.jsonl");
    const sha = "a".repeat(40);
    const epoch = Date.parse("2026-01-01T12:00:00Z");
    const event = (s: number, payload: object) => ({
      timestamp: new Date(epoch + s * 1000).toISOString(), type: "response_item", payload,
    });
    const body = (fields: object) => JSON.stringify({
      chunk_id: "fixture", original_token_count: 0, wall_time_seconds: 0.25,
      output: "private process output", ...fields,
    });
    const wrapped = (fields: object) => [
      { type: "input_text", text: "Script completed\nWall time 1 seconds\nOutput:\n" },
      { type: "input_text", text: body(fields) },
    ];
    const script = (t: number, id: string, input: string) =>
      event(t, { type: "custom_tool_call", name: "exec", call_id: id, input });
    const result = (t: number, id: string, output: unknown) =>
      event(t, { type: "custom_tool_call_output", call_id: id, output });
    const call = (t: number, id: string, name: string, args: object) =>
      event(t, { type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
    const wait = (t: number, id: string, cell_id: string) => call(t, id, "wait", { cell_id });
    const watcher = (attempt: number) => `umask 077; python3 /private/gh_owned_wait.py 12345678901 --repo Synthetic/Example --head ${sha} --attempt ${attempt} --timeout 600 --interval 15 > /private/log 2>&1`;
    const direct = (t: number, id: string, attempt: number) => call(t, id, "exec_command", { cmd: watcher(attempt) });
    const poll = (t: number, id: string, session_id: number) => call(t, id, "write_stdin", { session_id, chars: "" });
    const entries = [
      { type: "session_meta", payload: { id: "test-session" } },
      script(1, "launch-a", `const r = await tools.exec_command({cmd:${JSON.stringify(watcher(1))}}); text(r);`),
      result(2, "launch-a", "Script running with cell ID c:1"),
      wait(3, "wait-launch", "c:1"),
      result(4, "wait-launch", wrapped({ session_id: 41 })),
      direct(5, "launch-b", 1),
      result(6, "launch-b", body({ session_id: 42 })),
      direct(7, "launch-c", 2),
      result(8, "launch-c", body({ session_id: 43 })),
      script(9, "poll-a", 'for(let i=0;i<2;i++){const r=await tools.write_stdin({session_id:41,chars:""});if(!r.session_id || i===1){text(r);break;}}'),
      result(10, "poll-a", "Script running with cell ID c:2"),
      wait(11, "interim-a", "c:2"),
      poll(12, "poll-b", 42),
      result(12.5, "interim-a", "Script running with cell ID c:2"),
      wait(13, "terminal-a", "c:2"),
      poll(13.5, "poll-c", 43),
      result(14, "poll-c", body({ exit_code: 0 })),
      result(15, "poll-b", body({ session_id: 42 })),
      result(16, "terminal-a", wrapped({ exit_code: 0 })),
      direct(17, "recycled", 1),
      result(18, "recycled", body({ session_id: 41 })),
      poll(19, "poll-recycled", 41),
      result(20, "poll-recycled", body({ exit_code: 0 })),
      direct(21, "handle-collision", 1),
      result(22, "handle-collision", body({ session_id: 42 })),
      script(23, "poll-collision", "text(await tools.write_stdin({session_id:42}));"),
      result(24, "poll-collision", "Script running with cell ID c:3"),
      wait(25, "wait-collision", "c:3"),
      result(26, "wait-collision", wrapped({ exit_code: 0 })),
      script(27, "dynamic", "text(await tools.write_stdin({session_id:load('private-key')}));"),
      result(28, "dynamic", "Script running with cell ID c:4"),
      wait(29, "wait-dynamic", "c:4"),
      result(30, "wait-dynamic", wrapped({ exit_code: 0 })),
      script(31, "multiple", "text(await Promise.all([tools.write_stdin({session_id:56}), tools.write_stdin({session_id:57})]));"),
      result(32, "multiple", "Script running with cell ID c:5"),
      wait(33, "wait-multiple", "c:5"),
      result(34, "wait-multiple", wrapped({ output: "x".repeat(256 * 1024), exit_code: 0 })),
      script(35, "loop", "for(let i=0;i<2;i++) text(await tools.write_stdin({session_id:56}));"),
      result(36, "loop", "Script running with cell ID c:6"),
      wait(37, "wait-loop", "c:6"),
      result(38, "wait-loop", wrapped({ exit_code: 0 })),
      wait(39, "wait-missing", "c:7"),
      result(40, "wait-missing", wrapped({ exit_code: 0 })),
      call(41, "unqualified", "exec_command", { cmd: "gh run watch 12345678901 --repo synthetic/example" }),
      result(42, "unqualified", body({ session_id: 44 })),
      poll(43, "poll-unqualified", 44),
      result(44, "poll-unqualified", body({ exit_code: 0 })),
      direct(45, "missing-receipt-launch", 1),
      result(46, "missing-receipt-launch", "raw output"),
      poll(47, "missing-receipt-poll", 45),
      result(48, "missing-receipt-poll", body({ exit_code: 0 })),
      direct(49, "contradictory-launch", 1),
      result(50, "contradictory-launch", body({ session_id: 46 })),
      poll(51, "contradictory-poll", 46),
      result(52, "contradictory-poll", body({ session_id: 47 })),
      poll(53, "ambiguous-poll", 47),
      result(54, "ambiguous-poll", body({ exit_code: 0 })),
      call(55, "before-barrier", "exec_command", { cmd: "git status" }),
      result(56, "before-barrier", body({ session_id: 48 })),
      script(57, "barrier-without-result", "text(await tools.write_stdin({session_id:load('unknown')}));"),
      poll(58, "after-barrier", 48),
      result(59, "after-barrier", body({ exit_code: 0 })),
      call(60, "duplicate-receipt", "exec_command", { cmd: "git status" }),
      result(61, "duplicate-receipt", "unstructured first result"),
      result(62, "duplicate-receipt", body({ session_id: 49 })),
      script(63, "loop-launch", 'for(let i=0;i<2;i++){const r=await tools.exec_command({cmd:"git status"});if(!r.session_id){text(r);break;}}'),
      result(64, "loop-launch", wrapped({ session_id: 50 })),
      call(65, "pipeline", "exec_command", { cmd: watcher(1).replace(" > /private/log 2>&1", " | cat") }),
      result(66, "pipeline", body({ session_id: 51 })),
    ];
    writeFileSync(rollout, entries.map((item) => JSON.stringify(item)).join("\n") + "\n");
    const importer = (args: string[]) => execFileSync(process.execPath, [
      new URL("./import-sources.ts", import.meta.url).pathname, job, ...args,
    ], { encoding: "utf8", env: { ...process.env, TMPDIR: job } });
    assert.equal(JSON.parse(importer(["rollout", "test-instance", rollout])).status, "admitted");
    const path = join(job, "evidence.sqlite");
    const [sourceFile, admissionFile] = await buildPolicies(job, [[sourcePolicy, "test-sources.mjs"], [admissionPolicy, "admission.mjs"]]);
    const policy = await loadPolicy<SourcePolicy>(sourceFile);
    const admission = await loadPolicy<AdmissionPolicy>(admissionFile);
    const saveRollout = (rollout: RolloutEvidence) => loadEvidence(path, { source: "codex", rollout }, admission);
    const report = waitReport(path, "test-session", null);
    assert.deepEqual(report.waits.map((row) => [row.call_id, row.cell_status, row.process_status]), [
      ["wait-launch", "linked_cell", "process_opened"],
      ["interim-a", "linked_cell", "process_exited"],
      ["terminal-a", "linked_cell", "process_exited"],
      ["wait-collision", "linked_cell", "ambiguous_process_handle"],
      ["wait-dynamic", "linked_cell", "dynamic_process_handle"],
      ["wait-multiple", "linked_cell", "multiple_process_invocations"],
      ["wait-loop", "linked_cell", "unsupported_process_wrapper"],
      ["wait-missing", "missing_cell_launch", null],
    ]);
    const terminal = report.waits.find((row) => row.call_id === "terminal-a");
    assert.equal(terminal?.process_launch_call_id, "launch-a");
    assert.equal(terminal?.receipt_kind, "ExitReceipt");
    assert.equal(terminal?.result_call_id, "terminal-a");
    const lookup = JSON.parse(importer(["waits", "test-session", "terminal-a"]));
    assert.deepEqual(lookup.waits.map((row: { call_id: string }) => row.call_id), ["terminal-a"]);
    assert.deepEqual([terminal?.repository, terminal?.run_id, terminal?.head_sha, terminal?.attempt],
      ["synthetic/example", "12345678901", sha, "1"]);
    assert.equal(report.waits.find((row) => row.call_id === "wait-multiple")?.receipt_kind, "InvalidReceipt");
    const key = policy.watch_identity("SYNTHETIC/example", "12345678901", sha, "1");
    const overlap = watchOverlaps(path, policy, key);
    assert.equal(overlap.observations, 3);
    assert.equal(importer(["watch-overlaps", "synthetic/example", "12345678901", sha, "1"]),
      JSON.stringify(overlap, null, 2) + "\n");
    assert.equal(watchOverlaps(path, policy, policy.watch_identity("synthetic/example", "12345678901", "b".repeat(40), "1")).observations, 0);
    assert.deepEqual(overlap.overlaps.map((row) => [
      row.first.process_launch_call_id, row.second.process_launch_call_id, row.started_ms, row.ended_ms,
    ]), [["launch-a", "launch-b", epoch + 12000, epoch + 15000]]);
    assert.equal(watchOverlaps(path, policy, policy.watch_identity("synthetic/example", "12345678901", sha, "2")).overlaps.length, 0);
    const data = await readRollout(rollout, "test-instance", policy);
    const observations = data.waitAttribution!.observations;
    const polls = observations.filter(({ call }) => ["poll-a", "poll-b", "poll-c"].includes(call));
    assert.deepEqual(polls.map(({ call, resultCall }) => [call, resultCall]), [
      ["poll-c", "poll-c"], ["poll-b", "poll-b"], ["poll-a", "terminal-a"],
    ]);
    const observation = (call: string) => observations.find((row) => row.call === call)!;
    assert.equal(observation("barrier-without-result").resultLine, null);
    assert.equal(observation("after-barrier").fact.status, "ambiguous_process_handle");
    assert.equal(observation("duplicate-receipt").fact.receipt.$, "MissingReceipt");
    assert.equal(observation("duplicate-receipt").handle, null);
    assert.equal(observation("loop-launch").fact.status, "unsupported_process_wrapper");
    assert.equal(observation("pipeline").fact.watch.$, "NoWatch");
    assert.ok(!JSON.stringify(data).includes("private process output"));
    assert.ok(!JSON.stringify(data).includes("/private/"));
    saveRollout(data);
    assert.deepEqual(waitReport(path, "test-session", null), report);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT process_launch_call_id FROM codex_process_receipts WHERE call_id='poll-recycled'").get()?.process_launch_call_id, "recycled");
      assert.deepEqual(Object.values(db.prepare("SELECT process_category, repository FROM codex_process_receipts WHERE call_id='poll-unqualified'").get()!),
        ["GitHub watcher with incomplete identity", null]);
      assert.equal(db.prepare("SELECT process_status FROM codex_process_receipts WHERE call_id='missing-receipt-poll'").get()?.process_status, "missing_process_launch");
      assert.deepEqual(db.prepare("SELECT process_status, process_launch_call_id FROM codex_process_receipts WHERE call_id IN ('contradictory-poll', 'ambiguous-poll') ORDER BY call_id").all().map(Object.values),
        [["ambiguous_process_handle", null], ["contradictory_process_receipt", null]]);
      const facts = db.prepare("SELECT run_id, attempt, identity_exact FROM actions_wait_facts ORDER BY started_ms").all();
      assert.deepEqual(facts.map(Object.values), ["1", "1", "2", "1"].map((attempt) => ["12345678901", attempt, 1]));
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
    appendFileSync(rollout, "{malformed\n");
    saveRollout(await readRollout(rollout, "test-instance", policy));
    const incomplete = waitReport(path, "test-session", "terminal-a");
    assert.equal(incomplete.coverage[0].malformed_count, 1);
    assert.equal(incomplete.waits[0].cell_status, "incomplete_rollout");
    assert.equal(watchOverlaps(path, policy, key).observations, 0);

    await t.test("orders 12,000 results without consuming the JavaScript stack", async () => {
      const large = join(job, "large-rollout.jsonl");
      const count = 12_000;
      const starts = Array.from({ length: count }, (_, index) =>
        call(1, `ordered-${index}`, "exec_command", { cmd: "git status" }));
      const results = Array.from({ length: count }, (_, index) =>
        result(2, `ordered-${count - 1 - index}`, body({ session_id: index + 1 })));
      writeFileSync(large, [{ type: "session_meta", payload: { id: "large-session" } }, ...starts, ...results]
        .map((item) => JSON.stringify(item)).join("\n") + "\n");
      const ordered = (await readRollout(large, "test-instance", policy)).waitAttribution!.observations;
      assert.equal(ordered.length, count);
      for (const [index, row] of ordered.entries()) {
        assert.equal(row.call, `ordered-${count - 1 - index}`);
        assert.equal(row.handle, String(index + 1));
        assert.equal(row.fact.status, "process_opened");
      }
    });
  } finally { rmSync(job, { recursive: true, force: true }); }
});

test("bottleneck replay separates clocks, distinct peers and observed recoveries", () => {
  const root = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(root);
  const job = mkdtempSync(join(root, "bottleneck-test-"));
  try {
    const file = join(job, "facts.ndjson");
    const replay = (facts: Record<string, unknown>[]) => {
      writeFileSync(file, facts.map((fact) => JSON.stringify(fact)).join("\n") + "\n");
      return execFileSync(process.execPath, [
        fileURLToPath(new URL("./import-sources.ts", import.meta.url)), job, "bottlenecks", file,
      ], { encoding: "utf8" });
    };
    const read = { kind: "file", thread: "t", id: "a", path: "README.md", at: 100 };
    const timing = { kind: "timing", id: "job", clock: "runner", operation: "build", start: 100, end: 229 };
    const attempt = { kind: "attempt", thread: "t", id: "first", key: "gate:v1", start: 101, end: 110,
      failed: true, succeeded: false };
    const peer = { kind: "peer", thread: "t", id: "", clock: "runner", cohort: "workflow:job:runner",
      revision: "", start: 0, end: 0, eligible: true };
    const normal = Array.from({ length: 8 }, (_, i) => ({
      ...peer, id: `job-${i}`, revision: `sha-${i}`, start: 300 + 10 * i, end: 310 + 10 * i,
    }));
    const diagnostic = { kind: "diagnostic", thread: "t", id: "checker", failed: true,
      line: "Staged checker could not load installed tools; run setup" };
    const jobResult = { kind: "job-result", thread: "t", id: "run:2:job", conclusion: "failure" };
    const admission = { kind: "hosted-admission", thread: "t", id: "run:7:job", conclusion: "cancelled",
      assigned: false, steps: 0, annotation: "The job was not acquired by Runner of type hosted even after multiple attempts" };
    const notice = { kind: "t3-pr-notice", thread: "t", sourceThread: "t", id: "notice-1", visibility: "local",
      status: "completed", truncated: false, linkedPr: 42, message: "#42: merge conflict" };
    const forge = { kind: "forge-response", thread: "t", id: "request", operation: "github-pr-create",
      status: 500, failed: true, identified: true };
    const rerun = { kind: "job-rerun-response", thread: "t", id: "rerun", job: "123456789012",
      line: "job 123456789012 cannot be rerun", failed: true };
    const localAdmission = { kind: "local-build-admission", thread: "t", id: "local-admission", waitMs: 64_130,
      boundMs: 90_000, allocated: 1, capacity: 10 };
    const apt = { kind: "hosted-apt-result", thread: "t", id: "apt-step", conclusion: "failure", exitCode: 100,
      httpStatus: 404, archive: "/ubuntu/pool/example/staged_1.deb",
      summary: "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?" };
    const width = { ...diagnostic, id: "width",
      line: "pre-commit: staged candidate exceeds the directory-width limit:" };
    const admissionTimeout = { kind: "local-admission-timeout", thread: "t", id: "admission-timeout", exitCode: 124,
      line: "t3-build: timed out waiting for admission" };
    const artifactConflict = { kind: "hosted-publish-result", thread: "t", id: "artifact-conflict",
      publisher: "onboarding-release", conclusion: "failure", exitCode: 1, status: 0,
      line: "Error: Onboarding release onboarding-v1.2.3 exists with a different or unfinished artifact" };
    const uploadError = { ...artifactConflict, id: "upload-error", publisher: "github-release-assets", status: 500,
      line: "HTTP 500 (https://uploads.github.com/repos/example/capture/releases/123/assets)" };
    const markerTimeout = { kind: "benchmark-marker", thread: "t", id: "marker", lane: "record-start",
      conclusion: "failure", exitCode: 1, sameBuild: true, started: 200, ended: 370,
      line: "Error: Startup benchmark timed out at painted recording marker" };
    const pressureRejected = { kind: "benchmark-pressure", thread: "t", id: "pressure", lane: "record-stop",
      conclusion: "failure", exitCode: 1, sameBuild: true, started: 200, ended: 1500,
      source: "stop-result", qualified: false, scorePresent: false, pressureRejected: true };
    const superseded = { kind: "hosted-deploy-result", thread: "t", id: "superseded-deploy", service: "connect-worker",
      conclusion: "failure", exitCode: 1, accepted: false,
      line: "AssertionError [ERR_ASSERTION]: Candidate superseded by affected main changes",
      phaseLine: "at admission (file:///test/connect/tooling/hosting/scripts/deploy.ts:45:10)" };
    const readback = { ...superseded, id: "readback-timeout", service: "public-pages", accepted: true,
      line: "DOMException [TimeoutError]: The operation was aborted due to timeout",
      phaseLine: "at async verifyReady (file:///test/public/enablement/cd/publish-pages.ts:230:18)" };
    const smokeFailure = { kind: "hosted-test-failure", thread: "t", id: "first-test", scope: "pr-5",
      lane: "desktop-linux", test: "capture-smoke", execution: "run:1:job", conclusion: "failure", at: 200 };
    const packageBuild = { kind: "package-build-result", thread: "t", id: "first-build", scope: "run:1:job:step",
      tool: "vite-production-client", digest: "manifest", assets: 55, reportedMs: 30_760, start: 200, end: 230 };
    const modelFetch = { kind: "native-model-fetch-result", thread: "t", id: "model-download",
      step: "Prepare locked native prerequisites before first Cargo", conclusion: "failure", exitCode: 1, status: 502,
      revision: "0123456789012345678901234567890123456789",
      line: "Error: Download failed for https://huggingface.co/example/model/resolve/0123456789012345678901234567890123456789/onnx/model.onnx (502)",
      origin: "download:record/media/circle-vision/build.ts", started: 500, ended: 613 };
    const captureAccess = { kind: "capture-access-result", thread: "t", id: "unavailable-capture",
      operation: "apparent-inspect", failed: true, line: "Error: Capture unavailable (not_found)." };
    const benchmarkAdmission = { kind: "benchmark-admission", thread: "t", id: "smt-subset",
      lane: "connect-watch", conclusion: "failure", exitCode: 1, started: 700, ended: 791,
      origin: "main:connect/enablement/benchmark/hosted.ts",
      line: "AssertionError [ERR_ASSERTION]: No complete SMT subset qualified during replay probing" };
    const watchWake = { kind: "t3-pr-watch-wake", thread: "t", id: "wake", watchId: "watch-start", number: 42,
      message: "#42: checks passed", registeredAt: 90, parkedAt: 100, priorOrdinal: 1, nextOrdinal: 2,
      noticeStamp: "1970-01-01T00:03:00.005Z", requestedStamp: "1970-01-01T00:03:00.005Z" };
    const toolchainFetch = { kind: "toolchain-fetch-result", thread: "t", id: "bend-source",
      step: "Prepare locked native prerequisites before first Cargo", conclusion: "failure", exitCode: 1, status: 503,
      asset: "base.bend", line: "Error: Bend toolchain download failed for base.bend: 503",
      origin: "prepareBend:shared/enablement/bend/toolchain.ts", started: 100, ended: 113 };
    const socketPreflight = { kind: "socket-preflight", thread: "t", id: "socket-limit", required: 112, limit: 107,
      line: "RuntimeError: verification TMPDIR preflight: socket fixture needs 112 pathname bytes; platform permits 107.",
      origin: "check_temp_environment:enablement/verification.py" };
    const fanout = { kind: "hosted-test-fanout", thread: "t", id: "fanout-first", scope: "pr-42",
      lane: "lane-one", revision: "f".repeat(40), failure: "assertion", conclusion: "failure", at: 200 };
    const aptMirror = { kind: "apt-mirror-probe", thread: "t", id: "mirror-probe",
      step: "Run ./.github/actions/ubuntu-apt", conclusion: "failure", exitCode: 1,
      mirrorA: "mirror-a.example", mirrorB: "mirror-b.example", started: 100, ended: 111,
      line: "No tested Ubuntu mirror completed the bounded APT manifest/index probe" };
    const pagesAuth = { ...readback, id: "pages-auth", accepted: false, line: "Error: Cloudflare API HTTP 401",
      phaseLine: "at async currentMain (file:///test/public/enablement/cd/publish-pages.ts:149:19)" };
    const quota = { kind: "actions-rate-limit", thread: "t", id: "job-read-quota", operation: "actions-job-read",
      status: 403, failed: true, line: "gh: API rate limit exceeded (HTTP 403)" };
    const poll = { kind: "local-verification-poll", thread: "t", id: "poll-1", turn: "turn",
      invocation: "verification-unit", state: "active", at: 200 };
    const vmBoot = { kind: "vm-driver-result", thread: "t", id: "vm-boot", stage: "boot",
      failureType: "TimeoutError", exitCode: 1, driverExit: 255, scenarioStarted: false, command: "ssh",
      line: "guest user desktop did not become ready within 150s", required: "none", elapsedMs: 150_520 };
    const vmReady = { ...vmBoot, id: "vm-ready", stage: "readiness", failureType: "CalledProcessError",
      driverExit: 69, line: "missing required guest command: compositor", required: "compositor", elapsedMs: 0 };
    const statusGate = { kind: "workflow-status-gate", thread: "t", id: "portable-gate", dependentJob: "linux",
      prerequisite: "portable", attemptStarted: 80, earliestJobStarted: 90, previousCompleted: 100, gateCompleted: 220,
      dependentStarted: 222 };
    const ownership = { kind: "connect-deployment-receipt", thread: "t", id: "activation",
      conclusion: "failure", exitCode: 1, revision: "f".repeat(40), receiptRevision: "f".repeat(40),
      phase: "active-unverified", line: "AssertionError [ERR_ASSERTION]: Another publisher owns the active deployment",
      origin: "verifyActivationHistory:connect/tooling/hosting/scripts/profile.ts", started: 100, ended: 108 };
    const alreadyActive = { ...ownership, id: "already-active", phase: "preflight", started: 200, ended: 210,
      line: 'AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly unequal to:',
      origin: "candidate-not-equal-previous:connect/tooling/hosting/scripts/deploy.ts",
      previousVersion: "v-digest", comparedVersion: "v-digest" };
    const pendingCapture = { ...captureAccess, id: "upload-pending", operation: "apparent-fetch",
      line: "Error: Capture is still pending; retry fetch later" };
    const unsafeOutput = { ...captureAccess, id: "shared-dir",
      line: "Error: Unsafe shared or unowned directory tree; run apparent connect alternatives for local inspection and authorized transfer options" };
    const timingFixture = { kind: "pre-push-timing-fixture", thread: "t", id: "fixture-timing",
      operation: "git-push", setting: "APPARENT_TIMING_FILE", fixture: "enablement/tests/test_pre_push_guard.py",
      actual: "--offline --timings", expected: "--offline", line: "pre-push: verification failed; push rejected",
      failed: true, suiteElapsedMs: 68_216 };
    const reuseRefusal = { kind: "main-verification-reuse", thread: "t", id: "reuse-refusal", event: "push",
      step: "Run node --experimental-strip-types enablement/ci/routing/evidence.ts --reuse", conclusion: "success",
      line: "Verification definitions changed; fresh main suites required." };
    const cacheConflict = { kind: "hermes-validator-cache-copy", thread: "t", id: "cache-copy",
      step: "Install supported Hermes validator", conclusion: "failure", exitCode: 1, code: "EEXIST", syscall: "cp",
      origin: "installCandidate:hermes/enablement/ci/validator-job.ts", restored: true };
    const actorCancellation = { ...admission, id: "actor-cancelled", annotation: "The run was canceled by @example." };
    const boundary = { kind: "local-verification-boundary", thread: "t", id: "selector-refused", operation: "git-push",
      boundary: "local-test-selector", failed: true, terminal: "pre-push: verification failed; push rejected",
      line: "Error: Conservative engine coverage is outside the automatic workflow filters; update the consumer inventory before admission" };
    const dirty = "pre-push: working tree changed during verification; push rejected";
    const expiry = { kind: "hosted-client-approval-fixture", thread: "t", id: "fixture-expiry",
      step: "Independent Connect client build and tests", conclusion: "failure",
      test: "test_support::encrypted_tests::encrypted_settings_future_capture_restart_retry_and_disconnect",
      line: "called `Result::unwrap()` on an `Err` value: Expired",
      origin: "login_with_approval:connect/client/src/test_support/encrypted_tests.rs" };
    const aptDeadline = { kind: "hosted-apt-job-deadline", thread: "t", id: "apt-media", package: "ffmpeg",
      step: "Install recipient media fixture dependency", jobConclusion: "cancelled", stepConclusion: "success",
      deadlineSeconds: 1500, attemptStarted: 90, jobStarted: 100, jobEnded: 1613, started: 144, ended: 1587 };
    const aptDeadlineDisk = { ...aptDeadline, id: "apt-disk", package: "qemu-utils",
      step: "Install disk-image contract dependency (no KVM required)", stepConclusion: "cancelled", started: 1587, ended: 1612 };
    const issueTrailer = { ...boundary, id: "issue-trailer", boundary: "issue-trailer",
      line: "Commit needs a final Issue trailer", terminal: "error: failed to push some refs" };
    const prObserver = { kind: "exact-pr-check-observer", thread: "t", id: "pr-head-observer",
      repository: "example/app", pr: 51, revision: "a".repeat(40),
      beforeRepository: "example/app", beforePr: 51, beforeRevision: "a".repeat(40),
      afterRepository: "example/app", afterPr: 51, afterRevision: "a".repeat(40),
      timeoutSeconds: 2700, exitCode: 0, elapsedMs: 1_423_730 };
    const selectorBase = { kind: "hosted-selector-base", thread: "t", id: "old-base", event: "pull_request",
      step: "Select through the shared consumer authority", conclusion: "success", command: "bun engine/tools/select.ts",
      checkout: "a".repeat(40), selectorHead: "a".repeat(40), jobHead: "b".repeat(40), firstParent: "c".repeat(40),
      secondParent: "b".repeat(40), base: "d".repeat(40), ancestor: true, intervening: 2 };
    const execLaunch = { kind: "local-exec-launch", thread: "t", id: "exec-launch", sourceThread: "t",
      visibility: "local", itemType: "command_execution", status: "failed", truncated: false,
      line: "Failed to create unified exec process: No such file or directory (os error 2)" };
    const runWatch = { kind: "run-watch-deadline", thread: "t", id: "run-watch-expired", operation: "gh-run-watch",
      launchHandle: 42, terminalHandle: 42, exitStatus: true, exitCode: 124, timeout: 1800, elapsedMs: 1_802_000 };
    const statusRead = { kind: "manual-ci-status-read", thread: "t", id: "manual-first", repository: "example/app",
      run: "12345678901", attempt: 1, snapshot: "a".repeat(40), at: 100, pending: true, mode: "manual-watcher-log" };
    const sourceBudget = { kind: "staged-source-budget", thread: "t", id: "budget-refusal", operation: "git-commit",
      phase: "budgets/style", unit: "source-tokens", path: "tool/tests/suite.ts", actual: 5131, allowance: 4000, failed: true };
    const bunTimeout = { kind: "hosted-bun-test-deadline", thread: "t", id: "fixture-deadline", step: "Run bun test tests/",
      conclusion: "failure", diagnostic: "done-callback-deadline", path: "tests/workflow.test.ts", test: "Missing tools stay fail-closed",
      exitCode: 1, budgetMs: 5000, elapsedMs: 5159 };
    const prRefs = { kind: "github-pr-ref-resolution", thread: "t", id: "pr-unresolved-refs", base: "main", head: "t3/example", failed: true,
      line: "pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between main and t3/example, Head ref must be a branch (createPullRequest)" };
    const workflowScope = { kind: "github-workflow-scope-refusal", thread: "t", id: "push-scope", operation: "git-push-https",
      workflow: ".github/workflows/release.yml", diagnostic: "oauth-workflow-scope", failed: true };
    const missingWorktree = { kind: "t3-worktree-missing", thread: "t", id: "missing-checkout", expected: "a".repeat(40),
      path: "a".repeat(40), operation: "ls-worktree", diagnostic: "enoent", failed: true };
    const providerAudio = { kind: "provider-input-rejection", thread: "t", id: "rejected-audio", sourceThread: "t",
      visibility: "local", itemType: "error", itemStatus: "failed", truncated: false, status: 400,
      errorType: "invalid_request_error", parameter: "input", code: "unsupported_parameter", message: "Audio input is not supported for this request." };
    const reporterWrite = { kind: "hosted-status-write-rejected", thread: "t", id: "reconcile-quota", writer: "verification-status-reporter",
      step: "Reconcile all PRs using trusted default-branch policy", conclusion: "failure", method: "POST", endpoint: "commit-status",
      revision: "a".repeat(40), status: 403, reason: "installation-rate-limit", exitCode: 1 };
    const nativeProbe = { kind: "hosted-macos-automation-probe", thread: "t", id: "system-events-probe",
      step: "Native Mac Storage and error-reporting controls against the installed Rust GUI", conclusion: "failure",
      fixture: "capture/desktop/ui/frontend/tests/mac-storage-native.cjs", command: "system-events-ui-elements-enabled",
      failure: "ERR_TEST_FAILURE", exitCode: 1 };
    const runRead = { kind: "actions-rate-limit", thread: "t", id: "run-read-quota", operation: "actions-run-read",
      status: 403, failed: true, line: "failed to get run: HTTP 403: API rate limit exceeded" };
    const facts = [
      admission, admission,
      { ...admission, id: "superseded", annotation: "Canceling since a higher priority waiting request exists" },
      { ...admission, id: "assigned", assigned: true },
      { ...admission, id: "with-steps", steps: 1 },
      { ...admission, id: "success", conclusion: "success" },
      jobResult, jobResult,
      { ...jobResult, id: "run:4:job", conclusion: "timed_out" },
      { ...jobResult, id: "run:5:job", conclusion: "cancelled" },
      { ...jobResult, id: "run:6:job", conclusion: "success" },
      diagnostic, diagnostic,
      { ...diagnostic, line: "Dependency policy failed: Staged TypeScript fake/tsconfig.json: locked TypeScript dependencies are missing for staged checks" },
      { ...diagnostic, id: "copied-success", failed: false },
      { ...diagnostic, id: "reprinted-context", line: "Copied guidance: Staged checker could not load installed tools" },
      { ...diagnostic, id: "other-policy", line: "Dependency policy failed: Staged TypeScript fake/tsconfig.json: invalid option" },
      notice, notice,
      { ...notice, id: "notice-2", message: "#42: checks passed, merge conflict" },
      { ...notice, id: "other-pr", linkedPr: 43 },
      { ...notice, id: "unlinked", linkedPr: 0 },
      { ...notice, id: "inherited", visibility: "inherited" },
      { ...notice, id: "different-thread", sourceThread: "other" },
      { ...notice, id: "truncated", truncated: true },
      { ...notice, id: "pending", status: "pending" },
      { ...notice, id: "checks-only", message: "#42: checks passed" },
      { ...notice, id: "extra-text", message: "#42: merge conflict already resolved" },
      forge, forge,
      { ...forge, id: "unidentified-response", identified: false },
      { ...forge, id: "accepted", status: 201 },
      { ...forge, id: "rate-limited", status: 429 },
      { ...forge, id: "wrong-operation", operation: "github-pr-read" },
      { ...forge, id: "recovered-response", failed: false },
      rerun, rerun,
      { ...rerun, id: "wrong-job", job: "123456789013" },
      { ...rerun, id: "rerun-succeeded", failed: false },
      { ...rerun, id: "unrelated-failure", line: "failed to connect to GitHub" },
      localAdmission, localAdmission,
      { ...localAdmission, id: "quick-admission", waitMs: 59_999 },
      { ...localAdmission, id: "unallocated", allocated: 0 },
      { ...localAdmission, id: "too-many-workers", allocated: 11 },
      { ...localAdmission, id: "impossible-duration", boundMs: 1000 },
      apt, apt,
      { ...apt, id: "not-deb", archive: "/ubuntu/dists/InRelease" },
      { ...apt, id: "relative-path", archive: "ubuntu/pool/example/staged_1.deb" },
      { ...apt, id: "gateway-error", httpStatus: 503 },
      { ...apt, id: "other-exit", exitCode: 1 },
      { ...apt, id: "recovered-apt", conclusion: "success" },
      { ...apt, id: "unrelated-summary", summary: "E: Invalid signature" },
      width, width, { ...width, id: "width-copy", failed: false },
      admissionTimeout, admissionTimeout,
      { ...admissionTimeout, id: "wrong-exit", exitCode: 1 },
      { ...admissionTimeout, id: "build-timeout", line: "t3-build: command timed out" },
      artifactConflict, artifactConflict,
      { ...artifactConflict, id: "resolved-publish", conclusion: "success" },
      { ...artifactConflict, id: "unrelated-publish", line: "Error: Onboarding release is unavailable" },
      uploadError, uploadError,
      { ...uploadError, id: "other-server", line: "HTTP 500 (https://example.org/repos/example/capture/releases/123/assets)" },
      { ...uploadError, id: "status-mismatch", status: 503 },
      { ...uploadError, id: "other-api-route", line: "HTTP 500 (https://uploads.github.com/repos/example/capture/actions/123/assets)" },
      { ...uploadError, id: "upload-accepted", exitCode: 0 },
      markerTimeout, markerTimeout,
      { ...markerTimeout, id: "acknowledgement", line: "Error: Startup benchmark timed out at revision-specific frame acknowledgement" },
      { ...markerTimeout, id: "noncalibration", sameBuild: false },
      { ...markerTimeout, id: "different-marker", line: "Error: Startup benchmark timed out at something else" },
      pressureRejected, pressureRejected,
      { ...pressureRejected, id: "artifact-pressure", lane: "record-start", source: "calibration-artifact" },
      { ...pressureRejected, id: "unrelated-source", source: "narrative" },
      { ...pressureRejected, id: "zero-score", scorePresent: true },
      { ...pressureRejected, id: "qualified", qualified: true },
      { ...pressureRejected, id: "permitted-pressure", pressureRejected: false },
      superseded, superseded,
      { ...superseded, id: "wrong-boundary", phaseLine: "at release (file:///test/connect/tooling/hosting/scripts/deploy.ts:45:10)" },
      readback, readback,
      { ...readback, id: "pre-upload", accepted: false },
      { ...readback, id: "no-timeout", line: "TypeError: fetch failed" },
      { ...readback, id: "failed-probe-recovered", conclusion: "success" },
      smokeFailure,
      { ...smokeFailure, id: "same-execution", at: 205 },
      { ...smokeFailure, id: "other-lane", lane: "desktop-mac", execution: "run:2:mac", at: 210 },
      { ...smokeFailure, id: "other-case", test: "settings-smoke", execution: "run:2:job", at: 210 },
      { ...smokeFailure, id: "passing-step", execution: "run:2:job", conclusion: "success", at: 210 },
      { ...smokeFailure, id: "earlier-execution", execution: "run:0:job", at: 190 },
      { ...smokeFailure, id: "unknown-clock", execution: "run:3:job", at: 0 },
      { ...smokeFailure, id: "other-thread", thread: "t2", execution: "run:2:job", at: 210 },
      { ...smokeFailure, id: "other-pr", scope: "pr-6", execution: "run:2:job", at: 210 },
      { ...smokeFailure, id: "second-test", execution: "run:2:job", at: 210 },
      { ...smokeFailure, id: "third-test", execution: "next-run:1:job", at: 260 },
      packageBuild,
      { ...packageBuild, id: "overlapping-build", start: 229, end: 260 },
      { ...packageBuild, id: "different-step", scope: "run:1:job:other-step", start: 230, end: 260 },
      { ...packageBuild, id: "different-manifest", digest: "other", start: 230, end: 260 },
      { ...packageBuild, id: "different-kind", tool: "vite-server", start: 230, end: 260 },
      { ...packageBuild, id: "different-asset-count", assets: 36, start: 230, end: 260 },
      { ...packageBuild, id: "empty-manifest", assets: 0, start: 230, end: 260 },
      { ...packageBuild, id: "impossible-clock", start: 230, end: 258 },
      { ...packageBuild, id: "open-clock", start: 230, end: 0 },
      { ...packageBuild, start: 230, end: 260 },
      { ...packageBuild, id: "second-build", start: 230, end: 259 },
      modelFetch, modelFetch,
      { ...modelFetch, id: "different-stage", step: "Cargo test" },
      { ...modelFetch, id: "different-origin", origin: "download:example/build.ts" },
      { ...modelFetch, id: "mismatched-status", status: 503 },
      { ...modelFetch, id: "mismatched-model-revision", revision: "f".repeat(40) },
      { ...modelFetch, id: "not-server-error", status: 404, line: modelFetch.line.replace("(502)", "(404)") },
      { ...modelFetch, id: "recovered-download", conclusion: "success" },
      captureAccess, captureAccess,
      { ...captureAccess, id: "unavailable-files", operation: "apparent-connect-files" },
      { ...captureAccess, id: "unexpected-producer", operation: "apparent-connect-status" },
      { ...captureAccess, id: "different-reply", line: "Error: Capture unavailable (forbidden)." },
      { ...captureAccess, id: "after-success", failed: false },
      benchmarkAdmission, benchmarkAdmission,
      { ...benchmarkAdmission, id: "different-lane", lane: "record-start" },
      { ...benchmarkAdmission, id: "different-entry", origin: "render:connect/enablement/benchmark/hosted.ts" },
      { ...benchmarkAdmission, id: "different-exit", exitCode: 124 },
      { ...benchmarkAdmission, id: "qualified-with-warning", conclusion: "success" },
      watchWake, watchWake,
      { ...watchWake, id: "other-pr", number: 41 },
      { ...watchWake, id: "unrelated-wake", message: "#42: comment" },
      { ...watchWake, id: "intervening-turn", nextOrdinal: 3 },
      { ...watchWake, id: "different-instant", requestedStamp: "1970-01-01T00:03:00.007Z" },
      { ...watchWake, id: "after-park", registeredAt: 101 },
      { ...watchWake, id: "before-park", parkedAt: 181 },
      toolchainFetch, toolchainFetch,
      { ...toolchainFetch, id: "other-step", step: "Cargo test" },
      { ...toolchainFetch, id: "wrong-status", status: 502 },
      { ...toolchainFetch, id: "wrong-asset", asset: "main.ts" },
      { ...toolchainFetch, id: "recovered-toolchain", conclusion: "success" },
      socketPreflight, socketPreflight,
      { ...socketPreflight, id: "other-python", origin: "check_temp_environment:another.py" },
      { ...socketPreflight, id: "wrong-limit", limit: 112 },
      { ...socketPreflight, id: "within-limit", required: 106, line: socketPreflight.line.replace("112", "106") },
      fanout,
      { ...fanout, id: "same-lane-retry", at: 203 },
      { ...fanout, id: "another-revision", lane: "lane-two", revision: "e".repeat(40), at: 205 },
      { ...fanout, id: "another-assertion", lane: "lane-two", failure: "different-assertion", at: 206 },
      { ...fanout, id: "unrelated-pr", lane: "lane-two", scope: "pr-43", at: 207 },
      { ...fanout, id: "successful-lane", lane: "lane-two", conclusion: "success", at: 208 },
      { ...fanout, id: "fanout-second", lane: "lane-two", at: 210 },
      aptMirror, aptMirror,
      { ...aptMirror, id: "same-mirror", mirrorB: aptMirror.mirrorA },
      { ...aptMirror, id: "regular-apt", step: "Install Ubuntu packages" },
      { ...aptMirror, id: "fallback-worked", conclusion: "success" },
      pagesAuth, pagesAuth,
      { ...pagesAuth, id: "later-auth", accepted: true },
      { ...pagesAuth, id: "elsewhere-auth", phaseLine: readback.phaseLine },
      quota, quota,
      { ...quota, id: "watch-quota", operation: "actions-run-watch", line: "failed to get run: HTTP 403: API rate limit exceeded" },
      { ...quota, id: "forbidden", line: "gh: Resource not accessible (HTTP 403)" },
      { ...quota, id: "other-operation", operation: "github-pr-create" },
      { ...quota, id: "successful-read", failed: false },
      poll, poll,
      { ...poll, id: "other-turn", turn: "new-turn", at: 210 },
      { ...poll, id: "other-process", invocation: "different-unit", at: 210 },
      { ...poll, id: "past-poll", at: 190 },
      { ...poll, id: "poll-2", at: 211 },
      { ...poll, id: "terminal-state", state: "inactive", at: 220 },
      { ...poll, id: "later-terminal-state", state: "inactive", at: 230 },
      vmBoot, vmBoot, vmReady,
      { ...vmBoot, id: "scenario-failure", scenarioStarted: true },
      { ...vmBoot, id: "other-vm", command: "qemu" },
      { ...vmReady, id: "different-missing-command", required: "ffmpeg" },
      statusGate, statusGate,
      { ...statusGate, id: "carried-jobs", attemptStarted: 210 },
      { ...statusGate, id: "unknown-attempt", attemptStarted: 0 },
      { ...statusGate, id: "too-short", gateCompleted: 159 },
      { ...statusGate, id: "reversed-gate", previousCompleted: 221 },
      { ...statusGate, id: "already-started", dependentStarted: 219 },
      { ...statusGate, id: "same-job", prerequisite: "linux" },
      ownership, ownership, alreadyActive,
      { ...ownership, id: "incorrect-receipt", receiptRevision: "a".repeat(40) },
      { ...ownership, id: "before-activation", phase: "preflight" },
      { ...ownership, id: "unexpected-result", conclusion: "success" },
      { ...alreadyActive, id: "different-version", comparedVersion: "v-other" },
      { ...alreadyActive, id: "missing-version", previousVersion: null, comparedVersion: null },
      { ...alreadyActive, id: "other-assertion", origin: "after-activation:connect/tooling/hosting/scripts/deploy.ts" },
      pendingCapture, pendingCapture, unsafeOutput,
      { ...pendingCapture, id: "successful-fetch", failed: false },
      { ...pendingCapture, id: "inspect-is-not-transfer", operation: "apparent-inspect" },
      { ...unsafeOutput, id: "other-command", operation: "apparent-open" },
      { ...statusGate, id: "connect-portable-gate", workflow: "stream-connect" },
      timingFixture, timingFixture,
      { ...timingFixture, id: "without-setting", setting: "TMPDIR" },
      { ...timingFixture, id: "expected-timings", expected: "--offline --timings" },
      { ...timingFixture, id: "recovered-push", failed: false },
      reuseRefusal, reuseRefusal,
      { ...reuseRefusal, id: "quoted-in-tests", step: "Run bun test enablement/ci/" },
      { ...reuseRefusal, id: "pull-request-reuse", event: "pull_request" },
      cacheConflict, cacheConflict,
      { ...cacheConflict, id: "no-restore", restored: false },
      { ...cacheConflict, id: "other-copy-step", step: "Snapshot downloaded PyPI wheels only" },
      { ...cacheConflict, id: "permission-copy", code: "EACCES" },
      actorCancellation, actorCancellation,
      { ...actorCancellation, id: "assigned-cancelled", assigned: true },
      { ...actorCancellation, id: "empty-actor", annotation: "The run was canceled by @." },
      boundary, boundary,
      { ...boundary, id: "dirty-worktree", boundary: "worktree-fingerprint", line: dirty, terminal: dirty },
      { ...boundary, id: "locked-install", boundary: "desktop-dependencies", line: "Desktop dependency operation locked or unavailable" },
      { ...boundary, id: "native-media", boundary: "local-rust-test",
        line: "Packaged Record media/Engine unavailable; prepare native prerequisites or reinstall the complete app" },
      { ...boundary, id: "embedded-html", operation: "git-commit", boundary: "staged-comment-policy",
        line: "embedded HTML code requires a dedicated parser; unsupported changed file", terminal: "Pre-commit affected checks: 0ms" },
      { ...boundary, id: "unrelated-terminal", terminal: "command exited with code 1" },
      { ...boundary, id: "reported-only", failed: false },
      expiry, expiry,
      { ...expiry, id: "other-expiry", origin: "read_capture:connect/client/src/test_support/encrypted_tests.rs" },
      aptDeadline, aptDeadline, aptDeadlineDisk,
      { ...aptDeadlineDisk, id: "new-attempt-carried-job", attemptStarted: 1500 },
      { ...aptDeadline, id: "no-annotated-deadline", deadlineSeconds: 0 },
      { ...aptDeadlineDisk, id: "after-job-end", ended: 1614 },
      { ...aptDeadline, id: "other-setup", step: "Install OCR preprocessing dependency" },
      issueTrailer, issueTrailer,
      { ...issueTrailer, id: "trailer-only-in-note", operation: "git-commit" },
      prObserver, prObserver,
      { ...prObserver, id: "observer-other-revision", afterRevision: "b".repeat(40) },
      { ...prObserver, id: "observer-other-pr", beforePr: 50 },
      { ...prObserver, id: "observer-other-repo", afterRepository: "example/other" },
      { ...prObserver, id: "observer-timeout", exitCode: 124 },
      { ...prObserver, id: "observer-quick-check", elapsedMs: 59_999 },
      selectorBase, selectorBase,
      { ...selectorBase, id: "matching-base", base: selectorBase.firstParent },
      { ...selectorBase, id: "different-head", selectorHead: "e".repeat(40) },
      { ...selectorBase, id: "different-pr", secondParent: "e".repeat(40) },
      { ...selectorBase, id: "unrelated-base", ancestor: false },
      { ...selectorBase, id: "empty-range", intervening: 0 },
      { ...selectorBase, id: "different-event", event: "push" },
      { ...selectorBase, id: "failed-selection", conclusion: "failure" },
      { ...selectorBase, id: "different-selector", command: "bun fake/select.ts" },
      execLaunch, execLaunch,
      { ...execLaunch, id: "another-thread", sourceThread: "u" },
      { ...execLaunch, id: "inherited-launch", visibility: "inherited" },
      { ...execLaunch, id: "successful-launch", status: "completed" },
      { ...execLaunch, id: "bad-launch-sample", truncated: true },
      { ...execLaunch, id: "different-error", line: "script.sh: No such file or directory" },
      { ...execLaunch, id: "agent-prose", itemType: "assistant_message" },
      runWatch, runWatch,
      { ...runWatch, id: "wrong-observer-handle", terminalHandle: 43 },
      { ...runWatch, id: "failed-hosted-run", exitCode: 1 },
      { ...runWatch, id: "user-stopped-watcher", exitCode: 143 },
      { ...runWatch, id: "too-early-to-be-deadline", elapsedMs: 1_799_999 },
      { ...runWatch, id: "late-receipt", elapsedMs: 1_816_000 },
      statusRead, statusRead,
      { ...statusRead, id: "manual-second", at: 160 },
      { ...statusRead, id: "provider-owned-read", mode: "provider-observer", at: 170 },
      { ...statusRead, id: "other-attempt", attempt: 2, at: 180 },
      { ...statusRead, id: "other-run", run: "12345678902", at: 190 },
      { ...statusRead, id: "manual-third", at: 200 },
      { ...statusRead, id: "manual-changed", snapshot: "b".repeat(40), at: 220 },
      { ...statusRead, id: "manual-returned", at: 260 },
      { ...statusRead, id: "manual-terminal", pending: false, at: 300 },
      { ...statusRead, id: "manual-new-pending", at: 310 },
      { ...statusRead, id: "manual-late", at: 620 },
      { ...statusRead, id: "manual-follow-up", at: 680 },
      { ...statusRead, id: "manual-old-receipt", at: 660 },
      { ...statusRead, id: "manual-same-second", at: 680 },
      { ...statusRead, id: "manual-third-after-gap", at: 730 },
      sourceBudget, sourceBudget,
      { ...sourceBudget, id: "at-allowance", actual: 4000 },
      { ...sourceBudget, id: "different-test-unit", unit: "file-lines" },
      { ...sourceBudget, id: "copied-budget-warning", failed: false },
      { ...sourceBudget, id: "different-budget-phase", phase: "width" },
      bunTimeout, bunTimeout,
      { ...bunTimeout, id: "assertion", diagnostic: "assertion" },
      { ...bunTimeout, id: "early-exit", elapsedMs: 4999 },
      { ...bunTimeout, id: "hosted-cancelled", conclusion: "cancelled" },
      { ...bunTimeout, id: "wrong-test-tool", step: "Run npm test tests/" },
      prRefs, prRefs,
      { ...prRefs, id: "mismatched-branch", head: "other" },
      { ...prRefs, id: "simple-empty-pr", line: "No commits between main and t3/example" },
      { ...prRefs, id: "recovered-pr-command", failed: false },
      workflowScope, workflowScope,
      { ...workflowScope, id: "wrong-transport", operation: "git-push-ssh" },
      { ...workflowScope, id: "non-workflow", workflow: "docs/release.yaml" },
      missingWorktree, missingWorktree,
      { ...missingWorktree, id: "missing-unrelated-file", path: "b".repeat(40) },
      { ...missingWorktree, id: "missing-script", operation: "exec-script" },
      providerAudio, providerAudio,
      { ...providerAudio, id: "copied-provider-message", itemType: "assistant_message" },
      { ...providerAudio, id: "unresolved-provider-response", truncated: true },
      { ...providerAudio, id: "other-thread-response", sourceThread: "other" },
      { ...providerAudio, id: "other-model-input", message: "Image input is not supported for this request." },
      reporterWrite, reporterWrite,
      { ...reporterWrite, id: "reporter-read-status", method: "GET" },
      { ...reporterWrite, id: "reporter-scope", reason: "missing-scope" },
      { ...reporterWrite, id: "reporter-recovered", conclusion: "success" },
      nativeProbe, nativeProbe,
      { ...nativeProbe, id: "mac-assertion", command: "click-storage-control" },
      { ...nativeProbe, id: "mac-unknown-fixture", fixture: "tests/mac-alternate.cjs" },
      runRead, runRead,
      { ...runRead, id: "run-read-other-error", line: "failed to get run: HTTP 403: Permission denied" },
      read, read, { ...read, id: "b", at: 160 }, { ...read, thread: "t2", at: 170 },
      timing, timing, { ...timing, id: "unpaired", end: 0 },
      attempt, { ...attempt, id: "changed", key: "gate:v2", start: 115, end: 120, failed: false, succeeded: true },
      { ...attempt, id: "recovered", start: 125, end: 130, failed: false, succeeded: true },
      { ...attempt, id: "repeated-success", start: 131, end: 140, failed: false, succeeded: true },
      ...normal.slice(0, 7),
      { ...normal[0], id: "duplicate-sha", start: 370, end: 380 },
      { ...peer, id: "overlap", revision: "sha-overlap", start: 380, end: 550 },
      { ...peer, id: "thin", revision: "sha-0", start: 400, end: 540 },
      normal[7],
      { ...peer, id: "tail", revision: "sha-tail", start: 600, end: 850 },
    ];
    const first = replay(facts);
    assert.equal(replay(facts), first);
    const result = JSON.parse(first);
    assert.deepEqual(result.files, [{ $: "FileTotal", path: "README.md", requests: 3, threads: 2, revisits: 1 }]);
    assert.deepEqual(result.costs.sort((a: { clock: string; operation: string }, b: { clock: string; operation: string }) =>
      a.clock.localeCompare(b.clock) || a.operation.localeCompare(b.operation)), [
      { $: "Cost", clock: "ci-apt-dependency-step", operation: "ffmpeg", count: 1, seconds: 1443, unknown: 0 },
      { $: "Cost", clock: "ci-apt-dependency-step", operation: "qemu-utils", count: 1, seconds: 25, unknown: 0 },
      { $: "Cost", clock: "ci-apt-mirror-probe", operation: "ubuntu", count: 1, seconds: 11, unknown: 0 },
      { $: "Cost", clock: "ci-benchmark-owner-step", operation: "connect-watch", count: 1, seconds: 91, unknown: 0 },
      { $: "Cost", clock: "ci-benchmark-owner-step", operation: "record-start", count: 3, seconds: 1640, unknown: 0 },
      { $: "Cost", clock: "ci-benchmark-owner-step", operation: "record-stop", count: 1, seconds: 1300, unknown: 0 },
      { $: "Cost", clock: "ci-connect-delivery-owner-step", operation: "active-unverified", count: 1, seconds: 8, unknown: 0 },
      { $: "Cost", clock: "ci-connect-delivery-owner-step", operation: "preflight", count: 1, seconds: 10, unknown: 0 },
      { $: "Cost", clock: "ci-native-prerequisite-step", operation: "bend-toolchain", count: 1, seconds: 13, unknown: 0 },
      { $: "Cost", clock: "ci-native-prerequisite-step", operation: "circle-vision", count: 1, seconds: 113, unknown: 0 },
      { $: "Cost", clock: "ci-workflow-status-gate", operation: "linux needs portable", count: 1, seconds: 120, unknown: 0 },
      { $: "Cost", clock: "ci-workflow-status-gate", operation: "stream-connect / linux needs portable", count: 1, seconds: 120, unknown: 0 },
      { $: "Cost", clock: "local-build-admission", operation: "t3-build", count: 2, seconds: 123, unknown: 0 },
      { $: "Cost", clock: "runner", operation: "build", count: 1, seconds: 129, unknown: 1 },
      { $: "Cost", clock: "t3-pr-watch-parked", operation: "checks-passed", count: 1, seconds: 80, unknown: 0 },
    ]);
    assert.deepEqual(result.findings.map(({ rule }: { rule: string }) => rule),
      ["ci-hosted-admission-failure", "ci-job-failure", "ci-job-timeout", "staged-verification-prerequisite",
        "pr-merge-conflict-observed", "pr-merge-conflict-observed", "pr-create-http-server-error",
        "ci-job-rerun-rejected", "local-build-admission-slow", "ci-apt-package-not-found", "staged-directory-width",
        "local-build-admission-timeout", "ci-onboarding-release-artifact-conflict", "ci-release-upload-server-error",
        "ci-benchmark-calibration-marker-timeout", "ci-benchmark-calibration-marker-timeout",
        "ci-benchmark-calibration-pressure-rejected", "ci-benchmark-calibration-pressure-rejected",
        "ci-deployment-candidate-superseded", "ci-deployment-readback-timeout",
        "ci-test-failure-repeated", "ci-test-failure-repeated", "ci-package-build-repeated",
        "ci-model-prerequisite-http-server-error", "capture-reference-unavailable", "capture-reference-unavailable",
        "ci-benchmark-no-qualified-smt-subset",
        "t3-pr-watch-parked", "ci-toolchain-prerequisite-http-server-error",
        "local-verification-socket-path-limit", "ci-test-failure-cross-lane",
        "ci-apt-mirror-probe-exhausted", "ci-pages-preflight-unauthorized", "ci-observer-rate-limited",
        "ci-observer-rate-limited", "local-verification-state-repolled", "local-vm-ssh-boot-timeout",
        "local-vm-missing-guest-command",
        "ci-workflow-status-gate", "ci-connect-activation-ownership-conflict", "ci-connect-candidate-already-active",
        "capture-upload-pending", "capture-directory-unsafe",
        "ci-workflow-status-gate", "local-push-timing-flag-fixture-mismatch",
        "ci-reuse-verification-definitions-changed", "ci-hermes-validator-cache-copy-conflict",
        "ci-hosted-explicit-cancellation-unassigned", "local-push-selection-guard-refused",
        "local-push-worktree-changed-during-verification", "local-desktop-dependency-lock-unavailable",
        "local-native-media-prerequisite-unavailable", "staged-embedded-html-unsupported",
        "ci-connect-synthetic-approval-expired", "ci-apt-install-before-job-deadline", "ci-apt-step-cancelled-at-job-deadline",
        "local-push-issue-trailer-refused", "ci-pr-check-observer-exact-head", "ci-selector-compared-older-base",
        "local-exec-launch-enoent", "ci-local-run-observer-deadline", "ci-manual-status-read-repeated",
        "ci-manual-status-read-repeated", "staged-source-token-budget", "ci-bun-test-deadline",
        "pr-create-graphql-ref-resolution", "git-push-github-workflow-scope-refused", "local-t3-worktree-path-missing",
        "provider-audio-input-unsupported", "ci-status-reporter-rate-limited", "ci-macos-system-events-probe-failed",
        "ci-observer-rate-limited",
        "recovered-attempt", "runner"]);
    assert.ok(!first.includes("installed tools"));
    assert.ok(!first.includes("#42:"));
    assert.deepEqual(result.findings.map(({ id, previous, seconds, median }: Record<string, unknown>) =>
      [id, previous, seconds, median]), [
      ["run:7:job", "", 0, 0], ["run:2:job", "", 0, 0], ["run:4:job", "", 0, 0], ["checker", "", 0, 0],
      ["notice-1", "", 0, 0], ["notice-2", "", 0, 0], ["request", "", 0, 0], ["rerun", "", 0, 0],
      ["local-admission", "", 64, 0], ["apt-step", "", 0, 0], ["width", "", 0, 0],
      ["admission-timeout", "", 0, 0], ["artifact-conflict", "", 0, 0], ["upload-error", "", 0, 0],
      ["marker", "", 0, 0], ["acknowledgement", "", 0, 0], ["pressure", "", 0, 0], ["artifact-pressure", "", 0, 0],
      ["superseded-deploy", "", 0, 0], ["readback-timeout", "", 0, 0],
      ["second-test", "first-test", 0, 0], ["third-test", "second-test", 0, 0], ["second-build", "first-build", 30, 0],
      ["model-download", "", 0, 0], ["unavailable-capture", "", 0, 0], ["unavailable-files", "", 0, 0],
      ["smt-subset", "", 0, 0],
      ["wake", "watch-start", 80, 0], ["bend-source", "", 0, 0], ["socket-limit", "", 0, 0],
      ["fanout-second", "fanout-first", 0, 0],
      ["mirror-probe", "", 0, 0], ["pages-auth", "", 0, 0], ["job-read-quota", "", 0, 0],
      ["watch-quota", "", 0, 0], ["poll-2", "poll-1", 0, 0], ["vm-boot", "", 150, 0],
      ["vm-ready", "", 0, 0],
      ["portable-gate", "", 120, 0], ["activation", "", 8, 0], ["already-active", "", 10, 0],
      ["upload-pending", "", 0, 0], ["shared-dir", "", 0, 0],
      ["connect-portable-gate", "", 120, 0], ["fixture-timing", "", 68, 0],
      ["reuse-refusal", "", 0, 0], ["cache-copy", "", 0, 0],
      ["actor-cancelled", "", 0, 0], ["selector-refused", "", 0, 0], ["dirty-worktree", "", 0, 0],
      ["locked-install", "", 0, 0], ["native-media", "", 0, 0], ["embedded-html", "", 0, 0],
      ["fixture-expiry", "", 0, 0], ["apt-media", "", 1443, 0], ["apt-disk", "", 25, 0],
      ["issue-trailer", "", 0, 0], ["pr-head-observer", "", 1423, 0], ["old-base", "", 0, 0],
      ["exec-launch", "", 0, 0], ["run-watch-expired", "", 1802, 0],
      ["manual-third", "manual-second", 0, 0], ["manual-third-after-gap", "manual-follow-up", 0, 0],
      ["budget-refusal", "", 0, 0], ["fixture-deadline", "", 5, 0],
      ["pr-unresolved-refs", "", 0, 0], ["push-scope", "", 0, 0], ["missing-checkout", "", 0, 0],
      ["rejected-audio", "", 0, 0], ["reconcile-quota", "", 0, 0], ["system-events-probe", "", 0, 0],
      ["run-read-quota", "", 0, 0],
      ["recovered", "first", 20, 0], ["tail", "", 250, 10],
    ]);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
