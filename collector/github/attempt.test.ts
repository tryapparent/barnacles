import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEvidence } from "../../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { collectAttempt, collectWindow, type ClockPolicy } from "./attempt.ts";

test("Bend2 clocks reach SQLite through the exact-attempt importer", async () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const directory = mkdtempSync(join(parent, "test-"));
  try {
    const policy = await loadPolicy<ClockPolicy>(await buildPolicy(directory, new URL("./clocks.bend", import.meta.url), "clocks.mjs"));
    const arm = policy.job_label("linux / Linux aarch64");
    assert.equal(arm, "linux / Linux aarch64");
    assert.equal(policy.step_label(arm, "Package"), "Package");
    assert.equal(policy.step_label("Other jobs", "Package"), "Other steps");
    const identity = { repository: "synthetic/example", runId: 1, attempt: 2, sha: "a".repeat(40) };
    const time = (second: number) => `2026-01-01T12:00:${String(second).padStart(2, "0")}Z`;
    const run = { id: 1, run_attempt: 2, head_sha: identity.sha, workflow_id: 5,
      status: "completed", conclusion: "success", updated_at: time(56), run_started_at: time(3) };
    const allocated = {
      id: 10, run_id: 1, run_attempt: 2, head_sha: identity.sha, runner_id: 8,
      name: "macos / platform (macos-15-intel)", status: "completed", conclusion: "success",
      created_at: time(1), started_at: time(3), completed_at: time(40),
      steps: [
        { number: 1, name: "Build and package the exact Mac candidate for native checks", status: "completed",
          conclusion: "success", started_at: time(4), completed_at: time(34) },
        { number: 2, name: "Run example --private-input synthetic", status: "completed",
          conclusion: "success", started_at: time(50), completed_at: time(51) },
      ],
    };
    const jobs = [
      allocated,
      { ...allocated, id: 11, created_at: time(10) },
      { ...allocated, id: 12, runner_id: 0, conclusion: "cancelled", steps: [], started_at: time(1) },
      { ...allocated, id: 13, runner_id: 0, status: "queued", conclusion: null, steps: [],
        started_at: time(1), completed_at: null },
      { ...allocated, id: 14, conclusion: "skipped", steps: [] },
    ];
    const read = (path: string) => path.includes("/jobs?") ? { total_count: jobs.length, jobs } : run;
    const observed = collectAttempt(identity, policy, read);
    const path = join(directory, "evidence.sqlite");
    loadEvidence(path, { source: "github-actions", attempt: observed });
    loadEvidence(path, { source: "github-actions", attempt: observed });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const results = db.prepare("SELECT queue_end-created_at AS queue, execution_end-execution_start AS execution, prior_execution FROM action_jobs ORDER BY job_id").all();
      assert.deepEqual(results.map((row) => Object.values(row)), [
        [2, 37, 0], [null, null, 1], [39, null, 0], [null, null, 0], [null, null, 0],
      ]);
      const steps = db.prepare("SELECT label, completed_at-started_at AS seconds FROM action_steps ORDER BY job_id, step_number").all();
      assert.deepEqual(steps.map((row) => Object.values(row)), [
        ["Build and package the exact Mac candidate for native checks", 30], ["Other steps", null],
        ["Build and package the exact Mac candidate for native checks", null], ["Other steps", null],
      ]);
      assert.throws(() => loadEvidence(path, { source: "github-actions", attempt: { ...observed, sourceUpdated: 0, jobs: [] } }), /older observation/);
      assert.throws(() => loadEvidence(path, { source: "github-actions-window", attempts: [
        { ...observed, runId: 2 }, { ...observed, sourceUpdated: 0 },
      ] }), /older observation/);
      assert.equal(db.prepare("SELECT count(*) AS count FROM action_attempts").get()?.count, 1);
      assert.equal(db.prepare("SELECT count(*) AS count FROM action_jobs").get()?.count, 5);
    } finally {
      db.close();
    }
    const occupancy = JSON.parse(execFileSync(process.execPath,
      ["evidence/report-actions.ts", path, identity.repository], { encoding: "utf8" }));
    const queue = occupancy.find((row: { clock: string }) => row.clock === "CI queue");
    assert.deepEqual([queue.count, queue.mean_seconds, queue.total_seconds, queue.unmeasured_count], [2, 20.5, 41, 3]);
    assert.throws(() => collectAttempt(identity, policy, (path) =>
      path.includes("/jobs?") ? { total_count: 1, jobs: [] } : run), /Partial or changing GitHub job inventory/);
    assert.throws(() => collectAttempt({ ...identity, sha: "b".repeat(40) }, policy, read), /identity/);
    assert.throws(() => collectAttempt(identity, policy, (path) => path.includes("/jobs?")
      ? { total_count: 1, jobs: [{ ...allocated, run_attempt: 1 }] } : run), /job identity/);
    const withoutJobAttempt = collectAttempt(identity, policy, (path) => path.includes("/jobs?")
      ? { total_count: 1, jobs: [{ ...allocated, run_attempt: undefined }] } : run);
    assert.equal(withoutJobAttempt.jobs.length, 1);
    const jobless = collectAttempt(identity, policy, (path) =>
      path.includes("/jobs?") ? { total_count: 0, jobs: [] } : { ...run, status: "queued" });
    assert.deepEqual(jobless.jobs, []);
    assert.equal(jobless.startedAt, null);
    assert.equal(observed.startedAt, null);
    const missingCreation = collectAttempt(identity, policy, (path) => path.includes("/jobs?")
      ? { total_count: 1, jobs: [{ ...allocated, created_at: null }] } : run);
    assert.equal(missingCreation.jobs[0].executionEnd, null);
    let snapshots = 0;
    assert.throws(() => collectAttempt(identity, policy, (path) => path.includes("/jobs?")
      ? { total_count: 1, jobs: [{ ...allocated, id: ++snapshots }] } : run), /Changing GitHub attempt or job inventory/);
    let metadataReads = 0;
    assert.throws(() => collectAttempt(identity, policy, (path) => path.includes("/jobs?")
      ? { total_count: 1, jobs: [allocated] } : { ...run, updated_at: time(55 + metadataReads++) }),
    /Changing GitHub attempt or job inventory/);
    const pagedJobs = Array.from({ length: 100 }, (_, index) => ({ ...allocated, id: index + 100 }));
    assert.throws(() => collectAttempt(identity, policy, (path) => path.includes("/jobs?")
      ? path.endsWith("page=1") ? { total_count: 101, jobs: pagedJobs } : { total_count: 100, jobs: [] }
      : run), /Partial or changing GitHub job inventory/);

    const listedRuns = Array.from({ length: 101 }, (_, index) => ({ ...run, id: index + 1, created_at: time(1) }));
    const pageReads: string[] = [];
    const inventoryRead = (path: string) => {
      if (path.includes("/actions/runs?")) {
        pageReads.push(path);
        return { total_count: 101, workflow_runs: path.endsWith("page=1") ? listedRuns.slice(0, 100) : listedRuns.slice(100) };
      }
      return read(path);
    };
    const capped = collectWindow(identity.repository, time(1), time(56), 1, 1, policy, inventoryRead);
    assert.deepEqual([capped.coverage.reportedTotal, capped.coverage.eligible, capped.coverage.captured,
      capped.coverage.inventoryComplete, pageReads.length], [101, 100, 1, false, 1]);
    const full = collectWindow(identity.repository, time(1), time(56), 2, 1, policy, inventoryRead);
    assert.deepEqual([full.coverage.eligible, full.coverage.captured, full.coverage.inventoryComplete, pageReads.length],
      [101, 1, true, 3]);
    assert.throws(() => collectWindow(identity.repository, time(1), time(56), 2, 1, policy, (path) =>
      path.endsWith("page=2") ? { total_count: 101, workflow_runs: [listedRuns[0]] } : inventoryRead(path)),
    /Duplicate GitHub workflow run ID/);
    assert.throws(() => collectWindow(identity.repository, time(1), time(56), 2, 1, policy, (path) =>
      path.endsWith("page=2") ? { total_count: 101, workflow_runs: [] } : inventoryRead(path)),
    /Partial or changing GitHub run inventory/);
    assert.throws(() => collectWindow(identity.repository, time(1), time(56), 11, 1, policy, inventoryRead), /1–10 pages/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded Actions imports report coverage, replay atomically, and preserve jobless attempts", () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const directory = mkdtempSync(join(parent, "test-"));
  const from = "2026-01-01T12:00:00Z";
  const to = "2026-01-01T12:01:00Z";
  const database = join(directory, "evidence.sqlite");
  const sha = "a".repeat(40);
  const runs = [1, 2].map((id) => ({
    id, run_attempt: 1, head_sha: sha, workflow_id: 5, status: "completed", conclusion: "success",
    created_at: from, run_started_at: from, updated_at: to,
  }));
  const step = { number: 1, name: "Install native test driver dependencies", status: "completed",
    conclusion: "success", started_at: from, completed_at: to };
  const jobs = ["macos / Native acceptance (macos-15-intel)", "synthetic private job"].map((name, index) => ({
    id: index + 5, run_id: 1, run_attempt: 1, head_sha: sha, name, runner_id: 8, status: "completed",
    conclusion: "success", created_at: from, started_at: from, completed_at: to, steps: [step],
  }));
  try {
    writeFileSync(join(directory, "fixture.json"), JSON.stringify({ runs, jobs }));
    writeFileSync(join(directory, "gh"), String.raw`#!/usr/bin/env node
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runs, jobs } = JSON.parse(readFileSync(process.env.ACTIONS_FIXTURE, "utf8"));
assert.deepEqual(process.argv.slice(2, 7), ["api", "--method", "GET", "--hostname", "github.com"]);
const url = new URL(process.argv[7], "https://github.com");
assert.match(url.pathname, /^\/repos\/synthetic\/example\/actions\/runs/);
if (url.searchParams.has("created")) {
  assert.equal(url.searchParams.get("created"), "${from}..${to}");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("per_page"), "100");
  const listed = process.env.ACTIONS_CASE === "empty" ? [] : runs;
  console.log(JSON.stringify({ total_count: listed.length, workflow_runs: listed }));
} else {
  const [, id, endpoint] = url.pathname.match(/runs\/(1|2)\/attempts\/1(\/jobs)?$/);
  if (endpoint) {
    const listed = id === "1" ? jobs : [];
    const total = id === "2" && process.env.ACTIONS_CASE === "partial" ? 1 : listed.length;
    console.log(JSON.stringify({ total_count: total, jobs: listed }));
  } else {
    console.log(JSON.stringify(runs[Number(id) - 1]));
  }
}
`, { mode: 0o700 });
    const cli = fileURLToPath(new URL("../import-actions.ts", import.meta.url));
    const args = [cli, directory, "synthetic/example", "--window", from, to, "1", "2"];
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, ACTIONS_FIXTURE: join(directory, "fixture.json") };
    const invoke = (fixtureCase: string) =>
      execFileSync(process.execPath, args, { env: { ...env, ACTIONS_CASE: fixtureCase }, encoding: "utf8" });
    const failed = spawnSync(process.execPath, args, { env: { ...env, ACTIONS_CASE: "partial" }, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Partial or changing GitHub job inventory/);
    assert.equal(existsSync(database), false);
    assert.deepEqual(JSON.parse(invoke("empty")),
      { from, to, maxPages: 1, maxAttempts: 2, pagesRead: 1, reportedTotal: 0, eligible: 0, captured: 0, inventoryComplete: true });
    const coverage =
      { from, to, maxPages: 1, maxAttempts: 2, pagesRead: 1, reportedTotal: 2, eligible: 2, captured: 2, inventoryComplete: true };
    assert.deepEqual(JSON.parse(invoke("full")), coverage);
    assert.deepEqual(JSON.parse(invoke("full")), coverage);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const attempts = db.prepare("SELECT run_id, job_count, started_at FROM action_attempts ORDER BY run_id").all();
      assert.deepEqual(attempts.map(Object.values), [[1, 2, Date.parse(from) / 1000], [2, 0, null]]);
      const steps = db.prepare(`SELECT j.label, s.label AS step, j.queue_end-j.created_at AS queue,
        j.execution_end-j.execution_start AS execution, s.completed_at-s.started_at AS step_seconds
        FROM action_steps s JOIN action_jobs j USING (repository, run_id, attempt, job_id) ORDER BY job_id`).all();
      assert.deepEqual(steps.map(Object.values), [
        ["macos / Native acceptance (macos-15-intel)", step.name, 0, 60, 60], ["Other jobs", "Other steps", 0, 60, 60],
      ]);
    } finally {
      db.close();
    }
    const seed = new DatabaseSync(database);
    try {
      seed.exec(`
        DELETE FROM action_attempts;
        DROP VIEW IF EXISTS actions_wait_facts;
        CREATE TABLE actions_wait_facts (repository TEXT, run_id INTEGER, head_sha TEXT, attempt INTEGER,
          identity_exact INTEGER, started_ms INTEGER, ended_ms INTEGER);
      `);
      const wait = seed.prepare("INSERT INTO actions_wait_facts VALUES (?, ?, ?, 1, ?, ?, ?)");
      const start = Date.parse(from);
      const end = Date.parse(to);
      for (const id of [1, 2, 2]) wait.run("synthetic/example", id, sha, 1, start, end);
      wait.run("synthetic/example", 3, sha, 1, end, end + 1000);
      wait.run("synthetic/example", 4, sha, 0, start, end);
      wait.run("synthetic/other", 5, sha, 1, start, end);
    } finally {
      seed.close();
    }
    const waitArgs = [cli, directory, "synthetic/example", "--from-waits", from, to];
    const partial = spawnSync(process.execPath, [...waitArgs, "2"], { env: { ...env, ACTIONS_CASE: "partial" }, encoding: "utf8" });
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /Partial or changing GitHub job inventory/);
    const capture = () => JSON.parse(execFileSync(process.execPath, [...waitArgs, "1"], { env, encoding: "utf8" }));
    assert.deepEqual(capture(), { sourceAvailable: true, missingBeforeCapture: 2, captured: 1 });
    const readBack = new DatabaseSync(database, { readOnly: true });
    try {
      assert.deepEqual(readBack.prepare("SELECT run_id FROM action_attempts").all().map(Object.values), [[2]]);
    } finally {
      readBack.close();
    }
    assert.deepEqual(capture(), { sourceAvailable: true, missingBeforeCapture: 1, captured: 1 });
    assert.deepEqual(capture(), { sourceAvailable: true, missingBeforeCapture: 0, captured: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
