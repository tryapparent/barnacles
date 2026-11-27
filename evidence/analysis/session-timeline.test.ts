import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { projectPlowFeed } from "./session-history.ts";
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


test("projects scoped T3 links with exact session clocks", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "feed-"));
  try {
    const t3Environment = "00000000-0000-4000-8000-000000000001";
    const t3Thread = "00000000-0000-4000-8000-000000000002";
    const t3Delegate = "subagent:codex:" + "a".repeat(64);
    const t3Path = t3Environment + "/" + encodeURIComponent(t3Delegate);
    const dbPath = join(job, 'projection-fixture.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE t3_threads(instance TEXT, thread_id TEXT, created_ms INTEGER, updated_ms INTEGER);
      CREATE TABLE t3_runs(instance TEXT, thread_id TEXT, run_id TEXT, requested_ms INTEGER, started_ms INTEGER,
        completed_ms INTEGER, status TEXT);
      INSERT INTO t3_threads VALUES ('fixture-t3','${t3Thread}',100,1200),('fixture-t3','${t3Delegate}',1500,3000),('t3','unknown',3200,3400);
      INSERT INTO t3_runs VALUES ('fixture-t3','${t3Thread}','a',110,300,900,'failed'),('fixture-t3','${t3Delegate}','b',2000,2400,NULL,'running'),
        ('fixture-t3','${t3Delegate}','c',2100,NULL,NULL,'queued'),('fixture-t3','${t3Delegate}','d',NULL,2300,3200,'completed'),
        ('another','latest','e',1600,1700,1800,'completed');
    `)
    db.close()
    const projected = await projectPlowFeed(dbPath, job, new Map([['fixture-t3', t3Environment]]))
    assert.deepEqual(projected, {
      observed: 3000,
      traces: [
        { t3Path, startUtcMs: 1500, end: .9, work: [], wait: [[.5,.9,'T3 admission']], errors: [] },
        { t3Path: t3Environment + '/' + t3Thread, startUtcMs: 100, end: .8, work: [[.2,.8,'Provider run']], wait: [[.01,.2,'T3 admission']], errors: [.8] },
      ],
    })
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
