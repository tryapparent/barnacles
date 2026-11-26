// Exact-attempt collection and clock semantics adapted from Apparent. See ../APPARENT-LICENSE.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { ActionAttempt, AttemptIdentity } from "../../evidence/index.ts";
type Json = Record<string, unknown>;
type MatchIdentity = (run: string, attempt: string, sha: string,
  expectedRun: string, expectedAttempt: string, expectedSha: string) => boolean;
export type ClockPolicy = {
  attempt_matches: MatchIdentity;
  job_matches: (...args: [...Parameters<MatchIdentity>, missingAttempt: boolean]) => boolean;
  job_clocks: (created: number, started: number, completed: number, status: string,
    conclusion: string, assigned: boolean, zeroRunner: boolean, firstAttempt: boolean) => {
      queue_end: number; execution_end: number; prior_execution: boolean;
    };
  step_known: (start: number, end: number, jobStart: number, jobEnd: number,
    status: string, conclusion: string) => boolean;
  source_status: (value: string) => string;
  source_conclusion: (value: string) => string;
  job_label: (value: string) => string;
  step_label: (job: string, value: string) => string;
  page_matches: (total: number, offset: number, length: number) => boolean;
  same_count: (left: number, right: number) => boolean;
  stable_attempt: (metadata: string, confirmedMetadata: string, jobs: string, confirmedJobs: string) => boolean;
  attempt_start: (firstAttempt: boolean, jobs: number, started: number) => number;
  window_valid: (start: number, end: number, pages: number, limit: number) => boolean;
  in_window: (created: number, start: number, end: number) => boolean;
  select_run: (position: number, limit: number) => boolean;
  discoverable_count: (total: number) => number;
  inventory_complete: (eligible: number, total: number) => boolean;
};

export function positiveInt(value: unknown): number {
  const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("Expected a positive integer source ID");
  }
  return number;
}

export function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub response object");
  }
  return value as Json;
}

function wireText(value: unknown): string {
  return typeof value === "string" && value.length <= 128 ? value : "";
}

function wireId(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

export function clock(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return 0;
  const seconds = Date.parse(value) / 1000;
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 0xffffffff &&
    new Date(seconds * 1000).toISOString() === value.replace("Z", ".000Z") ? seconds : 0;
}

export function readGitHub(path: string): unknown {
  try {
    return JSON.parse(execFileSync("gh", ["api", "--method", "GET", "--hostname", "github.com", path], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    throw new Error("GitHub read failed. Check authentication, read access, and API limits.");
  }
}

export function wireCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("Invalid GitHub inventory count");
  }
  return value;
}

export function checkRepository(repository: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Expected owner/repository");
  }
}

export function fullSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("Expected full lowercase commit SHA");
  }
  return value;
}

function normalizeJob(job: Json, firstAttempt: boolean, policy: ClockPolicy) {
  const id = positiveInt(job.id);
  const created = clock(job.created_at);
  const started = clock(job.started_at);
  const completed = clock(job.completed_at);
  const status = policy.source_status(wireText(job.status));
  const conclusion = policy.source_conclusion(wireText(job.conclusion));
  const { queue_end, execution_end, prior_execution } = policy.job_clocks(
    created, started, completed, status, conclusion,
    typeof job.runner_id === "number" && job.runner_id > 0, job.runner_id === 0, firstAttempt,
  );
  if (!Array.isArray(job.steps)) throw new Error("Missing GitHub job steps array");
  const label = policy.job_label(wireText(job.name));
  const steps = job.steps.map((item) => {
    const step = object(item);
    const number = positiveInt(step.number);
    const start = clock(step.started_at);
    const end = clock(step.completed_at);
    const status = policy.source_status(wireText(step.status));
    const conclusion = policy.source_conclusion(wireText(step.conclusion));
    const known = policy.step_known(start, end, started, execution_end, status, conclusion);
    return { number, label: policy.step_label(label, wireText(step.name)), status, conclusion,
      start: known ? start : null, end: known ? end : null };
  });
  if (!policy.same_count(steps.length, new Set(steps.map((step) => step.number)).size)) {
    throw new Error("Duplicate GitHub step number");
  }
  return {
    id, label, status, conclusion, created: created || null,
    priorExecution: prior_execution, queueEnd: queue_end || null,
    executionStart: execution_end ? started : null, executionEnd: execution_end || null, steps,
  };
}

function snapshotDigest(value: unknown): string {
  const json = JSON.stringify(value, (_, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Json)[key]]))
      : item);
  return createHash("sha256").update(json).digest("hex");
}

function inventoryDigest(jobs: Map<number, Json>): string {
  return snapshotDigest([...jobs.entries()].sort(([left], [right]) => left - right));
}

function readJobs(path: string, policy: ClockPolicy, read: typeof readGitHub) {
  const jobs = new Map<number, Json>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = object(read(`${path}/jobs?per_page=100&page=${page}`));
    const count = wireCount(response.total_count);
    total ??= count;
    const offset = (page - 1) * 100;
    if (!Array.isArray(response.jobs) || !policy.same_count(count, total) ||
        !policy.page_matches(total, offset, response.jobs.length)) {
      throw new Error("Partial or changing GitHub job inventory. No evidence was written.");
    }
    for (const item of response.jobs) {
      const job = object(item);
      jobs.set(positiveInt(job.id), job);
    }
    if (!policy.same_count(offset + response.jobs.length, jobs.size)) {
      throw new Error("Duplicate GitHub job ID");
    }
    if (policy.same_count(jobs.size, total)) return jobs;
  }
  throw new Error("Partial GitHub job inventory. No evidence was written.");
}

export function collectAttempt(identity: AttemptIdentity, policy: ClockPolicy, read = readGitHub): ActionAttempt {
  const { repository, runId, attempt, sha } = identity;
  checkRepository(repository);
  fullSha(sha);
  positiveInt(runId);
  positiveInt(attempt);
  const path = `repos/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const expected = [String(runId), String(attempt), sha] as const;
  function readAttempt() {
    const run = object(read(path));
    if (!policy.attempt_matches(wireId(run.id), wireId(run.run_attempt), wireText(run.head_sha), ...expected)) {
      throw new Error("GitHub attempt identity does not match the request");
    }
    return {
      workflowId: positiveInt(run.workflow_id),
      status: policy.source_status(wireText(run.status)),
      conclusion: policy.source_conclusion(wireText(run.conclusion)),
      created: clock(run.created_at), started: clock(run.run_started_at), sourceUpdated: clock(run.updated_at),
    };
  }
  const run = readAttempt();
  const inventory = readJobs(path, policy, read);
  const jobs = [...inventory.values()].map((job) => {
    if (!policy.job_matches(
      wireId(job.run_id), wireId(job.run_attempt), wireText(job.head_sha), ...expected,
      job.run_attempt === undefined,
    )) {
      throw new Error("GitHub job identity does not match the attempt");
    }
    return normalizeJob(job, attempt === 1, policy);
  });
  const confirmation = readJobs(path, policy, read);
  if (!policy.stable_attempt(snapshotDigest(run), snapshotDigest(readAttempt()),
    inventoryDigest(inventory), inventoryDigest(confirmation))) {
    throw new Error("Changing GitHub attempt or job inventory. No evidence was written.");
  }
  return {
    ...identity, workflowId: run.workflowId, status: run.status, conclusion: run.conclusion,
    createdAt: run.created || null, startedAt: policy.attempt_start(attempt === 1, jobs.length, run.started) || null,
    sourceUpdated: run.sourceUpdated, observedAt: Math.floor(Date.now() / 1000), jobs,
  };
}

export function collectWindow(repository: string, from: string, to: string, maxPages: number, maxAttempts: number,
  policy: ClockPolicy, read = readGitHub) {
  checkRepository(repository);
  const start = clock(from);
  const end = clock(to);
  if (!policy.window_valid(start, end, wireCount(maxPages), wireCount(maxAttempts))) {
    throw new Error("Expected an ordered UTC seconds window, 1–10 pages and 1–20 attempts");
  }
  const inventory = new Map<number, AttemptIdentity>();
  let reportedTotal = 0;
  let pagesRead = 0;
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ created: `${from}..${to}`, per_page: "100", page: String(page) });
    const response = object(read(`repos/${repository}/actions/runs?${query}`));
    const count = wireCount(response.total_count);
    if (page === 1) reportedTotal = count;
    const offset = (page - 1) * 100;
    if (!Array.isArray(response.workflow_runs) || !policy.same_count(count, reportedTotal) ||
        !policy.page_matches(policy.discoverable_count(reportedTotal), offset, response.workflow_runs.length)) {
      throw new Error("Partial or changing GitHub run inventory. No evidence was written.");
    }
    for (const item of response.workflow_runs) {
      const run = object(item);
      if (!policy.in_window(clock(run.created_at), start, end)) {
        throw new Error("GitHub run creation time is outside the requested inventory window");
      }
      const runId = positiveInt(run.id);
      inventory.set(runId, { repository, runId, attempt: positiveInt(run.run_attempt), sha: fullSha(run.head_sha) });
    }
    if (!policy.same_count(offset + response.workflow_runs.length, inventory.size)) {
      throw new Error("Duplicate GitHub workflow run ID in the window inventory");
    }
    pagesRead = page;
    if (policy.same_count(inventory.size, policy.discoverable_count(reportedTotal))) break;
  }
  const attempts = [...inventory.values()].filter((_, index) => policy.select_run(index, maxAttempts))
    .map((identity) => collectAttempt(identity, policy, read));
  return {
    attempts,
    coverage: {
      from, to, maxPages, maxAttempts, pagesRead, reportedTotal,
      eligible: inventory.size, captured: attempts.length,
      inventoryComplete: policy.inventory_complete(inventory.size, reportedTotal),
    },
  };
}
