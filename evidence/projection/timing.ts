import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { List } from "../storage/sources.ts";
import type { IntervalClock, ObservedInterval } from "./intervals.ts";

type Ratio = { numerator: number; denominator: number };
export const seconds = ({ numerator, denominator }: Ratio) => denominator ? numerator / denominator / 1000 : null;
export type Stats = { $: "Stats"; count: number; total: number; missing: number };
export type Timing = { clock: string; workflow: number; operation: string; stats: Stats };
const epochMillis = (time: SQLOutputValue) => time === null ? null : Number(time) * 1000;
export const millis = (time: SQLOutputValue) => epochMillis(time) ?? 0;

type Bounds = { $: "Window"; from: number; to: number };
type WindowRow = Pick<Timing, "clock" | "workflow" | "operation"> & { occupancy: { stats: Stats; union: number; unplaced: number } };
type Span = { clock: IntervalClock; workflow: number; operation: string; start: number; end: number; codex: boolean };

export type TimingPolicy = {
  interval_clock(clock: IntervalClock): string;
  timing_windows(cutoff: number): List<{ key: string; bounds: Bounds }>;
  starts_before(left: number, right: number): boolean;
  observe_timestamp(bounds: Bounds, at: number): Bounds;
  source_position(bounds: Bounds, latest: number): string;
  start_window_groups(): unknown;
  window_observe(state: unknown, bounds: Bounds, clock: string, workflow: number, operation: string,
    start: number, end: number, codex: boolean): unknown;
  summarize_window(state: unknown): { clocks: List<WindowRow>; operations: List<WindowRow>; workflows: List<WindowRow>;
    totals: List<WindowRow>; mixed: List<WindowRow> };
  mean(sample: Stats): Ratio;
  operation_area(sample: Stats): boolean;
  measured_total(sample: Stats): Ratio;
  empty_timing(): unknown;
  timing_observe(state: unknown, clock: IntervalClock, workflow: number, name: string, start: number, end: number): unknown;
  timing_codex(state: unknown, clock: IntervalClock, categories: string, start: number, end: number): unknown;
  timing_result(state: unknown): { operations: List<Timing>; workflows: List<Timing>; totals: List<Timing>; mixed: List<Timing> };
};

export const empty: Stats = { $: "Stats", count: 0, total: 0, missing: 0 };

const sourceNames = ["Codex", "Actions", "T3", "Releases"] as const;
type TimingSource = typeof sourceNames[number];

export function collectTiming(source: DatabaseSync, repo: string, metrics: TimingPolicy, windowed = false) {
  const all = (sql: string) => source.prepare(sql).all(repo);
  let state = metrics.empty_timing();
  const spans: Span[] = [];
  const emptyBounds: Bounds = { $: "Window", from: 0, to: 0 };
  const sourceClocks = new Map(sourceNames.map((name) => [name, { observed: emptyBounds, receipt: emptyBounds }]));
  function observe(name: TimingSource, ...timestamps: number[]) {
    const clock = sourceClocks.get(name)!;
    for (const at of timestamps) clock.observed = metrics.observe_timestamp(clock.observed, at);
  }
  function receive(name: TimingSource, at: number) {
    const clock = sourceClocks.get(name)!;
    clock.receipt = metrics.observe_timestamp(clock.receipt, at);
  }
  const exists = source.prepare("SELECT 1 FROM sqlite_schema WHERE name=?");
  if (windowed && exists.get("action_attempts")) {
    for (const row of all("SELECT created_at, started_at, source_updated, observed_at FROM action_attempts WHERE repository = ?")) {
      observe("Actions", millis(row.created_at), millis(row.started_at), millis(row.source_updated));
      receive("Actions", millis(row.observed_at));
    }
  }
  function add({ clock, start, end }: ObservedInterval, id: number, operation: string) {
    if (windowed) {
      observe("Actions", start ?? 0, end ?? 0);
      spans.push({ clock, workflow: id, operation, start: start ?? 0, end: end ?? 0, codex: false });
    } else {
      state = metrics.timing_observe(state, clock, id, operation, start ?? 0, end ?? 0);
    }
  }
  if (exists.get("action_jobs")) {
    for (const row of all(`
      SELECT workflow_id, run_id, attempt, job_id, label, action_jobs.created_at, queue_end, execution_start, execution_end
      FROM action_jobs JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
    `)) {
      const identity = { source: "github-actions" as const, repository: repo,
        run: String(row.run_id), attempt: Number(row.attempt), job: String(row.job_id) };
      add({ identity, clock: "ci_queue", start: epochMillis(row.created_at), end: epochMillis(row.queue_end) },
        Number(row.workflow_id), String(row.label));
      add({ identity, clock: "ci_execution", start: epochMillis(row.execution_start), end: epochMillis(row.execution_end) },
        Number(row.workflow_id), String(row.label));
    }
    for (const row of all(`
      SELECT workflow_id, run_id, attempt, job_id, step_number, label, action_steps.started_at, action_steps.completed_at
      FROM action_steps JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
    `)) {
      const identity = { source: "github-actions" as const, repository: repo,
        run: String(row.run_id), attempt: Number(row.attempt), job: String(row.job_id), step: Number(row.step_number) };
      add({ identity, clock: "ci_step", start: epochMillis(row.started_at), end: epochMillis(row.completed_at) },
        Number(row.workflow_id), String(row.label));
    }
  }
  return {
    observeCodex({ clock, start, end }: ObservedInterval, categories: string) {
      if (windowed) {
        observe("Codex", start ?? 0, end ?? 0);
        spans.push({ clock, workflow: 0, operation: categories, start: start ?? 0, end: end ?? 0, codex: true });
      } else {
        state = metrics.timing_codex(state, clock, categories, start ?? 0, end ?? 0);
      }
    },
    result: () => metrics.timing_result(state),
    observe, receive,
    write(view: DatabaseSync, cutoff: number) {
      view.exec(`
      CREATE TABLE timing_windows(window TEXT PRIMARY KEY, started_ms INTEGER, ended_ms INTEGER);
      CREATE TABLE source_bounds(window TEXT, ordinal INTEGER, source TEXT, first_ms INTEGER, latest_ms INTEGER,
        receipt_ms INTEGER, position TEXT, PRIMARY KEY (window, ordinal));
      CREATE TABLE clock_totals(window TEXT, clock TEXT, count INTEGER, total_seconds REAL,
        union_seconds REAL, unmeasured INTEGER, unplaced INTEGER, PRIMARY KEY (window, clock));
      CREATE TABLE timing(window TEXT, clock TEXT, workflow INTEGER, operation TEXT, count INTEGER,
        mean_seconds REAL, total_seconds REAL, union_seconds REAL, unmeasured INTEGER, rank INTEGER);
      CREATE TABLE operation_totals(window TEXT, clock TEXT, operation TEXT, count INTEGER,
        mean_seconds REAL, total_seconds REAL, union_seconds REAL, unmeasured INTEGER, has_area INTEGER, rank INTEGER);
      CREATE TABLE mixed_groups(window TEXT, clock TEXT, operation TEXT, count INTEGER, mean_seconds REAL,
        total_seconds REAL, union_seconds REAL, unmeasured INTEGER, rank INTEGER);
      CREATE TABLE workflows(window TEXT, clock TEXT, workflow INTEGER, total_seconds REAL, union_seconds REAL,
        count INTEGER, mean_seconds REAL, unmeasured INTEGER, rank INTEGER);
    `);
      const windows = view.prepare("INSERT INTO timing_windows VALUES (?, ?, ?)");
      const sources = view.prepare("INSERT INTO source_bounds VALUES (?, ?, ?, ?, ?, ?, ?)");
      const clocks = view.prepare("INSERT INTO clock_totals VALUES (?, ?, ?, ?, ?, ?, ?)");
      const timing = view.prepare("INSERT INTO timing VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const workflows = view.prepare("INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const totals = view.prepare("INSERT INTO operation_totals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const mixed = view.prepare("INSERT INTO mixed_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const stats = ({ occupancy: { stats, union } }: WindowRow) => [
        stats.count, seconds(metrics.mean(stats)), seconds(metrics.measured_total(stats)),
        stats.count ? union / 1000 : null, stats.missing,
      ] as const;
      spans.sort((a, b) => Number(metrics.starts_before(b.start, a.start)) - Number(metrics.starts_before(a.start, b.start)));
      for (const { key, bounds } of rows(metrics.timing_windows(cutoff))) {
        windows.run(key, bounds.from, bounds.to);
        sourceNames.forEach((name, ordinal) => {
          const { observed, receipt } = sourceClocks.get(name)!;
          sources.run(key, ordinal, name, observed.from || null, observed.to || null,
            receipt.to || null, metrics.source_position(bounds, observed.to));
        });
        let state = metrics.start_window_groups();
        for (const { clock, workflow, operation, start, end, codex } of spans) {
          state = metrics.window_observe(state, bounds, clock, workflow, operation, start, end, codex);
        }
        const report = metrics.summarize_window(state);
        for (const row of rows(report.clocks)) {
          const [count, , total, union, missing] = stats(row);
          clocks.run(key, row.clock, count, total, union, missing, row.occupancy.unplaced);
        }
        rows(report.operations).forEach((row, rank) =>
          timing.run(key, row.clock, row.workflow, row.operation, ...stats(row), rank));
        rows(report.workflows).forEach((row, rank) => {
          const [count, mean, total, union, missing] = stats(row);
          workflows.run(key, row.clock, row.workflow, total, union, count, mean, missing, rank);
        });
        rows(report.totals).forEach((row, rank) =>
          totals.run(key, row.clock, row.operation, ...stats(row), Number(metrics.operation_area(row.occupancy.stats)), rank));
        rows(report.mixed).forEach((row, rank) =>
          mixed.run(key, row.clock, row.operation, ...stats(row), rank));
      }
    },
  };
}

export function rows<T>(list: List<T>): T[] {
  const result: T[] = [];
  for (let row = list; row.$ === "Con"; row = row.tail) result.push(row.head);
  return result;
}
