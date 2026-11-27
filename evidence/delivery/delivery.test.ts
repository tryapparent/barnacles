import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { buildPolicies, loadPolicy } from "../../tooling/bend.ts";
import { openHistory, type ActionAttempt, type HistoryFact } from "../storage/actions.ts";
import { admissionPolicy, buildAdmissionPolicy, loadEvidence, type AdmissionPolicy, type EvidenceBatch } from "../storage/load.ts";
import type { RolloutEvidence, ThreadEvidence } from "../storage/sources.ts";
import { deliveryPolicy, deliveryReport, type DeliveryPolicy, type PullRequest, type ReleaseEvidence } from "./delivery.ts";

test("the report keeps each release proof bound to its own observation across replay and replacement", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "release-proof-"));
  const path = join(job, "evidence.sqlite");
  const sha = "a".repeat(40);
  const base = 1760000000;
  const pr: PullRequest = { repository: "synthetic/example", number: 1, state: "merged", opened: base, merged: base + 10,
    mergeSha: sha, firstCommit: null, firstReview: null, commitsComplete: true, reviewsComplete: true, updated: base + 10 };
  const proof: ReleaseEvidence = { id: 1, tag: "synthetic", source: sha, channel: "linux-main-x86_64",
    tagMatches: true, published: base + 30, assetId: 1, checked: base + 40, http: 206, bytes: 1,
    accessible: true, ancestry: "equal", shipped: true, dispatch: { id: 5, at: base + 20 } };
  try {
    const [admissionFile, reportFile] = await buildPolicies(job, [
      [admissionPolicy, "admission.mjs"], [deliveryPolicy, "delivery.mjs"],
    ]);
    const admission = await loadPolicy<AdmissionPolicy>(admissionFile);
    const report = await loadPolicy<DeliveryPolicy>(reportFile);
    const saveDelivery = (pullRequest: PullRequest, release?: ReleaseEvidence) =>
      loadEvidence(path, { source: "github-delivery", pullRequest, release }, admission);
    saveDelivery(pr);
    const legacyPR = { ...pr, number: 2 };
    const unsafeLegacy = { ...pr, number: 3 };
    const grouped = { ...pr, number: 4 };
    const mismatchedAsset = { ...pr, number: 5 };
    saveDelivery(legacyPR);
    saveDelivery(unsafeLegacy);
    saveDelivery(mismatchedAsset);
    const fixture = new DatabaseSync(path);
    try {
      fixture.exec(`
        CREATE TABLE github_releases(repository, release_id, channel, source_sha, published_at, asset_id);
        CREATE TABLE github_asset_checks(repository, release_id, channel, checked_at, asset_id);
        CREATE TABLE github_release_proofs(repository, pr_number, release_id, channel, checked_at, ancestry, shipped, merge_sha);
      `);
      for (const legacy of [legacyPR, unsafeLegacy, mismatchedAsset]) {
        const key = [legacy.repository, legacy.number, proof.channel] as const;
        fixture.prepare("INSERT INTO github_releases VALUES (?, ?, ?, ?, ?, ?)").run(...key, sha, proof.published, proof.assetId);
        fixture.prepare("INSERT INTO github_asset_checks VALUES (?, ?, ?, ?, ?)").run(
          ...key, proof.checked, legacy === mismatchedAsset ? 2 : proof.assetId);
        fixture.prepare("INSERT INTO github_release_proofs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          legacy.repository, legacy.number, legacy.number, proof.channel, proof.checked, proof.ancestry, 1, sha);
      }
      fixture.prepare("INSERT INTO github_asset_checks VALUES (?, ?, ?, ?, ?)").run(
        unsafeLegacy.repository, unsafeLegacy.number, proof.channel, proof.checked + 1, 2);
    } finally {
      fixture.close();
    }

    saveDelivery(pr, proof);
    saveDelivery(pr, proof);
    const replacement = { ...proof, source: "b".repeat(40), published: base + 80, assetId: 2, checked: base + 100,
      http: 404, bytes: null, accessible: false, shipped: false, dispatch: null };
    saveDelivery(pr, replacement);
    saveDelivery(pr, replacement);
    saveDelivery(grouped, { ...proof, id: 1, channel: "first-channel", shipped: false });
    saveDelivery(grouped, { ...proof, id: 2, channel: "second-channel" });
    saveDelivery(grouped, { ...proof, id: 3, channel: "first-channel", dispatch: null });
    saveDelivery(grouped, { ...proof, id: 3, channel: "first-channel", dispatch: { id: 6, at: base + 21 } });
    saveDelivery(grouped, { ...proof, id: 3, channel: "first-channel" });
    const [historical, legacy, conflicting, firstChannel, secondChannel, assetMismatch] = deliveryReport(path, report);
    assert.deepEqual([historical.asset_id, historical.published_at, historical.checked_at, historical.release_run],
      [proof.assetId, proof.published, proof.checked, proof.dispatch?.id]);
    assert.equal(historical.pr_to_release_seconds, 30);
    assert.equal(legacy.pr_to_release_seconds, 30);
    assert.equal(legacy.release_run, null);
    assert.equal(conflicting.pr_to_release_seconds, null);
    assert.deepEqual([firstChannel.channel, firstChannel.release_run, secondChannel.channel],
      ["first-channel", proof.dispatch?.id, "second-channel"]);
    assert.equal(assetMismatch.channel, null);
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM github_release_observations WHERE pr_number=1").get()?.n, 2);
      db.exec("DROP TABLE github_release_observations; DROP TABLE github_pr_ci");
    } finally {
      db.close();
    }
    assert.deepEqual(deliveryReport(path, report).map((row) => row.release_id), [null, legacyPR.number, null, null, null]);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("equal revisions replay and rejected revisions leave their stored evidence intact", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "write-admission-"));
  const path = join(job, "evidence.sqlite");
  const repository = "synthetic/example";
  const opened = 1760000000;
  const clock = opened * 1000 + 123;
  const pr: PullRequest = { repository, number: 1, state: "open", opened, merged: null,
    mergeSha: null, firstCommit: null, firstReview: null, commitsComplete: false, reviewsComplete: false, updated: opened };
  const thread: ThreadEvidence = { id: "thread", instance: "synthetic", status: "running", origin: "manual_t3",
    created: clock - 1000, updated: clock, settled: false,
    runs: [{ id: "run", requested: clock, started: null, completed: null, status: "queued" }],
    pullRequests: [{ repository, number: 1, source: "created", state: "open", owning: true }] };
  const rollout: RolloutEvidence = { instance: "synthetic", session: "rollout", lines: 4, malformed: 0, orphans: 0,
    markers: [{ line: 4, at: clock + 3, resultCall: "call" }],
    calls: [{ id: "call", line: 2, tool: "Shell command", command: "git status", categories: "Git inspection",
      start: clock, end: clock + 1, async: false, asyncEnd: null, terminalCall: null, ambiguous: false }] };
  const attempt: ActionAttempt = { repository, runId: 1, attempt: 1, sha: "a".repeat(40), workflowId: 1,
    status: "completed", conclusion: "success", createdAt: opened, startedAt: opened,
    sourceUpdated: opened + 10, observedAt: opened + 20, jobs: [
      { id: 1, label: "Checks", status: "completed", conclusion: "success", created: opened,
        priorExecution: false, queueEnd: opened, executionStart: opened, executionEnd: opened + 10, steps: [] },
    ] };
  try {
    const admission = await buildAdmissionPolicy(job);
    const save = (batch: EvidenceBatch) => loadEvidence(path, batch, admission);
    const batches: EvidenceBatch[] = [
      { source: "github-delivery", pullRequest: pr }, { source: "t3", thread },
      { source: "codex", rollout }, { source: "github-actions", attempt },
    ];
    for (const batch of batches) {
      save(batch);
      save(batch);
    }
    assert.throws(() => save({ source: "github-delivery", pullRequest: { ...pr, updated: opened - 1, state: "closed" } }),
      /Older pull request snapshot/);
    assert.throws(() => save({ source: "t3", thread: { ...thread, updated: clock - 1, pullRequests: [] } }),
      /Older T3 snapshot/);
    assert.throws(() => save({ source: "codex", rollout: { ...rollout, lines: rollout.lines - 1, calls: [], markers: [] } }),
      /Shorter rollout snapshot/);
    const conflicts: Partial<ActionAttempt>[] = [
      { sha: "b".repeat(40) }, { status: "in_progress" }, { sourceUpdated: attempt.sourceUpdated - 1 },
      { observedAt: attempt.observedAt - 1 },
    ];
    for (const conflict of conflicts) {
      assert.throws(() => save({ source: "github-actions", attempt: { ...attempt, ...conflict, jobs: [] } }),
        /Conflicting or older observation/);
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT state FROM github_prs").get()?.state, "open");
      for (const table of ["action_attempts", "action_jobs", "t3_pr_links", "t3_runs", "codex_calls", "codex_reasoning_inputs"]) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 1);
      }
      save({ source: "t3", thread: { ...thread, runs: [], pullRequests: [] } });
      assert.equal(db.prepare("SELECT count(*) AS n FROM t3_pr_links").get()?.n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM t3_runs").get()?.n, 1);
      save({ source: "codex", rollout: { ...rollout, calls: [], markers: [] } });
      for (const table of ["codex_calls", "codex_commands", "codex_categories", "codex_reasoning", "codex_reasoning_inputs"]) {
        assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0);
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("historical page evidence and its cursor commit together", () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "history-commit-"));
  const path = join(job, "evidence.sqlite");
  const target = "thread";
  const repository = "synthetic/example";
  const first = openHistory(path, "t3-activity", repository, [target]);
  const second = openHistory(path, "t3-activity", repository, [target]);
  const fact = (id: string, position: number): HistoryFact => ({
    $: "Fact", id, position, kind: "dynamic_tool", status: "waiting", seconds: 1760000000, millis: 123,
  });
  const evidence = (...facts: HistoryFact[]) => ({ environment: "fixture", thread: target, facts });
  try {
    const starting = first.read(target);
    const page = { ...starting.progress, position: 1, total: 3, revision: "1", status: "partial" };
    assert.equal(first.commit(target, starting.generation, page, evidence(fact("one", 1))), true);
    assert.equal(second.commit(target, starting.generation, page, evidence(fact("stale", 1))), false);
    const saved = second.read(target);
    const complete = { ...page, position: 3, status: "complete" };
    assert.throws(() => second.commit(target, saved.generation, complete, evidence(fact("two", 2), fact("one", 3))),
      /UNIQUE constraint failed/);
    assert.deepEqual(first.read(target), saved);
    assert.equal(first.commit(target, saved.generation, complete, evidence(fact("two", 2), fact("three", 3))), true);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("SELECT position, item, status, updated_at_ms FROM history_t3_activity ORDER BY position").all();
      assert.deepEqual(rows.map(Object.values), ["one", "two", "three"].map((id, position) =>
        [position, id, "waiting", 1760000000123]));
    } finally {
      db.close();
    }
  } finally {
    second.close();
    first.close();
    rmSync(job, { recursive: true, force: true });
  }
});
