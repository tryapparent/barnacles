import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectAttempt } from "./attempts.ts";
import type { Evidence, List, Projected, Progress, Read, Run } from "./attempts.ts";
import { SourceError } from "./http.ts";
import { begin, cursor, pullPage, runPage, startPage } from "./inventory.ts";
import type { Cursor } from "./inventory.ts";
import { atomic, digest, publishEvidence } from "./store.ts";

export const lanes = ["pulls_live", "actions_live", "pulls_backfill", "actions_backfill", "attempts"] as const;
type Lane = typeof lanes[number];
type Inventory = Exclude<Lane, "attempts">;
type Action = "actions_live" | "actions_backfill";
type Pending = { run: Run; lanes: Action[]; due: number; failures: number; gap: string };
type Repository = { cursors: Record<Inventory, Cursor>; pending: Record<string, Pending> };
export type State = { version: number; floor: number; turn: number; throttle: number; repositories: Record<string, Repository> };
export type Target = { repository: string; scope: string };
const history = (lane: Inventory) => lane.endsWith("_backfill");
const actions = (lane: Inventory): lane is Action => lane.startsWith("actions_");

export function initial(floor: number): State {
  return { version: 1, floor, turn: 0, throttle: 0, repositories: {} };
}

export function emptyRepo(): Repository {
  return { cursors: { pulls_live: cursor(), actions_live: cursor(), pulls_backfill: cursor(), actions_backfill: cursor() }, pending: {} };
}

export type Context = { read: Read; evidence: Evidence; progress: Progress; repo: string; state: Repository;
  now: number; floor: number; jobNames: List<string>; receipts: string; records: Projected[]; confirmed: string[] };

function laneOutcome(context: Context, lane: Inventory) {
  const current = context.state.cursors[lane];
  const jobs = Object.values(context.state.pending).filter(entry => entry.lanes.some(source => source === lane));
  const pendingGap = jobs.find(job => job.gap)?.gap ?? "";
  const blocked = current.blocked || pendingGap;
  const active = Boolean(current.hi);
  return { status: context.progress.outcome(blocked, current.gap, active || jobs.length > 0, current.done, history(lane)),
    gap: blocked || current.gap, pending: jobs.length };
}

function coverage(context: Context, lane: Inventory, snapshot: Cursor, run?: Run, status?: string, gap?: string) {
  const result = laneOutcome(context, lane);
  const current = context.state.cursors[lane];
  context.records.push(context.progress.coverage(context.repo, lane, status ?? result.status, gap ?? result.gap,
    actions(lane) ? snapshot.lo : 0, actions(lane) ? snapshot.hi : 0, actions(lane) ? current.hi : 0,
    snapshot.page, result.pending, run?.run ?? "", run?.attempt ?? 0));
}

function success(context: Context, lane: Inventory, current: Cursor) {
  context.state.cursors[lane] = { ...current, success: context.now, blocked: "", failures: 0, due: 0 };
}

async function pullStep(context: Context, lane: Inventory, current: Cursor) {
  const { progress, repo, now } = context;
  const backfill = history(lane);
  const result = await pullPage(context.read, repo, current, backfill, context.evidence, progress);
  context.records.push(...result.projected);
  success(context, lane, { ...current, page: result.page,
    newest: progress.clock_max(current.newest, result.newest), oldest: progress.clock_min(current.oldest, result.oldest) });
  const next = context.state.cursors[lane];
  if (result.decision === "More") {
    next.page = progress.pull_next(backfill, result.page);
    next.signature = result.signature;
  } else if (result.decision === "Capped") {
    Object.assign(next, startPage(), { blocked: "capped", due: progress.sweep_at(now) });
  } else {
    Object.assign(next, startPage(), { hi: 0, done: true, due: progress.live_at(now),
      watermark: progress.end_live(next.watermark, current.hi, "") });
  }
  coverage(context, lane, { ...current, page: result.page });
}

function olderWindow(context: Context, lane: Action, current: Cursor) {
  const { progress, now } = context;
  const next = context.state.cursors[lane];
  if (progress.exhausted(current.lo, current.floor)) {
    Object.assign(next, startPage(), { hi: 0, done: true, due: history(lane) || next.gap ? progress.sweep_at(now) : progress.live_at(now),
      watermark: progress.end_live(current.watermark, current.scanUpper, next.gap) });
  } else {
    Object.assign(next, startPage(), progress.older(current.floor, current.lo));
  }
}

async function actionPage(context: Context, lane: Action, current: Cursor) {
  const { read, repo, progress, evidence } = context;
  if (current.lastPage) {
    current.oldest = progress.clock_min(current.oldest, current.lo);
    olderWindow(context, lane, current);
    coverage(context, lane, current, undefined, "window_exhausted");
    coverage(context, lane, current);
    return;
  }
  const result = await runPage(read, repo, current, evidence, progress);
  success(context, lane, current);
  const next = context.state.cursors[lane];
  if (result.decision === "Split") {
    Object.assign(next, startPage(), { lo: progress.split(current.lo, current.hi) });
    coverage(context, lane, current, undefined, "window_split");
    return;
  }
  if (result.decision === "Capped") {
    next.gap = "capped";
    olderWindow(context, lane, current);
    coverage(context, lane, current, undefined, "capped", "capped");
    coverage(context, lane, current);
    return;
  }
  next.queue = result.runs;
  next.lastPage = result.decision === "Exhausted";
  next.seen = [...current.seen, ...result.ids];
  next.signature = result.signature;
  next.total = result.total;
  next.page = next.lastPage ? current.page : progress.pull_next(false, current.page);
  for (const run of result.runs) next.newest = progress.clock_max(next.newest, run.created);
  coverage(context, lane, current, undefined, "page_staged");
}

async function attemptStep(context: Context, run: Run, requested?: Action) {
  const { progress, evidence, repo, now, state } = context;
  const key = evidence.attempt_key(run.run, run.attempt);
  const receipt = join(context.receipts, digest(repo + ":" + key + ":" + run.head));
  if (existsSync(receipt)) {
    if (state.pending[key]) {
      const associated = state.pending[key].lanes;
      delete state.pending[key];
      for (const lane of associated) coverage(context, lane, state.cursors[lane], run);
    }
    return;
  }
  const previous = state.pending[key];
  const sources = [...new Set([...(previous?.lanes ?? []), ...(requested ? [requested] : [])])];
  if (previous && !progress.ready(now, previous.due)) {
    previous.lanes = sources;
    return;
  }
  try {
    const result = await collectAttempt(context.read, repo, run, evidence, progress, context.jobNames);
    context.records.push(...result.records);
    for (const origin of sources) state.cursors[origin].success = now;
    if (!progress.retain(result.terminal, result.complete, true)) {
      delete state.pending[key];
      context.confirmed.push(receipt);
    } else {
      const gap = result.inconsistent ? "inventory_changed" : result.complete ? "" : "capped";
      state.pending[key] = { run, lanes: sources, due: result.complete ? progress.active_at(now) : progress.sweep_at(now), failures: 0, gap };
    }
  } catch (error) {
    if (!(error instanceof SourceError) || error.limited) throw error;
    const failures = (previous?.failures ?? 0) + 1;
    state.pending[key] = { run, lanes: sources, failures, due: progress.resume_at(now, failures, error.retryAt),
      gap: error.invalid ? "inventory_changed" : progress.reason(error.status, error.limited) };
  }
  for (const lane of sources) coverage(context, lane, state.cursors[lane], run);
}

export async function step(context: Context, lane: Lane) {
  const { state, progress, now } = context;
  if (lane === "attempts") {
    let next: Pending | undefined;
    for (const pending of Object.values(state.pending)) {
      if (!next || pending.due < next.due) next = pending;
    }
    if (!next || !progress.ready(now, next.due)) return false;
    try {
      await attemptStep(context, next.run);
      return true;
    }
    catch (error) {
      if (error instanceof SourceError) {
        next.due = progress.resume_at(now, next.failures, error.retryAt);
        next.gap = progress.reason(error.status, error.limited);
        for (const origin of next.lanes) coverage(context, origin, state.cursors[origin], next.run);
      }
      throw error;
    }
  }
  const current = state.cursors[lane];
  if (!progress.ready(now, current.due) || (lane === "pulls_backfill" && current.done)) return false;
  if (!current.hi) {
    state.cursors[lane] = begin(current, progress, actions(lane) ? context.floor : 1, now, history(lane), actions(lane) ? 86400 : 120);
  }
  const next = state.cursors[lane];
  if (!actions(lane)) {
    await pullStep(context, lane, next);
  } else if (next.queue.length) {
    const task = next.queue[0];
    await attemptStep(context, task, lane);
    const earlier = progress.next_attempt(task.attempt);
    next.queue = earlier ? [{ ...task, attempt: earlier }, ...next.queue.slice(1)] : next.queue.slice(1);
    next.blocked = "";
    next.failures = 0;
  } else {
    await actionPage(context, lane, next);
  }
  return true;
}

export function errorResult(context: Context, lane: Lane, error: SourceError) {
  const gap = error.invalid ? "inventory_changed" : context.progress.reason(error.status, error.limited);
  if (lane === "attempts") return;
  const affected = [lane];
  for (const key of affected) {
    const current = context.state.cursors[key];
    current.blocked = gap;
    current.failures++;
    current.due = context.progress.resume_at(context.now, current.failures, error.retryAt);
    if (error.invalid) Object.assign(current, startPage());
    coverage(context, key, current);
  }
}

export function stage(context: Context, spool: Parameters<typeof publishEvidence>[0], observed: number) {
  const variants = new Map<string, () => string>();
  for (const record of context.records) {
    const revision = digest(record.body);
    const key = digest(record.key + ":" + revision);
    variants.set(key, () => context.evidence.finish(record.key, revision, record.body, observed));
  }
  publishEvidence(spool, variants);
  for (const receipt of context.confirmed) atomic(receipt, "terminal\n", true);
}

export function healthLines(context: Context, target: Target, observed: number, transportGap: string) {
  return [false, true].map(backfill => {
    const keys = backfill ? ["pulls_backfill", "actions_backfill"] as const : ["pulls_live", "actions_live"] as const;
    const [pull, action] = keys.map(key => laneOutcome(context, key));
    const { progress, state } = context;
    const gap = transportGap || pull.gap || action.gap;
    const blocked = transportGap || pull.status === "retrying" || pull.status === "blocked" ||
      action.status === "retrying" || action.status === "blocked";
    const watermark = keys.map(key => state.cursors[key]);
    const status = progress.outcome(blocked ? gap : "", gap, pull.status === "working" || action.status === "working",
      pull.status === "complete" && action.status === "complete", backfill);
    return progress.health(target.scope, backfill, status, gap, observed,
      progress.clock_max(watermark[0].success, watermark[1].success),
      progress.clock_max(watermark[0].newest, watermark[1].newest),
      progress.clock_min(watermark[0].oldest, watermark[1].oldest));
  });
}
