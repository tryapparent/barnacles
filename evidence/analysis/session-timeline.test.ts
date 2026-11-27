import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectPlowFeed } from "../read.ts";
import { test } from "node:test";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";

type FixtureList<T> = { $: "Nil" } | { $: "Con"; head: T; tail: FixtureList<T> };
const fixtureList = <T>(items: T[]) => items.reduceRight<FixtureList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
function fixtureRows<T>(list: FixtureList<T>) {
  const output: T[] = [];
  for (let node = list; node.$ === "Con"; node = node.tail) output.push(node.head);
  return output;
}


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
    const environment = '00000000-0000-4000-8000-000000000001'
    const threadId = '00000000-0000-4000-8000-000000000002'
    const delegate = 'subagent:codex:' + 'a'.repeat(64)
    db.exec(`
      CREATE TABLE t3_threads(instance TEXT, thread_id TEXT, created_ms INTEGER, updated_ms INTEGER);
      CREATE TABLE t3_runs(instance TEXT, thread_id TEXT, run_id TEXT, requested_ms INTEGER, started_ms INTEGER,
        completed_ms INTEGER, status TEXT);
      INSERT INTO t3_threads VALUES ('t3','${threadId}',100,1200),('t3','${delegate}',1500,3000),('t3','unknown',3200,3400);
      INSERT INTO t3_runs VALUES ('t3','${threadId}','a',110,300,900,'failed'),('t3','${delegate}','b',2000,2400,NULL,'running'),
        ('t3','${delegate}','c',2100,NULL,NULL,'queued'),('t3','${delegate}','d',NULL,2300,3200,'completed'),
        ('another','latest','e',1600,1700,1800,'completed');
    `)
    db.close()
    assert.deepEqual(await projectPlowFeed(dbPath, job, new Map([['t3', environment]])), {
      observed: 3000,
      history: { first: 1, threads: [
        { work: 600, workflow: 190 }, { work: 0, workflow: 400 }, { work: 0, workflow: 0 },
      ] },
      traces: [
        { t3Path: environment + '/' + encodeURIComponent(delegate), startUtcMs: 1500, end: .9, work: [], wait: [[.5,.9,'T3 admission']], errors: [] },
        { t3Path: environment + '/' + threadId, startUtcMs: 100, end: .8, work: [[.2,.8,'Provider run']], wait: [[.01,.2,'T3 admission']], errors: [.8] },
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
