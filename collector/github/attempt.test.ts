import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { saveAttempt } from "../../evidence/actions.ts";
import { buildClocks } from "../build.ts";
import { collectAttempt } from "./attempt.ts";

test("Bend2 clocks reach SQLite through the exact-attempt importer", async () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const directory = mkdtempSync(join(parent, "test-"));
  try {
    const policy = (await import(pathToFileURL(await buildClocks(directory)).href)).default;
    const identity = { repository: "synthetic/example", runId: 1, attempt: 2, sha: "a".repeat(40) };
    const time = (second: number) => `2026-01-01T12:00:${String(second).padStart(2, "0")}Z`;
    const run = { id: 1, run_attempt: 2, head_sha: identity.sha, workflow_id: 5,
      status: "completed", conclusion: "success", updated_at: time(56) };
    const allocated = {
      id: 10, run_id: 1, run_attempt: 2, head_sha: identity.sha, runner_id: 8,
      name: "macos / Build signed Mac candidate", status: "completed", conclusion: "success",
      created_at: time(1), started_at: time(3), completed_at: time(40),
      steps: [
        { number: 1, name: "Assemble signed notarized candidate", status: "completed",
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
    saveAttempt(path, observed);
    saveAttempt(path, observed);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const results = db.prepare("SELECT queue_end-created_at AS queue, execution_end-execution_start AS execution, prior_execution FROM action_jobs ORDER BY job_id").all();
      assert.deepEqual(results.map((row) => Object.values(row)), [
        [2, 37, 0], [null, null, 1], [39, null, 0], [null, null, 0], [null, null, 0],
      ]);
      const steps = db.prepare("SELECT label, completed_at-started_at AS seconds FROM action_steps ORDER BY job_id, step_number").all();
      assert.deepEqual(steps.map((row) => Object.values(row)), [
        ["Assemble signed notarized candidate", 30], ["Other steps", null],
        ["Assemble signed notarized candidate", null], ["Other steps", null],
      ]);
      const occupancy = db.prepare("SELECT count, mean_seconds, total_seconds, unmeasured_count FROM action_occupancy WHERE clock='queue'").get();
      assert.deepEqual(Object.values(occupancy!), [2, 20.5, 41, 3]);
      assert.throws(() => saveAttempt(path, { ...observed, sourceUpdated: 0, jobs: [] }), /older observation/);
      assert.equal(db.prepare("SELECT count(*) AS count FROM action_jobs").get()?.count, 5);
    } finally {
      db.close();
    }
    assert.throws(() => collectAttempt(identity, policy, (path) =>
      path.includes("/jobs?") ? { total_count: 1, jobs: [] } : run), /Partial GitHub job inventory/);
    assert.throws(() => collectAttempt({ ...identity, sha: "b".repeat(40) }, policy, read), /identity/);
    const jobless = collectAttempt(identity, policy, (path) =>
      path.includes("/jobs?") ? { total_count: 0, jobs: [] } : { ...run, status: "queued" });
    assert.deepEqual(jobless.jobs, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
