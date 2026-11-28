import { clock, count, id, object, rows, seconds, SourceError, text, u32 } from "./http.ts";
import type { Reply, Row } from "./http.ts";

export type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
export const list = <T>(items: T[]): List<T> => items.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
export type Projected = { $: "Projected"; key: string; body: string };
export type Projection = Projected | { $: "Rejected" };
export type Page = { $: "Invalid" | "More" | "Exhausted" | "Split" | "Capped" };
export type Run = { run: string; attempt: number; head: string; created: number };
export type Read = (repo: string, endpoint: string) => Promise<Reply>;
type Bounds = { lo: number; hi: number };
type Link = { $: "Link"; number: string; base: string };
type Job = { id: string; name: string; status: string; conclusion: string; created: number; start: number; end: number };

export type Evidence = {
  identifier(id: string): boolean;
  valid_repo(repo: string): boolean;
  valid_scope(scope: string): boolean;
  safe_job_name(name: string): boolean;
  valid_run(run: string, attempt: number, head: string, created: number, lo: number, hi: number): boolean;
  finish(key: string, digest: string, body: string, observed: number): string;
  pull(repo: string, base: string, number: string, state: string, head: string, merge: string,
    opened: number, merged: number, updated: number): Projection;
  exact_attempt(run: string, actual: string, attempt: number, actualAttempt: number, head: string, actualHead: string): boolean;
  exact_job(id: string, run: string, actual: string, attempt: number, actualAttempt: number, head: string,
    actualHead: string, absentAttempt: boolean): boolean;
  terminal(status: string): boolean;
  pull_link(repo: string, links: List<Link>): string;
  attempt_key(run: string, attempt: number): string;
  attempt_record(repo: string, run: string, attempt: number, head: string, workflow: string, status: string, conclusion: string,
    pr: string, created: number, started: number, updated: number, earliest: number, latest: number, size: number, jobsComplete: boolean): Projected;
  job_start(created: number, started: number, assigned: boolean, status: string, conclusion: string, attempt: number): number;
  job_end(started: number, completed: number, status: string): number;
  job_record(repo: string, run: string, attempt: number, id: string, head: string, name: string, allowed: List<string>, status: string,
    conclusion: string, created: number, started: number, completed: number): Projected;
};

export type Progress = {
  ready(now: number, due: number): boolean;
  new_upper(now: number): number;
  live_floor(floor: number, checkpoint: number, upper: number, lookback: number): number;
  end_live(old: number, upper: number, gap: string): number;
  window(floor: number, upper: number): Bounds;
  older(floor: number, lower: number): Bounds;
  split(lo: number, hi: number): number;
  run_page(total: number, prior: number, page: number, size: number, next: boolean, lo: number, hi: number): Page;
  job_page(total: number, prior: number, page: number, size: number, next: boolean): Page;
  pull_page(page: number, history: boolean, next: boolean, lastUpdated: number, lo: number): Page;
  in_live(updated: number, lo: number, hi: number): boolean;
  pull_next(history: boolean, page: number): number;
  unique(ids: List<string>): boolean;
  next_attempt(attempt: number): number;
  retain(terminal: boolean, complete: boolean, observed: boolean): boolean;
  exhausted(lo: number, floor: number): boolean;
  resume_at(now: number, failureCount: number, hint: number): number;
  active_at(now: number): number;
  sweep_at(now: number): number;
  live_at(now: number): number;
  reason(status: number, limited: boolean): string;
  actionable(gap: string): boolean;
  outcome(blocked: string, gap: string, active: boolean, done: boolean, history: boolean): string;
  coverage(repo: string, lane: string, status: string, gap: string, lo: number, hi: number, remaining: number,
    page: number, pending: number, run: string, attempt: number): Projected;
  health(scope: string, history: boolean, status: string, gap: string, observed: number,
    success: number, newest: number, oldest: number): string;
  clock_min(old: number, value: number): number;
  clock_max(old: number, value: number): number;
  job_first(old: number, value: number): number;
  job_last(old: number, value: number): number;
};

export function mismatch(): never {
  throw new SourceError(0, false, 0, true);
}

export function decodeRun(row: Row): Run {
  return { run: id(row.id), attempt: u32(row.run_attempt), head: text(row.head_sha), created: seconds(row.created_at) };
}

export function checked<T extends Projection>(row: T): Extract<T, Projected> {
  if (row.$ === "Rejected") mismatch();
  return row as Extract<T, Projected>;
}

function exactJobs(row: Row, expected: Run, evidence: Evidence): Job {
  const jobId = id(row.id);
  if (!evidence.exact_job(jobId, expected.run, id(row.run_id), expected.attempt, u32(row.run_attempt), expected.head,
    text(row.head_sha), row.run_attempt === undefined)) mismatch();
  const status = text(row.status);
  const conclusion = text(row.conclusion);
  const created = clock(row.created_at);
  const start = evidence.job_start(created, clock(row.started_at), evidence.identifier(id(row.runner_id)), status, conclusion, expected.attempt);
  const end = evidence.job_end(start, clock(row.completed_at), status);
  return { id: jobId, name: text(row.name), status, conclusion, created, start, end };
}

async function jobInventory(read: Read, repo: string, path: string, run: Run, evidence: Evidence, progress: Progress) {
  let total = 0;
  const jobs: Job[] = [];
  for (let page = 1; ; page++) {
    const reply = await read(repo, path + "/jobs?per_page=100&page=" + page);
    const body = object(reply.data);
    const batch = rows(body.jobs).map(row => exactJobs(row, run, evidence));
    const reported = count(body.total_count);
    const decision = progress.job_page(reported, total, page, batch.length, Boolean(reply.next)).$;
    if (decision === "Invalid" || (reply.next && reply.next !== page + 1)) mismatch();
    jobs.push(...batch);
    total = reported;
    if (!progress.unique(list(jobs.map(job => job.id)))) mismatch();
    if (decision !== "More") return { jobs, total, complete: decision === "Exhausted" };
  }
}

function attemptMetadata(row: Row, expected: Run, evidence: Evidence) {
  if (!evidence.exact_attempt(expected.run, id(row.id), expected.attempt, u32(row.run_attempt), expected.head, text(row.head_sha))) mismatch();
  const links = row.pull_requests === undefined ? [] : rows(row.pull_requests);
  const pr = evidence.pull_link(id(object(row.repository ?? {}).id), list(links.map(link => ({
    $: "Link", number: id(link.number), base: id(object(object(link.base ?? {}).repo ?? {}).id),
  }))));
  return { workflow: id(row.workflow_id), status: text(row.status), conclusion: text(row.conclusion),
    pr, created: clock(row.created_at), started: clock(row.run_started_at), updated: clock(row.updated_at) };
}

export async function collectAttempt(read: Read, repo: string, run: Run, evidence: Evidence, progress: Progress, jobNames: List<string>) {
  const path = "actions/runs/" + run.run + "/attempts/" + run.attempt;
  const load = async () => attemptMetadata(object((await read(repo, path)).data), run, evidence);
  const metadata = await load();
  const { jobs, total, complete } = await jobInventory(read, repo, path, run, evidence, progress);
  const confirmed = await load();
  if (metadata.status !== confirmed.status || metadata.updated !== confirmed.updated ||
      metadata.conclusion !== confirmed.conclusion || metadata.created !== confirmed.created ||
      metadata.started !== confirmed.started || metadata.workflow !== confirmed.workflow || metadata.pr !== confirmed.pr) mismatch();
  const first = jobs.reduce((old, job) => progress.job_first(old, job.start), 0);
  const last = jobs.reduce((old, job) => progress.job_last(old, job.end), 0);
  const attempt = evidence.attempt_record(repo, run.run, run.attempt, run.head, metadata.workflow, metadata.status,
    metadata.conclusion, metadata.pr, metadata.created, metadata.started, metadata.updated, first, last, total, complete);
  const projected = jobs.map(job => evidence.job_record(repo, run.run, run.attempt, job.id, run.head, job.name, jobNames,
    job.status, job.conclusion, job.created, job.start, job.end));
  const terminal = evidence.terminal(metadata.status);
  const jobsTerminal = jobs.every(job => evidence.terminal(job.status));
  return { records: [attempt, ...projected], complete, terminal: terminal && jobsTerminal, inconsistent: terminal && !jobsTerminal };
}
