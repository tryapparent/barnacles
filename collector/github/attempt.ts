// Exact-attempt collection and clock semantics adapted from Apparent. See ../APPARENT-LICENSE.
import { execFileSync } from "node:child_process";

import type { ActionAttempt, AttemptIdentity } from "../../evidence/index.ts";
type Json = Record<string, unknown>;
type MatchIdentity = (run: string, attempt: string, sha: string,
  expectedRun: string, expectedAttempt: string, expectedSha: string) => boolean;
export type ClockPolicy = {
  attempt_matches: MatchIdentity;
  job_matches: (...args: [...Parameters<MatchIdentity>, missingAttempt: boolean]) => boolean;
  job_clocks: (created: number, started: number, completed: number, status: string,
    conclusion: string, assigned: boolean, zeroRunner: boolean) => {
      queue_end: number; execution_end: number; prior_execution: boolean;
    };
  step_known: (start: number, end: number, jobStart: number, jobEnd: number,
    status: string, conclusion: string) => boolean;
  source_status: (value: string) => string;
  source_conclusion: (value: string) => string;
  job_label: (value: string) => string;
  step_label: (value: string) => string;
};

export function positiveInt(value: unknown): number {
  const number = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
    throw new Error("Expected a positive integer source ID");
  }
  return number;
}

function object(value: unknown): Json {
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

function clock(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return 0;
  const seconds = Date.parse(value) / 1000;
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 0xffffffff ? seconds : 0;
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

function normalizeJob(job: Json, policy: ClockPolicy) {
  const id = positiveInt(job.id);
  const created = clock(job.created_at);
  const started = clock(job.started_at);
  const completed = clock(job.completed_at);
  const status = policy.source_status(wireText(job.status));
  const conclusion = policy.source_conclusion(wireText(job.conclusion));
  const { queue_end, execution_end, prior_execution } = policy.job_clocks(
    created, started, completed, status, conclusion,
    typeof job.runner_id === "number" && job.runner_id > 0, job.runner_id === 0,
  );
  if (!Array.isArray(job.steps)) throw new Error("Missing GitHub job steps array");
  const seen = new Set<number>();
  const steps = job.steps.map((item) => {
    const step = object(item);
    const number = positiveInt(step.number);
    if (seen.has(number)) throw new Error("Duplicate GitHub step number");
    seen.add(number);
    const start = clock(step.started_at);
    const end = clock(step.completed_at);
    const status = policy.source_status(wireText(step.status));
    const conclusion = policy.source_conclusion(wireText(step.conclusion));
    const known = policy.step_known(start, end, started, execution_end, status, conclusion);
    return { number, label: policy.step_label(wireText(step.name)), status, conclusion,
      start: known ? start : null, end: known ? end : null };
  });
  return {
    id, label: policy.job_label(wireText(job.name)), status, conclusion, created: created || null,
    priorExecution: prior_execution, queueEnd: queue_end || null,
    executionStart: execution_end ? started : null, executionEnd: execution_end || null, steps,
  };
}

export function collectAttempt(identity: AttemptIdentity, policy: ClockPolicy, read = readGitHub): ActionAttempt {
  const { repository, runId, attempt, sha } = identity;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..") ||
      !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected owner/repository and full lowercase commit SHA");
  positiveInt(runId);
  positiveInt(attempt);
  const path = `repos/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const run = object(read(path));
  const expected = [String(runId), String(attempt), sha] as const;
  if (!policy.attempt_matches(wireId(run.id), wireId(run.run_attempt), wireText(run.head_sha), ...expected)) {
    throw new Error("GitHub attempt identity does not match the request");
  }
  const jobs = new Map<number, ReturnType<typeof normalizeJob>>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = object(read(`${path}/jobs?per_page=100&page=${page}`));
    const count = response.total_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
        (total !== undefined && count !== total) || !Array.isArray(response.jobs) || response.jobs.length > 100) {
      throw new Error("Invalid or changing GitHub job inventory");
    }
    total = count;
    for (const item of response.jobs) {
      const job = object(item);
      if (!policy.job_matches(
        wireId(job.run_id), wireId(job.run_attempt), wireText(job.head_sha), ...expected,
        job.run_attempt === undefined,
      )) {
        throw new Error("GitHub job identity does not match the attempt");
      }
      const normalized = normalizeJob(job, policy);
      if (jobs.has(normalized.id)) throw new Error("Duplicate GitHub job ID");
      jobs.set(normalized.id, normalized);
    }
    if (jobs.size === total) {
      return {
        ...identity, workflowId: positiveInt(run.workflow_id), status: policy.source_status(wireText(run.status)),
        conclusion: policy.source_conclusion(wireText(run.conclusion)), createdAt: clock(run.created_at) || null,
        startedAt: clock(run.run_started_at) || null, sourceUpdated: clock(run.updated_at),
        observedAt: Math.floor(Date.now() / 1000), jobs: [...jobs.values()],
      };
    }
    if (jobs.size > total || response.jobs.length === 0) break;
  }
  throw new Error("Partial GitHub job inventory. No evidence was written.");
}
