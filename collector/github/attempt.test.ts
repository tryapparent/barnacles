import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildAdmissionPolicy, loadEvidence, sourcePolicy, type SourcePolicy } from "../../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { collectAttempt, collectWindow, githubReader, type ClockPolicy, type GitHubReader } from "./attempt.ts";
import { pollGitHub } from "./delivery.ts";

const jobRoot = process.env.BARNACLES_TEST_DIRECTORY;
assert.ok(jobRoot);

test("Bend2 clocks reach SQLite through the exact-attempt importer", async () => {
  const directory = mkdtempSync(join(jobRoot, "test-"));
  try {
    const policy = await loadPolicy<ClockPolicy>(await buildPolicy(directory, new URL("./clocks.bend", import.meta.url), "clocks.mjs"));
    const admission = await buildAdmissionPolicy(directory);
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
    const capture = (source: GitHubReader = read) => collectAttempt(identity, policy, source);
    const observed = await capture();
    const path = join(directory, "evidence.sqlite");
    const save = (attempt = observed) => loadEvidence(path, { source: "github-actions", attempt }, admission);
    save();
    save();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const results = db.prepare("SELECT queue_end-created_at AS queue, execution_end-execution_start AS execution, prior_execution FROM action_jobs ORDER BY job_id").all();
      assert.deepEqual(results.map((row) => Object.values(row)), [
        [2, 37, 0], [null, null, 1], [39, null, 0], [null, null, 0], [null, null, 0],
      ]);
      const steps = db.prepare("SELECT label, completed_at-started_at AS seconds FROM action_steps ORDER BY job_id, step_number").all();
      assert.deepEqual(steps.map((row) => Object.values(row)), [
        [allocated.steps[0].name, 30], ["Other steps", null],
        [allocated.steps[0].name, null], ["Other steps", null],
      ]);
      assert.throws(() => save({ ...observed, sourceUpdated: 0, jobs: [] }), /older observation/);
      assert.throws(() => loadEvidence(path, { source: "github-actions-window", attempts: [
        { ...observed, runId: 2 }, { ...observed, sourceUpdated: 0 },
      ] }, admission), /older observation/);
      assert.equal(db.prepare("SELECT count(*) AS count FROM action_attempts").get()?.count, 1);
      assert.equal(db.prepare("SELECT count(*) AS count FROM action_jobs").get()?.count, 5);
    } finally {
      db.close();
    }
    const occupancy = JSON.parse(execFileSync(process.execPath,
      ["evidence/report-actions.ts", path, identity.repository], { encoding: "utf8" }));
    const queue = occupancy.find((row: { clock: string }) => row.clock === "CI queue");
    assert.deepEqual([queue.count, queue.mean_seconds, queue.total_seconds, queue.unmeasured_count], [2, 20.5, 41, 3]);
    const attemptWith = (jobs: unknown[], total_count = jobs.length, metadata = run) =>
      capture((path) => path.includes("/jobs?") ? { total_count, jobs } : metadata);
    await assert.rejects(attemptWith([], 1), /Partial or changing GitHub job inventory/);
    await assert.rejects(() => collectAttempt({ ...identity, sha: "b".repeat(40) }, policy, read), /identity/);
    await assert.rejects(attemptWith([{ ...allocated, run_attempt: 1 }]), /job identity/);
    const pages = Array.from({ length: 100 }, (_, index) => ({ ...allocated, id: 2 ** 32 + index, steps: [] }));
    const secondPage = { ...allocated, id: 2 ** 32 + 100, steps: [] };
    const pagedRead = (path: string, total: number, pageTwo: readonly unknown[]) => {
      if (!path.includes("/jobs?")) return run;
      return path.endsWith("page=1") ? { total_count: 101, jobs: pages } : { total_count: total, jobs: pageTwo };
    };
    const key = join(directory, "synthetic.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }));
    const authRoutes: string[] = [];
    const appRead = githubReader(identity.repository, {
      BARNACLES_GITHUB_AUTH: "app", BARNACLES_GITHUB_CREDENTIAL_FILE: key,
      BARNACLES_GITHUB_APP_ID: "1", BARNACLES_GITHUB_INSTALLATION_ID: "2",
    }, async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      assert.equal(url.origin, "https://api.github.com");
      if (url.pathname.endsWith("/installation") || init?.method === "POST") {
        authRoutes.push(`${init?.method} ${url.pathname}`);
        assert.match(headers.get("authorization")!, /^bearer [^.]+\.[^.]+\.[^.]+$/);
        if (init?.method === "GET") return Response.json({ id: 2 });
        assert.deepEqual(JSON.parse(String(init.body)), {
          repositories: ["example"], permissions: { actions: "read", contents: "read", pull_requests: "read" },
        });
        return Response.json({ token: "ghs_synthetic", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      assert.equal(init?.method, "GET");
      assert.equal(headers.get("authorization"), "token ghs_synthetic");
      assert.match(url.pathname, /^\/repos\/synthetic\/example\/actions\/runs\/1\/attempts\/2(\/jobs)?$/);
      return Response.json(pagedRead(url.pathname + url.search, 101, [secondPage]));
    });
    const paged = await capture(appRead);
    assert.deepEqual(authRoutes, ["GET /repos/synthetic/example/installation", "POST /app/installations/2/access_tokens"]);
    assert.deepEqual(paged.jobs.map(({ id }) => id), [...pages, secondPage].map(({ id }) => id));
    for (const [total, page, error] of [
      [101, [pages[0]], /Duplicate GitHub job ID/],
      [102, [secondPage], /changing GitHub job inventory/],
      [101, [], /Partial or changing GitHub job inventory/],
    ] as const) {
      await assert.rejects(capture((path) => pagedRead(path, total, page)), error);
    }
    await assert.rejects(attemptWith([{ ...allocated, steps: Array(2).fill(allocated.steps[0]) }]), /Duplicate GitHub step number/);
    assert.equal((await attemptWith([{ ...allocated, run_attempt: undefined }])).jobs.length, 1);
    const jobless = await attemptWith([], 0, { ...run, status: "queued" });
    assert.deepEqual(jobless.jobs, []);
    assert.equal(jobless.startedAt, null);
    assert.equal(observed.startedAt, null);
    assert.equal((await attemptWith([{ ...allocated, created_at: null }])).jobs[0].executionEnd, null);
    const changing = /Changing GitHub attempt or job inventory/;
    let snapshots = 0;
    await assert.rejects(capture((path) => path.includes("/jobs?")
      ? { total_count: 1, jobs: [{ ...allocated, id: ++snapshots }] } : run), changing);
    let metadataReads = 0;
    await assert.rejects(capture((path) => path.includes("/jobs?")
      ? { total_count: 1, jobs: [allocated] } : { ...run, updated_at: time(55 + metadataReads++) }),
    changing);
    const pagedJobs = Array.from({ length: 100 }, (_, index) => ({ ...allocated, id: index + 100 }));
    await assert.rejects(capture((path) => path.includes("/jobs?")
      ? path.endsWith("page=1") ? { total_count: 101, jobs: pagedJobs } : { total_count: 100, jobs: [] }
      : run), /Partial or changing GitHub job inventory/);

    const listedRuns = Array.from({ length: 101 }, (_, index) => ({ ...run, id: index + 1, created_at: time(1) }));
    const inventoryRead = (path: string) => {
      if (path.includes("/actions/runs?")) {
        return { total_count: 101, workflow_runs: path.endsWith("page=1") ? listedRuns.slice(0, 100) : listedRuns.slice(100) };
      }
      return read(path);
    };
    const window = (pages: number, source: GitHubReader = inventoryRead) =>
      collectWindow(identity.repository, time(1), time(56), pages, 1, policy, source);
    const capped = await window(1);
    assert.deepEqual([capped.coverage.reportedTotal, capped.coverage.eligible, capped.coverage.captured,
      capped.coverage.inventoryComplete, capped.coverage.pagesRead], [101, 100, 1, false, 1]);
    const full = await window(2);
    assert.deepEqual([full.coverage.eligible, full.coverage.captured, full.coverage.inventoryComplete, full.coverage.pagesRead],
      [101, 1, true, 2]);
    await assert.rejects(window(2, (path) =>
      path.endsWith("page=2") ? { total_count: 101, workflow_runs: [listedRuns[0]] } : inventoryRead(path)),
    /Duplicate GitHub workflow run ID/);
    await assert.rejects(window(2, (path) =>
      path.endsWith("page=2") ? { total_count: 101, workflow_runs: [] } : inventoryRead(path)),
    /Partial or changing GitHub run inventory/);
    await assert.rejects(window(11), /1–10 pages/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded Actions imports report coverage, replay atomically, and preserve jobless attempts", () => {
  const directory = mkdtempSync(join(jobRoot, "test-"));
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
    const checkPartial = (args: string[]) => {
      const result = spawnSync(process.execPath, args, { env: { ...env, ACTIONS_CASE: "partial" }, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Partial or changing GitHub job inventory/);
    };
    checkPartial(args);
    assert.equal(existsSync(database), false);
    for (const fixture of ["empty", "full", "full"]) {
      const count = fixture === "empty" ? 0 : 2;
      assert.deepEqual(JSON.parse(invoke(fixture)), {
        from, to, maxPages: 1, maxAttempts: 2, pagesRead: 1, reportedTotal: count,
        eligible: count, captured: count, inventoryComplete: true,
      });
    }
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
    checkPartial([...waitArgs, "2"]);
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

test("polling captures changing attempts and excludes unverifiable releases", async () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const directory = mkdtempSync(join(parent, "poll-github-"));
  const repo = "synthetic/example";
  const root = `repos/${repo}`;
  const database = join(directory, "evidence.sqlite");
  const sha = "a".repeat(40);
  const tag = `linux-main-v2-${sha}`;
  const time = (ago: number) => new Date(Date.now() - ago * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const opened = time(600);
  const merged = time(400);
  const published = time(200);
  const pr = { number: 17, base: { repo: { full_name: repo } }, state: "open", commits: 0,
    created_at: opened, updated_at: opened, merged: false };
  const run = { id: 20, run_attempt: 1, head_sha: sha, workflow_id: 21, status: "queued",
    created_at: opened, updated_at: opened };
  const release = { id: 22, tag_name: tag, draft: false, published_at: published,
    assets: [{ id: 23, name: "Synthetic-linux-x86_64.AppImage", state: "uploaded", size: 50 }] };
  try {
    const policy = await loadPolicy<SourcePolicy>(await buildPolicy(directory, sourcePolicy, "sources.mjs"));
    const admission = await buildAdmissionPolicy(directory);
    const clocks = await loadPolicy<ClockPolicy>(
      await buildPolicy(directory, new URL("./clocks.bend", import.meta.url), "clocks.mjs"));
    const invoke = (responses: Record<string, unknown>, accessible = true) => pollGitHub(database, repo, policy, clocks, admission,
      (path) => {
        if (!Object.hasOwn(responses, path)) throw Error("Missing fixture response");
        return responses[path];
      },
      () => accessible ? { http: 206, bytes: 1, range: true } : { http: 404, bytes: 0, range: false });
    const prsPath = root + "/pulls?state=all&sort=updated&direction=desc&per_page=30";
    const runsPath = root + "/actions/runs?per_page=30";
    const releasesPath = root + "/releases?per_page=20";
    const attemptPath = root + "/actions/runs/20/attempts/1";
    const initial = {
      [prsPath]: [pr], [runsPath]: { workflow_runs: [run] }, [releasesPath]: [],
      [root + "/pulls/17"]: pr,
      [root + "/pulls/17/commits?per_page=100"]: [],
      [root + "/pulls/17/reviews?per_page=100"]: [],
      [attemptPath]: run,
      [attemptPath + "/jobs?per_page=100&page=1"]: { total_count: 0, jobs: [] },
    };
    assert.deepEqual(await invoke(initial), { pullRequestsScanned: 1, workflowRunsScanned: 1, releasesScanned: 0, failed: 0 });
    const titled = { ...pr, title: "Add release notes" };
    assert.equal((await invoke({ ...initial, [prsPath]: [titled], [root + "/pulls/17"]: titled })).failed, 0);
    const titles = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(titles.prepare("SELECT title FROM github_pr_titles WHERE pr_number=17").get()?.title, titled.title);
    } finally {
      titles.close();
    }
    const completed = { ...run, status: "completed", conclusion: "success", updated_at: merged };
    const mergedPr = { ...pr, state: "closed", merged: true, merged_at: merged, merge_commit_sha: sha, updated_at: merged };
    const listings = { [prsPath]: [mergedPr], [runsPath]: { workflow_runs: [completed] }, [releasesPath]: [release] };
    const next = {
      ...initial, ...listings,
      [root + "/pulls/17"]: mergedPr,
      [attemptPath]: completed,
      [root + "/releases/tags/" + tag]: release,
      [root + "/git/ref/tags/" + tag]: { object: { type: "commit", sha } },
    };
    const read = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return [
          db.prepare("SELECT status FROM action_attempts WHERE run_id=20").get()?.status,
          db.prepare("SELECT MAX(shipped) AS shipped FROM github_release_observations").get()?.shipped,
        ];
      } finally {
        db.close();
      }
    };
    assert.deepEqual(read(), ["queued", null]);
    assert.equal((await invoke(next, false)).failed, 0);
    assert.deepEqual(read(), ["completed", 0]);
    await sleep(1100);
    assert.equal((await invoke(next)).failed, 0);
    assert.deepEqual(read(), ["completed", 1]);
    assert.equal((await invoke(listings)).failed, 0);
    await assert.rejects(() => invoke({}), /Missing fixture/);
    assert.deepEqual(read(), ["completed", 1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
