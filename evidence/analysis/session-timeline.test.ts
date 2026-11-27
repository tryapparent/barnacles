import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
