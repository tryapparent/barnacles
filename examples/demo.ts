import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPolicies, loadPolicy } from "../tooling/bend.ts";
import { admissionPolicy, loadEvidence, type AdmissionPolicy, type ActionAttempt, type PullRequest, type ReleaseEvidence } from "../evidence/index.ts";

type Pull = {
  number: number; published: number; opened: number; merged: number; first_commit: number; first_ci: number;
  checked: number; thread_start: number; dispatch: number;
};
type Pulls = { $: "Nil" } | { $: "Con"; head: Pull; tail: Pulls };
type DemoPolicy = {
  fixtures(now: number): {
    repository: string; sha: string; pulls: Pulls; started: number; allocated: number; finished: number;
    call: number; result: number; reasoning: number; pending: number;
  };
};

const job = mkdtempSync("/tmp/apparent-dev-barnacles-demo-");
const database = join(job, "evidence.sqlite");
const dashboard = join(job, "grafana");
const run = (entry: string, ...args: string[]) =>
  execFileSync(process.execPath, [fileURLToPath(new URL("../" + entry, import.meta.url)), ...args],
    { stdio: "inherit" });

try {
  const [output, admissionFile] = await buildPolicies(job, [
    [new URL("./demo.bend", import.meta.url), "demo.mjs"],
    [admissionPolicy, "admission.mjs"],
  ]);
  const admission = await loadPolicy<AdmissionPolicy>(admissionFile);
  const saveDelivery = (pullRequest: PullRequest, release?: ReleaseEvidence) =>
    loadEvidence(database, { source: "github-delivery", pullRequest, release }, admission);
  const saveAttempt = (attempt: ActionAttempt) => loadEvidence(database, { source: "github-actions", attempt }, admission);
  const policy = await loadPolicy<DemoPolicy>(output);
  const now = Math.floor(Date.now() / 1000);
  const fixtures = policy.fixtures(now);
  const { repository: repo, sha, started, allocated, finished } = fixtures;
  const iso = (time: number) => new Date(time * 1000).toISOString();
  for (let row = fixtures.pulls; row.$ === "Con"; row = row.tail) {
    const { number, published, opened, merged, first_commit, first_ci, checked, thread_start, dispatch } = row.head;
    saveDelivery({
      repository: repo, number, state: "merged", opened, merged, mergeSha: sha,
      firstCommit: { sha, at: first_commit }, commitsComplete: true, firstCI: { id: number, at: first_ci },
      firstReview: null, reviewsComplete: true, updated: published,
    }, {
      id: number, tag: `linux-main-v2-${sha}`, source: sha, channel: "linux-main-x86_64", tagMatches: true,
      published, assetId: number, checked, http: 206, bytes: 1, accessible: true,
      ancestry: "equal", shipped: true, dispatch: dispatch ? { id: 3, at: dispatch } : null,
    });
    const snapshot = join(job, `thread-${number}.json`);
    writeFileSync(snapshot, JSON.stringify({
      instance: "demo", thread: { threadId: `thread-${number}`, createdAt: iso(thread_start), updatedAt: iso(published),
        status: "completed", createdBy: "user", creationSource: "web", settled: true },
      recentRuns: [], links: { nextCursor: null, pullRequests: [{ host: "github.com", repository: repo,
        number, source: "created", state: "merged" }] },
    }));
    run("collector/import-sources.ts", job, "t3", snapshot);
  }
  saveAttempt({
    repository: repo, sha, runId: 1, attempt: 1, workflowId: 1, status: "completed", conclusion: "success",
    createdAt: started, startedAt: allocated, sourceUpdated: finished, observedAt: now,
    jobs: [{ id: 1, label: "Checks", status: "completed", conclusion: "success", created: started,
      priorExecution: false, queueEnd: allocated, executionStart: allocated, executionEnd: finished, steps: [] }],
  });
  const rollout = join(job, "demo.jsonl");
  const event = (time: number, payload: object) => ({ timestamp: iso(time), type: "response_item", payload });
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: "unlinked-demo-rollout" } },
    event(fixtures.call, { type: "function_call", name: "exec_command", call_id: "call-1", arguments: '{"cmd":"git status"}' }),
    event(fixtures.result, { type: "function_call_output", call_id: "call-1", output: "Synthetic tool response" }),
    event(fixtures.reasoning, { type: "reasoning" }),
    event(fixtures.pending, { type: "function_call", name: "exec_command", call_id: "call-2", arguments: '{"cmd":"git diff"}' }),
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  run("collector/import-sources.ts", job, "rollout", "demo", rollout);
  run("collector/import-sources.ts", job, "report");
  run("dashboard/prepare.ts", database, dashboard, repo);
  console.log(`Synthetic snapshot ready. Run dashboard/run.sh "${dashboard}" to open Grafana.`);
} catch (error) {
  console.error(`Demo failed. Synthetic input and diagnostics are in "${job}".`, error);
  process.exitCode = 1;
}
