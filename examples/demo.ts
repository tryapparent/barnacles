import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvidence, type ActionAttempt, type PullRequest, type ReleaseEvidence } from "../evidence/index.ts";

const job = mkdtempSync("/tmp/apparent-dev-barnacles-demo-");
const repo = "synthetic/example";
const database = join(job, "evidence.sqlite");
const saveDelivery = (pullRequest: PullRequest, release?: ReleaseEvidence) =>
  loadEvidence(database, { source: "github-delivery", pullRequest, release });
const saveAttempt = (attempt: ActionAttempt) => loadEvidence(database, { source: "github-actions", attempt });
const dashboard = join(job, "grafana");
const run = (entry: string, ...args: string[]) =>
  execFileSync(process.execPath, [fileURLToPath(new URL("../" + entry, import.meta.url)), ...args],
    { stdio: "inherit" });

try {
  const sha = "a".repeat(40);
  const now = Math.floor(Date.now() / 1000);
  const week = 604800;
  const monday = now - ((now + 259200) % week);
  const iso = (time: number) => new Date(time * 1000).toISOString();
  for (const [number, published, cycle] of [[1, monday - week * 2 + 7200, 7000], [2, monday - week + 7200, 4000]]) {
    const opened = published - 1800;
    const merge = published - 600;
    saveDelivery({
      repository: repo, number, state: "merged", opened, merged: merge, mergeSha: sha,
      firstCommit: { sha, at: opened - 300 }, commitsComplete: true, firstCI: { id: number, at: opened + 60 },
      firstReview: null, reviewsComplete: true, updated: published,
    }, {
      id: number, tag: `linux-main-v2-${sha}`, source: sha, channel: "linux-main-x86_64", tagMatches: true,
      published, assetId: number, checked: published + 20, http: 206, bytes: 1, accessible: true,
      ancestry: "equal", shipped: true, dispatch: number === 2 ? { id: 3, at: merge + 120 } : null,
    });
    const snapshot = join(job, `thread-${number}.json`);
    writeFileSync(snapshot, JSON.stringify({
      instance: "demo", thread: { threadId: `thread-${number}`, createdAt: iso(published - cycle), updatedAt: iso(published),
        status: "completed", createdBy: "user", creationSource: "web", settled: true },
      recentRuns: [], links: { nextCursor: null, pullRequests: [{ host: "github.com", repository: repo,
        number, source: "created", state: "merged" }] },
    }));
    run("collector/import-sources.ts", job, "t3", snapshot);
  }
  const started = now - 3600;
  saveAttempt({
    repository: repo, sha, runId: 1, attempt: 1, workflowId: 1, status: "completed", conclusion: "success",
    createdAt: started, startedAt: started + 2, sourceUpdated: started + 90, observedAt: now,
    jobs: [{ id: 1, label: "Checks", status: "completed", conclusion: "success", created: started,
      priorExecution: false, queueEnd: started + 2, executionStart: started + 2, executionEnd: started + 90, steps: [] }],
  });
  const rollout = join(job, "demo.jsonl");
  const event = (offset: number, payload: object) => ({ timestamp: iso(started + offset), type: "response_item", payload });
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: "unlinked-demo-rollout" } },
    event(1, { type: "function_call", name: "exec_command", call_id: "call-1", arguments: '{"cmd":"git status"}' }),
    event(4, { type: "function_call_output", call_id: "call-1", output: "Synthetic tool response" }),
    event(6, { type: "reasoning" }),
    event(8, { type: "function_call", name: "exec_command", call_id: "call-2", arguments: '{"cmd":"git diff"}' }),
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  run("collector/import-sources.ts", job, "rollout", "demo", rollout);
  run("collector/import-sources.ts", job, "report");
  run("dashboard/prepare.ts", database, dashboard, repo);
  console.log(`Synthetic snapshot ready. Run dashboard/run.sh "${dashboard}" to open Grafana.`);
} catch (error) {
  console.error(`Demo failed. Synthetic input and diagnostics are in "${job}".`, error);
  process.exitCode = 1;
}
