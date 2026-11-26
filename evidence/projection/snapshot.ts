import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { repository } from "../repository.ts";
import { buildPolicies, buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { deliveryPolicy, readDelivery, type DeliveryPolicy } from "../delivery/delivery.ts";
import type { AttemptIdentity } from "../storage/actions.ts";
import type { List } from "../storage/sources.ts";
import { collectTiming, millis, rows, seconds, type Stats, type TimingPolicy } from "./timing.ts";
import { writeTraces, type OtlpPolicy, type TracePolicy, type TraceWriter } from "./trace.ts";

type Shipping = { $: "Delivery"; shipped: number; cycles: Stats };
type CycleStage = { $: "Measured"; ms: number } | { $: "Missing" };
type ActionWaitWindow = { start: number; end: number };
type WaitWindow = ActionWaitWindow & { $: "Window" };
type WaitClock = { $: "Interval"; start: number; end: number; observed: boolean };
type WaitIdentity = { $: "Identity"; repository: string; run_id: number; head_sha: string; attempt: number };
type WaitImport = { $: "AttemptRow" }
  | { $: "JobRow"; job: { $: "Job"; job_id: number; label: string; execution: WaitClock; queue: WaitClock } }
  | { $: "StepRow"; step: { $: "Step"; job_id: number; number: number; label: string; execution: WaitClock } };
type WaitDurations = { execution_ms: CycleStage; only_known_running_ms: CycleStage; queue_ms: CycleStage };
type WaitAttribution = {
  coverage: {
    wait_count: number; exact_wait_count: number; matched_wait_count: number; matched_attempts: number;
    unmatched_attempts: number; jobless_attempts: number; matched_wait_ms: number; running_ms: number;
    queue_only_ms: number; unknown_job_ms: number;
  };
  jobs: List<{ rank: number; summary: WaitDurations & { job_label: string; job_count: number } }>;
  instances: List<WaitDurations & { identity: WaitIdentity; job_id: number; job_label: string }>;
  steps: List<{ run_id: number; attempt: number; job_id: number; step_number: number; step_label: string; execution_ms: CycleStage }>;
};
type WaitPolicy = {
  report_window(cutoffMs: number): WaitWindow;
  start_report(window: WaitWindow, repository: string): unknown;
  observe_wait(inputs: unknown, identity: WaitIdentity, exact: boolean, interval: WaitClock): unknown;
  observe_import(inputs: unknown, identity: WaitIdentity, fact: WaitImport): unknown;
  finish_report(inputs: unknown): WaitAttribution;
  capture_plan(inputs: unknown, limit: number): { missing: number; attempts: List<WaitIdentity> };
};
type Estimator = {
  empty_model(): unknown;
  model_receipt(model: unknown, instance: string, session: string, files: number, git: number, builds: number, pushes: number, seconds: number): unknown;
  model_estimates(model: unknown): List<{ name: string; supported: boolean; seconds: number; error: number;
    total: number; samples: number }>;
};
type ReviewFact = {
  $: "ReviewPR"; pr: number; release: boolean; thread: number; commit: number; opened: number; ci: number;
  merged: number; dispatch: number; publication: number; access: number; linked: boolean; cycle_ms: number;
};
type ReviewItem = { $: "Item"; pr: number; order: number; changed: number; stage: string;
  milestones: List<{ key: string; phase: string; observed: number; elapsed: CycleStage }> };
type ReviewWindow = { $: "ReviewRange"; from: number; to: number; fleet_from: number } | { $: "InvalidRange" };
type MapTile = { index: number; millis: number; grouped: number; children: List<MapTile> };
type MapEntry = {
  label: string; totalSeconds: number; index: number; grouped: number; children: MapEntry[];
};
type ReviewPolicy = {
  review_fact(pr: number, release: boolean, thread: number, commit: number, opened: number, ci: number,
    merged: number, dispatch: number, publication: number, access: number, linked: boolean, cycle: number): ReviewFact;
  review_prefer(prior: boolean, candidate: boolean): boolean;
  review_window(snapshot: number, from: number, to: number, hasFrom: boolean, hasTo: boolean): ReviewWindow;
  review_page_valid(limit: number, offset: number): boolean;
  review_clock_options(): List<string>;
  review_timing_window(): string;
  review_count_facts(facts: List<ReviewFact>): number;
  review_clock_valid(clock: string): boolean;
  review_operation_map?(weights: List<number>): List<MapTile>;
  review_operation_matches(selection: string, all: boolean, name: string): boolean;
  review_item(fact: ReviewFact, asOf: number): ReviewItem;
  review_report(facts: List<ReviewFact>, from: number, to: number, fleetFrom: number, limit: number, offset: number): {
    $: "ReviewReport"; total: number; next_offset: number; max_measured_ms: number; deliveries: List<ReviewItem>;
    fleet: List<ReviewItem>; verified: Shipping;
    weeks: List<{ start: number; sample: Shipping }>;
    days?: List<{ start: number; shipped: number; stages: List<{ phase: string; sample: Stats }> }>;
  };
  mean: TimingPolicy["mean"];
};
type Metrics = TimingPolicy & ReviewPolicy & {
  empty_shipping_report(): unknown;
  shipping_observe(report: unknown, channel: string, published: number, clocks: ReleaseClocks,
    linked: boolean, elapsed: number): { $: "Unpublished"; report: unknown } |
      { $: "Published"; report: unknown; milestones: List<Milestone> };
  shipping_result(report: unknown, cutoff: number): ShippingSummary;
  visible_open(owning: boolean, state: string, settled: boolean): boolean;
};

type ReleaseClocks = { $: "ReleaseClocks"; thread: number; commit: number; opened: number; ci: number;
  merged: number; dispatch: number; published: number; checked: number };
type Milestone = { ordinal: number; name: string; clock: number; elapsed: CycleStage };
type ShippingSummary = {
  delivery: Shipping; weeks: List<{ week: number; summary: Shipping }>; stages: List<{ name: string; stats: Stats }>;
  from: number; prior_week: number; recent_week: number; prior: Stats; recent: Stats;
  direction: { $: "Insufficient" } | { $: "Gardening" | "Shipping"; delta: ReturnType<TimingPolicy["mean"]> };
};

export const snapshotFormatVersion = 1;

const actionsWaitPolicy = new URL("./actions-wait.bend", import.meta.url);

const waitIdentity = (row: Record<string, SQLOutputValue>): WaitIdentity => ({
  $: "Identity", repository: String(row.repository ?? ""), run_id: Number(row.run_id),
  head_sha: String(row.head_sha ?? ""), attempt: Number(row.attempt),
});

function waitInterval(start: SQLOutputValue, end: SQLOutputValue, unit = 1): WaitClock {
  return { $: "Interval", start: Number(start) * unit, end: Number(end) * unit, observed: start !== null && end !== null };
}

function actionWaitInputs(source: DatabaseSync, repo: string, window: WaitWindow, policy: WaitPolicy) {
  const exists = source.prepare("SELECT 1 FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')");
  const hasWaitFacts = Boolean(exists.get("actions_wait_facts"));
  let input = policy.start_report(window, repo);
  if (hasWaitFacts) {
    for (const row of source.prepare(`
      SELECT repository, run_id, head_sha, attempt, identity_exact, started_ms, ended_ms
      FROM actions_wait_facts WHERE repository = ?
    `).iterate(repo)) {
      input = policy.observe_wait(input, waitIdentity(row), row.identity_exact === 1,
        waitInterval(row.started_ms, row.ended_ms));
    }
    if (exists.get("action_attempts")) {
      for (const row of source.prepare(`
        SELECT repository, run_id, head_sha, attempt FROM action_attempts WHERE repository = ?
      `).iterate(repo)) {
        input = policy.observe_import(input, waitIdentity(row), { $: "AttemptRow" });
      }
    }
  }
  return { input, hasWaitFacts, exists };
}

export async function actionsWaitCapturePlan(database: string, scratch: string, repo: string, window: ActionWaitWindow,
  limit: number): Promise<{ sourceAvailable: boolean; missing: number; attempts: AttemptIdentity[] }> {
  const policy = await loadPolicy<WaitPolicy>(await buildPolicy(scratch, actionsWaitPolicy, "actions-wait.mjs"));
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    const { input, hasWaitFacts } = actionWaitInputs(source, repo, { $: "Window", ...window }, policy);
    const { missing, attempts } = policy.capture_plan(input, limit);
    return { sourceAvailable: hasWaitFacts, missing, attempts: [...rows(attempts)].map((identity) => ({
      repository: identity.repository, runId: identity.run_id, sha: identity.head_sha, attempt: identity.attempt,
    })) };
  } finally {
    source.close();
  }
}

function writeActionsWait(source: DatabaseSync, view: DatabaseSync, repo: string, window: WaitWindow, policy: WaitPolicy) {
  let { input, hasWaitFacts, exists } = actionWaitInputs(source, repo, window, policy);
  if (hasWaitFacts && exists.get("action_attempts")) {
    if (exists.get("action_jobs")) {
      for (const row of source.prepare(`
        SELECT repository, run_id, head_sha, attempt, job_id, label,
          action_jobs.created_at, queue_end, execution_start, execution_end
        FROM action_jobs JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
      `).iterate(repo)) {
        input = policy.observe_import(input, waitIdentity(row), { $: "JobRow", job: {
          $: "Job", job_id: Number(row.job_id), label: String(row.label),
          execution: waitInterval(row.execution_start, row.execution_end, 1000),
          queue: waitInterval(row.created_at, row.queue_end, 1000),
        } });
      }
    }
    if (exists.get("action_steps")) {
      for (const row of source.prepare(`
        SELECT repository, run_id, head_sha, attempt, job_id, step_number, label, action_steps.started_at, completed_at
        FROM action_steps JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
      `).iterate(repo)) {
        input = policy.observe_import(input, waitIdentity(row), { $: "StepRow", step: {
          $: "Step", job_id: Number(row.job_id), number: Number(row.step_number), label: String(row.label),
          execution: waitInterval(row.started_at, row.completed_at, 1000),
        } });
      }
    }
  }

  view.exec(`
    CREATE TABLE actions_wait_coverage(window_start_ms INTEGER, window_end_ms INTEGER,
      wait_count INTEGER, exact_wait_count INTEGER, matched_wait_count INTEGER, matched_attempts INTEGER,
      unmatched_attempts INTEGER, jobless_attempts INTEGER, matched_wait_ms INTEGER, running_ms INTEGER,
      queue_only_ms INTEGER, unknown_job_ms INTEGER, wait_source_present INTEGER);
    CREATE TABLE actions_wait_jobs(window_start_ms INTEGER, window_end_ms INTEGER,
      job_label TEXT, job_count INTEGER, execution_ms INTEGER, only_known_running_ms INTEGER, queue_ms INTEGER, rank INTEGER);
    CREATE TABLE actions_wait_job_instances(window_start_ms INTEGER, window_end_ms INTEGER,
      repository TEXT, run_id INTEGER, head_sha TEXT, attempt INTEGER, job_id INTEGER, job_label TEXT,
      execution_ms INTEGER, only_known_running_ms INTEGER, queue_ms INTEGER,
      PRIMARY KEY (repository, run_id, head_sha, attempt, job_id));
    CREATE TABLE actions_wait_steps(window_start_ms INTEGER, window_end_ms INTEGER,
      run_id INTEGER, attempt INTEGER, job_id INTEGER, step_number INTEGER, step_label TEXT, execution_ms INTEGER,
      PRIMARY KEY (run_id, attempt, job_id, step_number));
  `);
  const bounds = [window.start, window.end] as const;
  const { coverage, jobs, instances, steps } = policy.finish_report(input);
  view.prepare("INSERT INTO actions_wait_coverage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...bounds, coverage.wait_count, coverage.exact_wait_count, coverage.matched_wait_count, coverage.matched_attempts,
    coverage.unmatched_attempts, coverage.jobless_attempts, coverage.matched_wait_ms, coverage.running_ms,
    coverage.queue_only_ms, coverage.unknown_job_ms, Number(hasWaitFacts),
  );
  const duration = (clock: CycleStage) => clock.$ === "Measured" ? clock.ms : null;
  const durations = (row: WaitDurations) =>
    [duration(row.execution_ms), duration(row.only_known_running_ms), duration(row.queue_ms)] as const;
  const job = view.prepare("INSERT INTO actions_wait_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const { rank, summary } of rows(jobs)) {
    job.run(...bounds, summary.job_label, summary.job_count, ...durations(summary), rank);
  }
  const instance = view.prepare("INSERT INTO actions_wait_job_instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of rows(instances)) {
    const { repository, run_id, head_sha, attempt } = row.identity;
    instance.run(...bounds, repository, run_id, head_sha, attempt, row.job_id, row.job_label, ...durations(row));
  }
  const step = view.prepare("INSERT INTO actions_wait_steps VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of rows(steps)) {
    step.run(...bounds, row.run_id, row.attempt, row.job_id, row.step_number, row.step_label, duration(row.execution_ms));
  }
}

async function compileSnapshotPolicies(scratch: string) {
  const [deliveryModule, metricModule, modelModule, traceModule, otlpModule, waitModule] = await buildPolicies(scratch, [
    [deliveryPolicy, "delivery.mjs"],
    [new URL("./metrics.bend", import.meta.url), "metrics.mjs"],
    [new URL("./estimate.bend", import.meta.url), "estimate.mjs"],
    [new URL("./trace.bend", import.meta.url), "trace.mjs"],
    [new URL("./otlp.bend", import.meta.url), "otlp.mjs"],
    [actionsWaitPolicy, "actions-wait.mjs"],
  ]);
  const policy = await loadPolicy<DeliveryPolicy>(deliveryModule);
  const metrics: Metrics = await loadPolicy(metricModule);
  const tracePolicy: TracePolicy = await loadPolicy(traceModule);
  const otlp: OtlpPolicy = await loadPolicy(otlpModule);
  const estimator: Estimator = await loadPolicy(modelModule);
  const waits: WaitPolicy = await loadPolicy(waitModule);
  return { policy, metrics, estimator, waits, metricModule, tracePolicy, otlp };
}

type SnapshotPolicies = Awaited<ReturnType<typeof compileSnapshotPolicies>>;

export async function writeSnapshot(input: string, output: string, scratch: string, requestedRepository: string, cutoff: number,
  writeTrace?: TraceWriter, actionsWaitWindow?: ActionWaitWindow,
  timingCutoff = cutoff * 1000, reviewPolicyOutput?: string, compiled?: SnapshotPolicies) {
  const { policy, metrics, estimator, waits, metricModule, tracePolicy, otlp } = compiled ?? await compileSnapshotPolicies(scratch);
  const repo = repository(requestedRepository, metrics);
  const source = new DatabaseSync(input, { readOnly: true });
  closeSync(openSync(output, "wx", 0o600));
  const view = new DatabaseSync(output);
  const all = (sql: string, ...params: SQLInputValue[]) => source.prepare(sql).all(...params);
  const table = (name: string) => Boolean(source.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
  try {
    source.exec("BEGIN");
    view.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE coverage(snapshot INTEGER, pr_count INTEGER, shipped INTEGER, linked INTEGER,
        prior_week INTEGER, recent_week INTEGER, prior_count INTEGER, recent_count INTEGER,
        direction TEXT, dial INTEGER, delta_seconds REAL);
      CREATE TABLE weeks(week INTEGER, shipped INTEGER, cycle_count INTEGER, mean_seconds REAL);
      CREATE TABLE releases(pr INTEGER, opened INTEGER, merged INTEGER, published INTEGER, verified INTEGER,
        cycle_seconds REAL, pr_seconds REAL, url TEXT);
      CREATE TABLE delivery_milestones(pr INTEGER, ordinal INTEGER, name TEXT, observed_ms INTEGER, elapsed_seconds REAL,
        PRIMARY KEY (pr, ordinal));
      CREATE TABLE review_metadata(repository TEXT NOT NULL);
      CREATE TABLE review_prs(pr INTEGER PRIMARY KEY, release INTEGER NOT NULL, thread INTEGER,
        first_commit INTEGER, opened INTEGER, ci INTEGER, merged INTEGER, dispatch INTEGER, publication INTEGER,
        access INTEGER, linked INTEGER NOT NULL, cycle_ms INTEGER NOT NULL, ci_run INTEGER,
        dispatch_run INTEGER, release_id INTEGER);
      CREATE TABLE delivery_stages(ordinal INTEGER PRIMARY KEY, name TEXT, mean_seconds REAL, observed INTEGER, missing INTEGER);
      CREATE TABLE work(pr INTEGER, status TEXT, created INTEGER, url TEXT);
      CREATE TABLE category_estimates(name TEXT, seconds REAL, total REAL, error REAL, samples INTEGER);
      CREATE TABLE trace(session INTEGER, source_line INTEGER, operation TEXT, clock TEXT, started INTEGER, ended INTEGER);
      CREATE TABLE trace_windows(session INTEGER, trace_id TEXT, started INTEGER, ended INTEGER, measured INTEGER);
      CREATE TABLE trace_coverage(session INTEGER, ordinal INTEGER, kind TEXT, observed INTEGER, missing INTEGER,
        PRIMARY KEY (session, ordinal));
      CREATE TABLE trace_reasoning(session INTEGER, source_line INTEGER, observed INTEGER,
        PRIMARY KEY (session, source_line));
      CREATE INDEX trace_reasoning_window ON trace_reasoning(session, observed);
      CREATE TABLE changed_files(rank INTEGER PRIMARY KEY, path TEXT, path_base64 TEXT, commits INTEGER NOT NULL);
    `);
    const gitScan = table("git_change_scans")
      ? source.prepare("SELECT revision, commits_scanned, truncated, shallow FROM git_change_scans WHERE repository = ?").get(repo)
      : undefined;
    const gitFiles = gitScan ? all("SELECT rank, path, path_base64, commits FROM git_changed_files WHERE repository = ?", repo) : [];
    const changedFile = view.prepare("INSERT INTO changed_files VALUES (?, ?, ?, ?)");
    for (const row of gitFiles) changedFile.run(row.rank, row.path, row.path_base64, row.commits);
    const changedCode = gitScan && {
      revision: String(gitScan.revision), commitsScanned: Number(gitScan.commits_scanned),
      truncated: Boolean(gitScan.truncated), shallow: Boolean(gitScan.shallow), hasPaths: gitFiles.length > 0,
    };
    const url = (number: number) => `https://github.com/${repo}/pull/${number}`;
    const timing = collectTiming(source, repo, metrics, true);
    const prs = table("github_prs") ? readDelivery(source, policy, repo) : [];
    const release = view.prepare("INSERT INTO releases VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const milestone = view.prepare("INSERT INTO delivery_milestones VALUES (?, ?, ?, ?, ?)");
    view.prepare("INSERT INTO review_metadata VALUES (?)").run(repo);
    const review = view.prepare("INSERT OR REPLACE INTO review_prs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const preparedReviews = new Map<number, boolean>();
    let shipments = metrics.empty_shipping_report();
    for (const row of prs) {
      timing.observe("Releases", millis(row.published_at));
      timing.receive("Releases", millis(row.checked_at));
      const clocks: ReleaseClocks = {
        $: "ReleaseClocks", thread: Number(row.thread_started_ms ?? 0), commit: millis(row.first_commit_at),
        opened: millis(row.opened_at), ci: millis(row.first_ci_at), merged: millis(row.merged_at),
        dispatch: millis(row.release_dispatched_at), published: millis(row.published_at), checked: millis(row.checked_at),
      };
      const linked = row.thread_to_release_seconds !== null;
      const elapsed = Math.round((row.thread_to_release_seconds ?? 0) * 1000);
      const result = metrics.shipping_observe(shipments, String(row.channel ?? ""), Number(row.published_at ?? 0), clocks, linked, elapsed);
      shipments = result.report;
      const targetRelease = result.$ === "Published";
      const number = Number(row.pr_number);
      const prepared = preparedReviews.get(number);
      if (prepared === undefined || metrics.review_prefer(prepared, targetRelease)) {
        const fact = metrics.review_fact(number, targetRelease, clocks.thread, clocks.commit, clocks.opened, clocks.ci,
          clocks.merged, clocks.dispatch, clocks.published, clocks.checked, linked, elapsed);
        review.run(fact.pr, Number(fact.release), fact.thread || null, fact.commit || null, fact.opened || null,
          fact.ci || null, fact.merged || null, fact.dispatch || null, fact.publication || null, fact.access || null,
          Number(fact.linked), fact.cycle_ms, row.first_ci_run, fact.dispatch ? row.release_run : null,
          fact.publication ? row.release_id : null);
        preparedReviews.set(number, fact.release);
      }
      if (result.$ === "Unpublished") continue;
      release.run(number, row.opened_at, row.merged_at, row.published_at, row.checked_at,
        row.thread_to_release_seconds, row.pr_to_release_seconds, url(number));
      for (const { ordinal, name, clock, elapsed } of rows(result.milestones)) {
        milestone.run(number, ordinal, name, clock || null, elapsed.$ === "Measured" ? elapsed.ms / 1000 : null);
      }
    }
    const summary = metrics.shipping_result(shipments, cutoff);
    const stageInsert = view.prepare("INSERT INTO delivery_stages VALUES (?, ?, ?, ?, ?)");
    rows(summary.stages).forEach(({ name, stats }, ordinal) =>
      stageInsert.run(ordinal, name, seconds(metrics.mean(stats)), stats.count, stats.missing));
    const weekInsert = view.prepare("INSERT INTO weeks VALUES (?, ?, ?, ?)");
    for (const { week, summary: { shipped, cycles } } of rows(summary.weeks)) {
      weekInsert.run(week, shipped, cycles.count, seconds(metrics.mean(cycles)));
    }
    const { delivery, prior_week, recent_week, prior, recent, direction } = summary;
    view.prepare("INSERT INTO coverage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      cutoff, prs.length, delivery.shipped, delivery.cycles.count, prior_week, recent_week, prior.count, recent.count, direction.$,
      direction.$ === "Insufficient" ? null : direction.$ === "Gardening" ? -1 : 1,
      direction.$ === "Insufficient" ? null : (direction.$ === "Gardening" ? 1 : -1) * Number(seconds(direction.delta)),
    );

    if (table("t3_pr_links")) {
      const add = view.prepare("INSERT INTO work VALUES (?, ?, ?, ?)");
      for (const row of all(`
        SELECT pr_number, thread.status, created_ms, owning, state, settled
        FROM t3_pr_links JOIN t3_threads thread USING (instance, thread_id) WHERE repository = ?
      `, repo)) {
        if (metrics.visible_open(row.owning === 1, String(row.state), row.settled === 1)) {
          add.run(row.pr_number, row.status, Number(row.created_ms) / 1000, url(Number(row.pr_number)));
        }
      }
    }

    if (table("t3_threads")) {
      for (const row of all("SELECT created_ms, updated_ms FROM t3_threads")) {
        timing.observe("T3", Number(row.created_ms), Number(row.updated_ms));
      }
    }
    if (table("t3_runs")) {
      for (const row of all("SELECT requested_ms, started_ms, completed_ms FROM t3_runs")) {
        timing.observe("T3", Number(row.requested_ms), Number(row.started_ms), Number(row.completed_ms));
      }
    }

    let model = estimator.empty_model();
    if (table("codex_command_mixes")) {
      for (const row of all("SELECT * FROM codex_command_mixes ORDER BY instance, session_id, call_id")) {
        model = estimator.model_receipt(model, String(row.instance), String(row.session_id), Number(row.file_count),
          Number(row.git_count), Number(row.build_count), Number(row.push_count), Number(row.seconds));
      }
    }
    const measure = view.prepare("INSERT INTO category_estimates VALUES (?, ?, ?, ?, ?)");
    for (let result = estimator.model_estimates(model); result.$ === "Con"; result = result.tail) {
      const { name, supported, seconds, total, error, samples } = result.head;
      measure.run(name, supported ? seconds : null, supported ? total : null, supported ? error : null, samples);
    }

    const traces = writeTraces(source, view, tracePolicy, otlp, timing, writeTrace);
    timing.write(view, timingCutoff);

    writeActionsWait(source, view, repo,
      actionsWaitWindow ? { $: "Window", ...actionsWaitWindow } : waits.report_window(timingCutoff), waits);
    view.exec("COMMIT");
    if (reviewPolicyOutput) copyFileSync(metricModule, reviewPolicyOutput);
    const from = summary.from;
    const manifest = { formatVersion: snapshotFormatVersion, generation: randomUUID(), createdAt: new Date().toISOString(),
      coverage: { from, to: cutoff, timingCutoffMs: timingCutoff, pullRequests: prs.length,
        shipped: delivery.shipped, linked: delivery.cycles.count,
        rollouts: traces.rolloutCount, traceSessions: traces.traceSessions } };
    return { from: summary.from, to: cutoff, defaultTrace: traces.defaultTrace, traceSessions: traces.traceSessions,
      timingCutoff, rolloutCount: traces.rolloutCount, changedCode, repository: repo, manifest };
  } finally {
    source.close();
    view.close();
  }
}

export function harborSnapshotPublisher(directory: string, repo: string, scratch: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = join(directory, "dashboard.sqlite");
  const reviewPolicy = join(directory, "review-policy.mjs");
  if (existsSync(database)) {
    const previous = new DatabaseSync(database, { readOnly: true });
    try {
      if (previous.prepare("SELECT repository FROM review_metadata").get()?.repository !== repo) {
        throw Error("The Harbor snapshot belongs to another repository");
      }
    } finally {
      previous.close();
    }
  }
  let compiled: SnapshotPolicies | undefined;
  return async (input: string) => {
    compiled ??= await compileSnapshotPolicies(scratch);
    const staging = mkdtempSync(join(directory, ".harbor-"));
    try {
      const next = join(staging, "dashboard.sqlite");
      const policy = join(staging, "review-policy.mjs");
      const now = Date.now();
      await writeSnapshot(input, next, scratch, repo, Math.floor(now / 1000), undefined, undefined, now,
        existsSync(reviewPolicy) ? undefined : policy, compiled);
      if (existsSync(policy)) renameSync(policy, reviewPolicy);
      renameSync(next, database);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  };
}

type ReviewInput = {
  from?: number; to?: number; clock: string; operation?: string; limit: number; offset: number;
};
type ReviewRow = Record<string, SQLOutputValue>;
const utc = (time: number) => new Date(time).toISOString();
const observedUtc = (time: number) => time ? utc(time) : null;

function decodeReview(row: ReviewRow): ReviewFact {
  return {
    $: "ReviewPR", pr: Number(row.pr), release: row.release === 1, thread: Number(row.thread),
    commit: Number(row.first_commit), opened: Number(row.opened), ci: Number(row.ci), merged: Number(row.merged),
    dispatch: Number(row.dispatch), publication: Number(row.publication), access: Number(row.access),
    linked: row.linked === 1, cycle_ms: Number(row.cycle_ms),
  };
}

const reviewContext = "linux-main-x86_64";

function encodeReviewReference(item: ReviewItem, repo: string, asOf: number) {
  return {
    number: item.pr, stage: item.stage, lastObservedAt: observedUtc(item.changed),
    detailPath: `/api/v1/pull-requests/${item.pr}?asOf=${encodeURIComponent(utc(asOf))}`,
    pullRequestUrl: `https://github.com/${repo}/pull/${item.pr}`,
  };
}

function encodeReviewItem(item: ReviewItem, repo: string, asOf: number) {
  return {
    ...encodeReviewReference(item, repo, asOf),
    milestones: rows(item.milestones).map(({ key, phase, observed, elapsed }) => ({
      key, phase, observedAt: observedUtc(observed), elapsedMillis: elapsed.$ === "Measured" ? elapsed.ms : null,
    })),
  };
}

function reviewProvenance(key: string, row: ReviewRow, repo: string) {
  const pullRequest = `https://github.com/${repo}/pull/${row.pr}`;
  const run = (id: SQLOutputValue) => id ? `https://github.com/${repo}/actions/runs/${id}` : null;
  const release = row.release_id ? `https://api.github.com/repos/${repo}/releases/${row.release_id}` : null;
  const sources: Record<string, { source: string; url: string | null }> = {
    "thread-started": { source: "t3-owning-thread-link", url: null },
    "first-commit": { source: "github-pull-request-commits", url: `${pullRequest}/commits` },
    "pr-opened": { source: "github-pull-request", url: pullRequest },
    "first-ci": { source: "github-actions", url: run(row.ci_run) },
    merged: { source: "github-pull-request", url: pullRequest },
    dispatched: { source: "github-actions", url: run(row.dispatch_run) },
    published: { source: "github-release", url: release },
    "access-verified": { source: "verified-release-asset-check", url: release },
  };
  return sources[key];
}

function encodeOperationMap(policy: NonNullable<ReviewPolicy["review_operation_map"]>,
  entries: Pick<MapEntry, "label" | "index" | "children">[], weights: number[]): MapEntry[] {
  const input = weights.reduceRight<List<number>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
  const encode = (tiles: List<MapTile>): MapEntry[] => rows(tiles).map(({ index, millis, grouped, children }) => ({
    ...(grouped ? { label: "Other", index: 0, children: encode(children) } : entries[index]),
    totalSeconds: millis / 1000, grouped,
  }));
  return encode(policy(input));
}

const operationHour = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export async function openShippingReview(directory: string) {
  const database = `${directory}/dashboard.sqlite`;
  const policy: ReviewPolicy = await loadPolicy(`${directory}/review-policy.mjs`);

  function read<T>(query: (db: DatabaseSync, repo: string, coverage: ReviewRow) => T): T {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      db.exec("BEGIN");
      const metadata = db.prepare("SELECT repository FROM review_metadata").get();
      const coverage = db.prepare("SELECT * FROM coverage").get();
      if (!metadata || !coverage) throw Error("Missing prepared review metadata");
      return query(db, String(metadata.repository), coverage);
    } finally {
      db.close();
    }
  }

  read(() => undefined);

  return {
    shipping(input: ReviewInput) {
      if (!policy.review_clock_valid(input.clock)) return { error: "invalid_clock" } as const;
      if (!policy.review_page_valid(input.limit, input.offset)) return { error: "invalid_page" } as const;
      return read((db, repo, coverage) => {
        const snapshotAt = Number(coverage.snapshot) * 1000;
        const window = policy.review_window(snapshotAt, input.from ?? 0, input.to ?? 0,
          input.from !== undefined, input.to !== undefined);
        if (window.$ === "InvalidRange") return { error: "invalid_window" } as const;
        const records = db.prepare("SELECT * FROM review_prs").all();
        const facts = records.reduceRight<List<ReviewFact>>(
          (tail, row) => ({ $: "Con", head: decodeReview(row), tail }), { $: "Nil" });
        const report = policy.review_report(facts, window.from, window.to, window.fleet_from, input.limit, input.offset);
        const timingWindow = policy.review_timing_window();
        const operationRows = db.prepare("SELECT * FROM operation_totals WHERE window = ? AND clock = ? ORDER BY rank")
          .all(timingWindow, input.clock);
        const selectedOperations = operationRows.flatMap((row, index) =>
          policy.review_operation_matches(input.operation ?? "", input.operation === undefined, String(row.operation))
            ? [{ row, index }] : []);
        const mapPolicy = policy.review_operation_map;
        const hourRows = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'operation_hours'").get() &&
          db.prepare("SELECT hour, total_millis FROM operation_hours WHERE window = ? AND clock = ? AND operation = ? ORDER BY rank");
        const operationMap = mapPolicy && encodeOperationMap(mapPolicy, selectedOperations.map(({ row, index }) => {
          const hours = hourRows ? hourRows.all(timingWindow, input.clock, row.operation) : [];
          return { label: String(row.operation), index, children: encodeOperationMap(mapPolicy,
            hours.map(({ hour }) => ({ label: operationHour.format(Number(hour) * 3600000) + " UTC", index, children: [] })),
            hours.map(({ total_millis }) => Number(total_millis))) };
        }), selectedOperations.map(({ row }) => Math.round(Number(row.total_seconds) * 1000)));
        const week = db.prepare("SELECT cycle_count, mean_seconds FROM weeks WHERE week = ?");
        const weekCoverage = (start: number) => {
          const row = week.get(start);
          return { startsAt: utc(start * 1000), attributedShipments: row?.cycle_count ?? 0, meanSeconds: row?.mean_seconds ?? null };
        };
        return {
          repository: repo, surface: reviewContext, snapshotAt: utc(snapshotAt),
          window: { from: utc(window.from), to: utc(window.to) },
          snapshotCoverage: { observedPullRequests: policy.review_count_facts(facts),
            verifiedShipments: coverage.shipped, attributedShipments: coverage.linked },
          cycleComparison: { scope: "latest-two-completed-snapshot-weeks", direction: coverage.direction,
            deltaSeconds: coverage.delta_seconds, prior: weekCoverage(Number(coverage.prior_week)),
            recent: weekCoverage(Number(coverage.recent_week)) },
          shipments: {
            verified: report.verified.shipped, attributed: report.verified.cycles.count,
            weekly: rows(report.weeks).map(({ start, sample }) => ({ startsAt: utc(start * 1000), verified: sample.shipped,
              attributed: sample.cycles.count, meanCycleSeconds: seconds(policy.mean(sample.cycles)) })),
            dailyStages: report.days && rows(report.days).map(({ start, shipped, stages }) => ({
              startsAt: utc(start), verified: shipped,
              stages: rows(stages).map(({ phase, sample }) => ({
                phase, measured: sample.count, meanSeconds: seconds(policy.mean(sample)),
              })),
            })),
          },
          operations: {
            scope: "snapshot", window: timingWindow, clock: input.clock, operation: input.operation ?? null,
            clockOptions: rows(policy.review_clock_options()), operationOptions: operationRows.map(({ operation }) => operation),
            map: operationMap,
            items: selectedOperations.map(({ row: { operation, count, mean_seconds, total_seconds, unmeasured, has_area } }) => ({
                operation, measuredSpans: count, meanSeconds: mean_seconds, totalSeconds: total_seconds,
                unmeasuredSpans: unmeasured, hasArea: has_area === 1,
              })),
          },
          fleet: { from: utc(window.fleet_from), to: utc(window.to),
            items: rows(report.fleet).map((row) => encodeReviewReference(row, repo, window.to)) },
          deliveries: { total: report.total, limit: input.limit, offset: input.offset, nextOffset: report.next_offset || null,
            maxMeasuredMillis: report.max_measured_ms,
            items: rows(report.deliveries).map((row) => encodeReviewItem(row, repo, window.to)) },
        };
      });
    },
    pullRequest(number: number, asOf?: number) {
      return read((db, repo, coverage) => {
        const snapshotAt = Number(coverage.snapshot) * 1000;
        const window = policy.review_window(snapshotAt, 0, asOf ?? 0, false, asOf !== undefined);
        if (window.$ === "InvalidRange") return { error: "invalid_window" } as const;
        const record = db.prepare("SELECT * FROM review_prs WHERE pr = ?").get(number);
        if (!record) return { error: "pull_request_not_observed" } as const;
        const detail = policy.review_item(decodeReview(record), window.to);
        if (detail.stage === "unknown") return { error: "pull_request_not_observed" } as const;
        const item = encodeReviewItem(detail, repo, window.to);
        return {
          repository: repo, surface: reviewContext, snapshotAt: utc(snapshotAt), asOf: utc(window.to), ...item,
          milestones: item.milestones.map((milestone) => ({ ...milestone,
            provenance: milestone.observedAt ? reviewProvenance(milestone.key, record, repo) : null })),
        };
      });
    },
  };
}
