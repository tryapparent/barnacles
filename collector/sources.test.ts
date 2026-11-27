import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
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
    const write = (records: object[]) =>
      writeFileSync(input, records.map((record, ordinal) => JSON.stringify({ ordinal, ...record })).join("\n") + "\n");
    const cli = (command: string, ...args: string[]) => spawnSync(process.execPath,
      [fileURLToPath(new URL("./import-sources.ts", import.meta.url)), job, command, ...args], { encoding: "utf8" });
    write(fork);
    for (let replay = 0; replay < 2; replay++) {
      const result = cli("rollout", "synthetic", input, "fork-file");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "admitted_fork_suffix");
    }
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
      ["fork-file", "admitted_fork_suffix", 3, true],
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
    const facts = [
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
    assert.deepEqual(result.costs, [{ $: "Cost", clock: "runner", operation: "build", count: 1, seconds: 129, unknown: 1 }]);
    assert.deepEqual(result.findings.map(({ id, previous, seconds, median }: Record<string, unknown>) =>
      [id, previous, seconds, median]), [["recovered", "first", 20, 0], ["tail", "", 250, 10]]);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
