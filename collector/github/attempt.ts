// Exact-attempt collection and clock semantics adapted from Apparent. See ../APPARENT-LICENSE.
import { execFileSync } from "node:child_process";

import type { ActionAttempt, AttemptIdentity } from "../../evidence/actions.ts";
type Json = Record<string, unknown>;
type Clock = {
  queue_known: (created: number, started: number, completed: number, allocation: number) => number;
  execution_known: Clock["queue_known"];
  has_prior_execution: (created: number, started: number) => boolean;
  step_known: (start: number, end: number, jobStart: number, jobEnd: number) => number;
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

function text(value: unknown, allowed: readonly string[], fallback = "unknown"): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function clock(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return 0;
  const seconds = Date.parse(value) / 1000;
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 0xffffffff ? seconds : 0;
}

function readGitHub(path: string): unknown {
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

const statuses = ["completed", "queued", "pending", "waiting", "in_progress", "requested"];
const conclusions = ["success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required",
  "startup_failure", "stale"];
const pending = ["queued", "pending", "waiting", "requested"];

// Deliberately retain only known static display labels. Run-step names can contain shell code.
const jobLabels = ["admit", "macos / frontend", "macos / Build signed Mac candidate",
  "linux / Build x86_64 AppImage", "linux / cli", "publish-linux", "publish-nightly"];
const stepLabels = ["Set up job", "Assemble signed notarized candidate", "Validate candidate installation",
  "Sign Sparkle bytes and seal candidate", "Complete job"];

function normalizeJob(job: Json, policy: Clock) {
  const id = positiveInt(job.id);
  const created = clock(job.created_at);
  const started = clock(job.started_at);
  const completed = clock(job.completed_at);
  const status = text(job.status, statuses);
  const conclusion = text(job.conclusion, conclusions);
  const allocation = pending.includes(status) || conclusion === "skipped" ? 0
    : typeof job.runner_id === "number" && job.runner_id > 0 ? 1
    : job.runner_id === 0 && status === "completed" && conclusion === "cancelled" ? 2
    : 0;
  const queueEnd = policy.queue_known(created, started, completed, allocation)
    ? (allocation === 1 ? started : completed) : null;
  const executionEnd = status === "completed" && policy.execution_known(created, started, completed, allocation)
    ? completed : null;
  if (!Array.isArray(job.steps)) throw new Error("Missing GitHub job steps array");
  const seen = new Set<number>();
  const steps = job.steps.map((item) => {
    const step = object(item);
    const number = positiveInt(step.number);
    if (seen.has(number)) throw new Error("Duplicate GitHub step number");
    seen.add(number);
    const start = clock(step.started_at);
    const end = clock(step.completed_at);
    const status = text(step.status, statuses);
    const conclusion = text(step.conclusion, conclusions);
    const known = executionEnd !== null && conclusion !== "skipped" &&
      status === "completed" && policy.step_known(start, end, started, executionEnd) !== 0;
    return { number, label: text(step.name, stepLabels, "Other steps"), status, conclusion,
      start: known ? start : null, end: known ? end : null };
  });
  return {
    id, label: text(job.name, jobLabels, "Other jobs"), status, conclusion, created: created || null,
    priorExecution: policy.has_prior_execution(created, started), queueEnd, executionStart: executionEnd === null ? null : started, executionEnd, steps,
  };
}

export function collectAttempt(identity: AttemptIdentity, policy: Clock, read = readGitHub): ActionAttempt {
  const { repository, runId, attempt, sha } = identity;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..") ||
      !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected owner/repository and full lowercase commit SHA");
  positiveInt(runId);
  positiveInt(attempt);
  const path = `repos/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const run = object(read(path));
  if (run.id !== runId || run.run_attempt !== attempt || run.head_sha !== sha) {
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
      if (job.run_id !== runId || job.head_sha !== sha ||
          (job.run_attempt !== undefined && job.run_attempt !== attempt)) {
        throw new Error("GitHub job identity does not match the attempt");
      }
      const normalized = normalizeJob(job, policy);
      if (jobs.has(normalized.id)) throw new Error("Duplicate GitHub job ID");
      jobs.set(normalized.id, normalized);
    }
    if (jobs.size === total) {
      return {
        ...identity, workflowId: positiveInt(run.workflow_id), status: text(run.status, statuses),
        conclusion: text(run.conclusion, conclusions), createdAt: clock(run.created_at) || null,
        startedAt: clock(run.run_started_at) || null, sourceUpdated: clock(run.updated_at),
        observedAt: Math.floor(Date.now() / 1000), jobs: [...jobs.values()],
      };
    }
    if (jobs.size > total || response.jobs.length === 0) break;
  }
  throw new Error("Partial GitHub job inventory. No evidence was written.");
}
