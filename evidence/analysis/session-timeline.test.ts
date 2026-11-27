import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectPlowFeed } from "../read.ts";
import { analyzeJoinedThread, publishJoinedAnalysis } from "./session-history.ts";
import { test } from "node:test";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";

type FixtureList<T> = { $: "Nil" } | { $: "Con"; head: T; tail: FixtureList<T> };
const fixtureList = <T>(items: T[]) => items.reduceRight<FixtureList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
function fixtureRows<T>(list: FixtureList<T>) {
  const output: T[] = [];
  for (let node = list; node.$ === "Con"; node = node.tail) output.push(node.head);
  return output;
}

test("daily outcome impact clips confirmed intervals and keeps shared time out of unique pattern totals", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "daily-impact-"));
  try {
    const compiled = await buildPolicy(job, new URL("./outcome-delay.bend", import.meta.url), "daily-impact.mjs");
    type Time = { $: "Some"; value: number } | { $: "None" };
    const policy = await loadPolicy<{
      outcome_delays_in_window(windows: FixtureList<unknown>, from: number, to: number): {
        totals: { confirmedMs: Time; sharedMs: Time; affectedOutcomes: number; coverage: { occurrences: number; sufficient: number } };
        patterns: FixtureList<{ pattern: string; uniqueMs: Time }>;
      };
    }>(compiled);
    const blocker = (pattern: string, fromMs: number, untilMs: number) => ({
      $: "Blocker", occurrence: pattern, pattern, condition: pattern, scope: "revision",
      fromMs, untilMs, pending: "pending", released: "released",
    });
    const full = { $: "DelayWindow", id: "ready", outcome: "merge", scope: "revision", stage: "delivery",
      basis: "exact-revision", readyMs: 1000, possibleMs: 8000, readiness: "ready", availability: "possible",
      blockers: fixtureList([blocker("ci", 1000, 5000), blocker("approval", 4000, 8000)]),
    };
    const unknown = { ...full, id: "unknown", outcome: "deploy", readiness: "",
      blockers: fixtureList([blocker("runner", 3500, 0)]) };
    const result = policy.outcome_delays_in_window(fixtureList([full, full, unknown]), 3000, 7000);
    assert.equal(result.totals.affectedOutcomes, 1);
    assert.equal(result.totals.coverage.occurrences, 3);
    assert.equal(result.totals.coverage.sufficient, 2);
    assert.deepEqual(result.totals.confirmedMs, { $: "Some", value: 4000 });
    assert.deepEqual(result.totals.sharedMs, { $: "Some", value: 1000 });
    assert.deepEqual(fixtureRows(result.patterns).map(({ pattern, uniqueMs }) => [pattern, uniqueMs]),
      [["approval", { $: "Some", value: 2000 }], ["ci", { $: "Some", value: 1000 }], ["runner", { $: "None" }]]);
    assert.deepEqual(policy.outcome_delays_in_window(fixtureList([full]), 8000, 9000).totals.confirmedMs, { $: "None" });
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});


test("timeline protects gaps, overlap precedence, and clipped failure times", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent, "Set PLOW_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "timeline-"));
  try {
    const compiled = await buildPolicy(job, new URL("./session-timeline.bend", import.meta.url), "timeline.mjs");
    const policy = await loadPolicy<{
      timeline(records: FixtureList<object>, end: number): {
        phases: FixtureList<{ a: number; b: number; kind: number; name: string }>;
        failures: FixtureList<{ at: number; label: string }>;
      };
    }>(compiled);
    const observation = (index: number, lane: number, start: number, end: number, label: string, state: string, clipped = false) =>
      ({ $: "HistoryEvent", index, lane, start, end: { $: "Some", value: end }, label, state, source: "", relation: "", clipped });
    const evidence = policy.timeline(fixtureList([
      observation(0, 6, 2000, 5000, "Linux", "completed"),
      observation(1, 1, 1000, 2000, "Active", "completed"),
      observation(6, 3, 2500, 3250, "Read settings", "completed"),
      observation(7, 7, 5000, 7000, "Linux", "failure"),
      observation(8, 7, 5500, 7000, "Windows", "failure", true),
    ]), 8000);
    assert.deepEqual(fixtureRows(evidence.phases).map(({ a, b, kind, name }) => [a, b, kind, name]), [
      [0, 2000, 0, "Activity unclear"], [2000, 2500, 1, "Linux"], [2500, 3250, 2, "Read settings"],
      [3250, 5500, 1, "Linux"], [5500, 7000, 1, "Workflows & waits"], [7000, 8000, 0, "Activity unclear"],
    ]);
    assert.deepEqual(fixtureRows(evidence.failures).map(({ at, label }) => [at, label]), [[7000, "Linux"]]);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("Plow feed preserves aligned history coverage and detailed trace bounds", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "plow-feed-"));
  try {
    const dbPath = join(job, 'projection-fixture.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE t3_threads(instance TEXT, thread_id TEXT, created_ms INTEGER, updated_ms INTEGER);
      CREATE TABLE t3_runs(instance TEXT, thread_id TEXT, run_id TEXT, requested_ms INTEGER, started_ms INTEGER,
        completed_ms INTEGER, status TEXT);
      INSERT INTO t3_threads VALUES ('t3','older',100,1200),('t3','latest',1500,3000),('t3','unknown',3200,3400);
      INSERT INTO t3_runs VALUES ('t3','older','a',110,300,900,'failed'),('t3','latest','b',2000,2400,NULL,'running'),
        ('t3','latest','c',2100,NULL,NULL,'queued'),('t3','latest','d',NULL,2300,3200,'completed'),
        ('another','latest','e',1600,1700,1800,'completed');
    `)
    db.close()
    assert.deepEqual(await projectPlowFeed(dbPath, job), {
      observed: 3000,
      history: { first: 1, threads: [
        { work: 600, workflow: 190 }, { work: 0, workflow: 400 }, { work: 0, workflow: 0 },
      ] },
      traces: [
        { startUtcMs: 1500, end: .9, work: [], wait: [[.5,.9,'T3 admission']], errors: [] },
        { startUtcMs: 100, end: .8, work: [[.2,.8,'Provider run']], wait: [[.01,.2,'T3 admission']], errors: [.8] },
      ],
    })
    const expanded = new DatabaseSync(dbPath)
    const thread = expanded.prepare("INSERT INTO t3_threads VALUES (?,?,?,?)")
    const run = expanded.prepare("INSERT INTO t3_runs VALUES (?,?,?,?,?,?,?)")
    for (let i = 0; i < 60; i++) {
      const start = 10000 + i * 10000
      thread.run("fixture", String(i), start, start + 3000)
      if (i === 7) continue
      run.run("fixture", String(i), "one", start + 100, start + 300, start + 900, "completed")
      run.run("fixture", String(i), "two", start + 600, start + 800, start + 1200, "completed")
    }
    expanded.close()
    const extended = await projectPlowFeed(dbPath, job)
    assert.equal(extended.traces.length, 10)
    assert.equal(extended.history.first, 11)
    assert.equal(extended.history.threads.length, 53)
    assert.deepEqual(extended.history.threads.slice(0, 2), [{ work: 0, workflow: 0 }, { work: 900, workflow: 200 }])
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});


test("joined bottleneck replay counts exact job facts once and preserves missing clocks", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "joined-replay-"));
  const file = join(job, "evidence.sqlite");
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec(readFileSync(new URL("../storage/sources.sql", import.meta.url), "utf8"));
      db.exec(readFileSync(new URL("../storage/actions.sql", import.meta.url), "utf8"));
      db.exec(`
        INSERT INTO t3_threads VALUES ('fixture','thread',1700000000000,1700000003000,'completed','manual_t3',0,1);
        INSERT INTO t3_runs VALUES ('fixture','thread','run',1700000000000,1700000001000,NULL,'running');
        INSERT INTO t3_ci_observations VALUES ('fixture','thread','query','query','synthetic/example',40,2,'revision');
        INSERT INTO t3_ci_observations VALUES ('fixture','thread','watch','watch','synthetic/example',40,2,'revision');
        INSERT INTO t3_ci_observations VALUES ('fixture','thread','unverified','query','synthetic/example',40,1,'revision');
        INSERT INTO t3_ci_links VALUES ('fixture','thread','query'), ('fixture','thread','watch');
        INSERT INTO action_attempts VALUES ('synthetic/example',40,2,'revision',1,'completed','failure',1700000000,1700000001,1700000010,1700000011,3);
        INSERT INTO action_jobs VALUES
          ('synthetic/example',40,2,61,'Test','completed','failure',1700000000,0,1700000002,1700000002,1700000010),
          ('synthetic/example',40,2,62,'Test','completed','failure',1700000000,1,1700000001,1700000001,1700000100),
          ('synthetic/example',40,2,63,'Test','queued','',1700000000,0,NULL,NULL,NULL);
      `);
    } finally {
      db.close();
    }
    const analysis = await analyzeJoinedThread(file, job, "fixture", "thread");
    assert.deepEqual(analysis.coverage, { t3Runs: 1, codexSpans: 0, githubAttempts: 1, githubJobs: 3, carriedGitHubJobs: 1 });
    const sorted = (values: unknown[]) => values.map((value) => JSON.stringify(value)).sort();
    assert.deepEqual(sorted(analysis.costs), sorted([
      { $: "Cost", clock: "ci-job-queue", operation: "Test", count: 1, seconds: 2, unknown: 1 },
      { $: "Cost", clock: "t3-run-admission", operation: "provider run", count: 1, seconds: 1, unknown: 0 },
      { $: "Cost", clock: "ci-job-execution", operation: "Test", count: 1, seconds: 8, unknown: 1 },
      { $: "Cost", clock: "t3-run-envelope", operation: "provider run", count: 0, seconds: 0, unknown: 1 },
    ]));
    assert.deepEqual(analysis.files, []);
    assert.equal(analysis.findings.length, 1);
    assert.match(JSON.stringify(analysis.findings[0]), /"ci-job-failure"/);
    const additional = new DatabaseSync(file);
    try {
      additional.exec(`
        INSERT INTO t3_threads VALUES
          ('fixture','shared',1699900000000,1700000003000,'completed','manual_t3',0,1),
          ('fixture','metadata-only',1699900000000,1700000003000,'completed','manual_t3',0,0),
          ('fixture','future',1700000012000,1700000012000,'completed','manual_t3',0,0);
        INSERT INTO t3_runs VALUES ('fixture','shared','shared-run',1699900000000,1699900001000,1700000003000,'completed');
        INSERT INTO t3_ci_observations VALUES ('fixture','shared','watch','watch','synthetic/example',40,2,'revision');
        INSERT INTO t3_ci_links VALUES ('fixture','shared','watch');
        WITH RECURSIVE i(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM i WHERE n<51)
        INSERT INTO t3_threads SELECT 'fixture','partial-'||n,1700000000000,1700000000000,'running','manual_t3',0,0 FROM i;
      `);
    } finally {
      additional.close();
    }
    const output = join(job, "analysis.sqlite");
    const cutoff = 1700000012000;
    assert.equal((await publishJoinedAnalysis(file, output, job, cutoff)).recomputed, 53);
    const delay = { pattern: "review", uniqueMs: 10000, medianMs: 10000, worstMs: 10000,
      stage: "merge", affectedOutcomes: 1, coverage: { sufficient: 1, occurrences: 2 } };
    assert.equal((await publishJoinedAnalysis(file, output, job, cutoff, async () =>
      ({ patterns: [delay, { ...delay, pattern: "checks", uniqueMs: 12000 }] }))).recomputed, 0);
    const published = new DatabaseSync(output, { readOnly: true });
    try {
      const summary = JSON.parse(String(published.prepare("SELECT payload FROM analysis_summary").get()?.payload));
      assert.equal(Date.parse(summary.window.to) - Date.parse(summary.window.from), 86400000);
      assert.deepEqual(summary.coverage, { $: "Coverage", active: 53, withCodex: 0, withCI: 2, withBoth: 0 });
      assert.deepEqual(summary.ranking, [{ $: "Rank", rule: "ci-job-failure", threads: 2, occurrences: 1 }]);
      assert.deepEqual(summary.priorities.map((p: { target: string; totalMs: number }) => [p.target, p.totalMs]),
        [["checks", 12000], ["review", 10000], ["synthetic/example · workflow 1 · Test", 8000]]);
      assert.equal(summary.priorities[2].occurrences, 1);
      assert.equal(summary.priorities[2].affectedThreads, 2);
      assert.equal(summary.priorities[2].affectedOutcomes, null);
      const ciThread = summary.threads.find((thread: { coverage: { githubJobs: number } }) => thread.coverage.githubJobs);
      const detail = JSON.parse(String(published.prepare("SELECT payload FROM analysis_threads WHERE id=?").get(ciThread.id)?.payload));
      assert.deepEqual(detail.rules, ["ci-job-failure"]);
      assert.equal(detail.coverage.githubJobs, 3);
      assert.notEqual(detail.id, "thread");
      assert.ok(!JSON.stringify(detail).includes("synthetic/example"));
    } finally {
      published.close();
    }
    assert.equal((await publishJoinedAnalysis(file, output, job, cutoff + 86400000)).analyzedThreads, 1);
    const expired = new DatabaseSync(output, { readOnly: true });
    try {
      const summary = JSON.parse(String(expired.prepare("SELECT payload FROM analysis_summary").get()?.payload));
      assert.deepEqual(summary.ranking, []);
      assert.deepEqual(summary.priorities, []);
      assert.equal(expired.prepare("SELECT count(*) AS n FROM analysis_threads").get()?.n, 1);
    } finally {
      expired.close();
    }
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
