import { closeSync, openSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { buildPolicies, loadPolicy } from "../../tooling/bend.ts";
import { deliveryPolicy, readDelivery, type DeliveryPolicy } from "../delivery/delivery.ts";
import type { List } from "../storage/sources.ts";
import { collectTiming, millis, rows, seconds, type Stats, type Timing, type TimingPolicy } from "./timing.ts";
import { writeTraces, type TracePolicy, type TraceProjection } from "./trace.ts";

type Shipping = { $: "Delivery"; shipped: number; cycles: Stats };
type CycleStage = { $: "Measured"; ms: number } | { $: "Missing" };
type Estimator = {
  empty_model(): unknown;
  model_receipt(model: unknown, instance: string, session: string, files: number, git: number, builds: number, pushes: number, seconds: number): unknown;
  model_estimates(model: unknown): List<{ name: string; supported: boolean; seconds: number; error: number;
    total: number; samples: number }>;
};
type Metrics = TimingPolicy & {
  empty_shipping_report(): unknown;
  shipping_observe(report: unknown, channel: string, published: number, clocks: ReleaseClocks,
    linked: boolean, elapsed: number): { $: "Unpublished"; report: unknown } |
      { $: "Published"; report: unknown; milestones: List<Milestone> };
  shipping_result(report: unknown, cutoff: number): ShippingSummary;
  timing_selectors(row: Timing, groups: List<Timing>): List<TimingSelector>;
  mixed_selectors(row: Timing): List<TimingSelector>;
  visible_open(owning: boolean, state: string, settled: boolean): boolean;
};

type TimingSelector = { workflow: string; operation: string; kind: number };
type ReleaseClocks = { $: "ReleaseClocks"; thread: number; commit: number; opened: number; ci: number;
  merged: number; dispatch: number; published: number; checked: number };
type Milestone = { ordinal: number; name: string; clock: number; elapsed: CycleStage };
type ShippingSummary = {
  delivery: Shipping; weeks: List<{ week: number; summary: Shipping }>; stages: List<{ name: string; stats: Stats }>;
  from: number; prior_week: number; recent_week: number; prior: Stats; recent: Stats;
  direction: { $: "Insufficient" } | { $: "Gardening" | "Shipping"; delta: ReturnType<TimingPolicy["mean"]> };
};
export async function writeSnapshot(input: string, output: string, scratch: string, repo: string, cutoff: number,
  writeTrace: (key: string, trace: TraceProjection) => string) {
  const [deliveryModule, metricModule, modelModule, traceModule] = await buildPolicies(scratch, [
    [deliveryPolicy, "delivery.mjs"],
    [new URL("./metrics.bend", import.meta.url), "metrics.mjs"],
    [new URL("./estimate.bend", import.meta.url), "estimate.mjs"],
    [new URL("./trace.bend", import.meta.url), "trace.mjs"],
  ]);
  const policy = await loadPolicy<DeliveryPolicy>(deliveryModule);
  const metrics: Metrics = await loadPolicy(metricModule);
  const tracePolicy: TracePolicy = await loadPolicy(traceModule);
  const estimator: Estimator = await loadPolicy(modelModule);
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
      CREATE TABLE delivery_stages(ordinal INTEGER PRIMARY KEY, name TEXT, mean_seconds REAL, observed INTEGER, missing INTEGER);
      CREATE TABLE work(pr INTEGER, status TEXT, created INTEGER, url TEXT);
      CREATE TABLE timing(clock TEXT, workflow INTEGER, operation TEXT, count INTEGER,
        mean_seconds REAL, total_seconds REAL, unmeasured INTEGER, rank INTEGER);
      CREATE TABLE operation_totals(clock TEXT, operation TEXT, count INTEGER, mean_seconds REAL,
        total_seconds REAL, unmeasured INTEGER, has_area INTEGER, rank INTEGER);
      CREATE TABLE mixed_groups(clock TEXT, operation TEXT, count INTEGER, mean_seconds REAL,
        total_seconds REAL, unmeasured INTEGER, rank INTEGER);
      CREATE TABLE timing_selection(clock TEXT, workflow_choice TEXT, operation_choice TEXT, kind INTEGER,
        rank INTEGER, PRIMARY KEY (clock, workflow_choice, operation_choice, rank, kind));
      CREATE VIEW timing_details AS
        SELECT clock, 0 AS kind, rank, operation, count, mean_seconds, total_seconds, unmeasured FROM timing
        UNION ALL
        SELECT clock, 1 AS kind, rank, operation, count, mean_seconds, total_seconds, unmeasured FROM mixed_groups;
      CREATE TABLE category_estimates(name TEXT, seconds REAL, total REAL, error REAL, samples INTEGER);
      CREATE TABLE workflows(clock TEXT, workflow INTEGER, total_seconds REAL, count INTEGER,
        mean_seconds REAL, unmeasured INTEGER, rank INTEGER);
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
    const prs = table("github_prs") ? readDelivery(source, policy, repo) : [];
    const release = view.prepare("INSERT INTO releases VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const milestone = view.prepare("INSERT INTO delivery_milestones VALUES (?, ?, ?, ?, ?)");
    let shipments = metrics.empty_shipping_report();
    for (const row of prs) {
      const result = metrics.shipping_observe(shipments, String(row.channel ?? ""), Number(row.published_at ?? 0), {
        $: "ReleaseClocks", thread: Number(row.thread_started_ms ?? 0), commit: millis(row.first_commit_at),
        opened: millis(row.opened_at), ci: millis(row.first_ci_at), merged: millis(row.merged_at),
        dispatch: millis(row.release_dispatched_at), published: millis(row.published_at), checked: millis(row.checked_at),
      }, row.thread_to_release_seconds !== null, Math.round((row.thread_to_release_seconds ?? 0) * 1000));
      shipments = result.report;
      if (result.$ === "Unpublished") continue;
      const number = Number(row.pr_number);
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

    const timing = collectTiming(source, repo, metrics);

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

    const traces = writeTraces(source, view, tracePolicy, timing, writeTrace);
    const ranked = metrics.timing_result(traces.timing);
    const timingInsert = view.prepare("INSERT INTO timing VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const selection = view.prepare("INSERT INTO timing_selection VALUES (?, ?, ?, ?, ?)");
    rows(ranked.operations).forEach((row, rank) => {
      timingInsert.run(row.clock, row.workflow, row.operation, row.stats.count,
        seconds(metrics.mean(row.stats)), row.stats.total / 1000, row.stats.missing, rank);
      for (const { workflow, operation, kind } of rows(metrics.timing_selectors(row, ranked.mixed))) {
        selection.run(row.clock, workflow, operation, kind, rank);
      }
    });
    const workflowInsert = view.prepare("INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?)");
    rows(ranked.workflows).forEach((row, rank) =>
      workflowInsert.run(row.clock, row.workflow, row.stats.total / 1000,
        row.stats.count, seconds(metrics.mean(row.stats)), row.stats.missing, rank));
    const overviewInsert = view.prepare("INSERT INTO operation_totals VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const operations = rows(ranked.totals);
    operations.forEach((row, rank) =>
      overviewInsert.run(row.clock, row.operation, row.stats.count, seconds(metrics.mean(row.stats)),
        seconds(metrics.measured_total(row.stats)), row.stats.missing, Number(metrics.operation_area(row.stats)), rank));
    const mixInsert = view.prepare("INSERT INTO mixed_groups VALUES (?, ?, ?, ?, ?, ?, ?)");
    rows(ranked.mixed).forEach((row, rank) => {
      mixInsert.run(row.clock, row.operation, row.stats.count, seconds(metrics.mean(row.stats)),
        seconds(metrics.measured_total(row.stats)), row.stats.missing, rank);
      for (const { workflow, operation, kind } of rows(metrics.mixed_selectors(row))) {
        selection.run(row.clock, workflow, operation, kind, rank);
      }
    });

    view.exec("COMMIT");
    return { from: summary.from, to: cutoff, defaultTrace: traces.defaultTrace, traceSessions: traces.traceSessions,
      rolloutCount: traces.rolloutCount, operationCount: operations.length, changedCode };
  } finally {
    source.close();
    view.close();
  }
}
