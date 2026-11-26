import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { IntervalClock } from "./intervals.ts";
import type { List } from "../storage/sources.ts";

type Ratio = { numerator: number; denominator: number };
export const seconds = ({ numerator, denominator }: Ratio) => denominator ? numerator / denominator / 1000 : null;
export type Stats = { $: "Stats"; count: number; total: number; missing: number };
type Timing = { clock: string; workflow: number; operation: string; stats: Stats };
export const millis = (time: SQLOutputValue) => Number(time ?? 0) * 1000;

type Bounds = { $: "Window"; from: number; to: number };
type WindowRow = Pick<Timing, "clock" | "workflow" | "operation"> & { occupancy: { stats: Stats; union: number; unplaced: number } };

type WindowSummary = { clocks: List<WindowRow>; operations: List<WindowRow>; workflows: List<WindowRow>;
  totals: List<WindowRow>; mixed: List<WindowRow> };
type TimingSelector = { workflow: string; operation: string };

export type TimingPolicy = {
  repository_name(value: string): string;
  observe_timestamp(bounds: Bounds, at: number): Bounds;
  source_position(bounds: Bounds, latest: number): string;
  empty_window_spans(): unknown;
  window_action_job(spans: unknown, workflow: number, name: string, created: number, queued: number,
    started: number, ended: number): unknown;
  window_action_step(spans: unknown, workflow: number, name: string, start: number, end: number): unknown;
  window_codex_span(spans: unknown, clock: string, categories: string, start: number, end: number): unknown;
  window_reports(spans: unknown, cutoff: number): List<{ key: string; bounds: Bounds; summary: WindowSummary }>;
  measured_union(occupancy: WindowRow["occupancy"]): Ratio;
  window_operation_selectors(row: WindowRow, groups: List<WindowRow>, total: boolean): List<TimingSelector>;
  window_mixed_selectors(row: WindowRow): List<TimingSelector>;
  mean(sample: Stats): Ratio;
  operation_area(sample: Stats): boolean;
  measured_total(sample: Stats): Ratio;
  empty_timing(): unknown;
  timing_action_job(state: unknown, workflow: number, name: string, created: number, queued: number,
    started: number, ended: number): unknown;
  timing_action_step(state: unknown, workflow: number, name: string, started: number, ended: number): unknown;
  timing_result(state: unknown): { operations: List<Timing>; workflows: List<Timing>; totals: List<Timing>; mixed: List<Timing> };
};

const sourceNames = ["Codex", "Actions", "T3", "Releases"] as const;
type TimingSource = typeof sourceNames[number];

export function collectTiming(source: DatabaseSync, repo: string, metrics: TimingPolicy, windowed = false) {
  const all = (sql: string) => source.prepare(sql).all(repo);
  let state = metrics.empty_timing();
  let spans = metrics.empty_window_spans();
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
  if (exists.get("action_jobs")) {
    for (const row of all(`
      SELECT workflow_id, label, action_jobs.created_at, queue_end, execution_start, execution_end
      FROM action_jobs JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
    `)) {
      const workflow = Number(row.workflow_id);
      const label = String(row.label);
      const queued = millis(row.created_at);
      const queueEnd = millis(row.queue_end);
      const started = millis(row.execution_start);
      const ended = millis(row.execution_end);
      if (windowed) {
        observe("Actions", queued, queueEnd, started, ended);
        spans = metrics.window_action_job(spans, workflow, label, queued, queueEnd, started, ended);
      } else {
        state = metrics.timing_action_job(state, workflow, label, queued, queueEnd, started, ended);
      }
    }
    for (const row of all(`
      SELECT workflow_id, label, action_steps.started_at, action_steps.completed_at
      FROM action_steps JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
    `)) {
      const workflow = Number(row.workflow_id);
      const label = String(row.label);
      const started = millis(row.started_at);
      const ended = millis(row.completed_at);
      if (windowed) {
        observe("Actions", started, ended);
        spans = metrics.window_action_step(spans, workflow, label, started, ended);
      } else state = metrics.timing_action_step(state, workflow, label, started, ended);
    }
  }
  return {
    observeCodex(clock: IntervalClock, categories: string, start: number, end: number) {
      observe("Codex", start, end);
      spans = metrics.window_codex_span(spans, clock, categories, start, end);
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
      CREATE TABLE timing_selection(window TEXT, clock TEXT, workflow_choice TEXT, operation_choice TEXT, kind INTEGER,
        rank INTEGER, PRIMARY KEY (window, clock, workflow_choice, operation_choice, kind, rank));
      CREATE VIEW timing_details AS
        SELECT window, clock, 0 AS kind, rank, operation, count, mean_seconds, total_seconds, union_seconds, unmeasured FROM timing
        UNION ALL
        SELECT window, clock, 1 AS kind, rank, operation, count, mean_seconds, total_seconds, union_seconds, unmeasured FROM mixed_groups
        UNION ALL
        SELECT window, clock, 2 AS kind, rank, operation, count, mean_seconds, total_seconds, union_seconds, unmeasured FROM operation_totals;
    `);
      const windows = view.prepare("INSERT INTO timing_windows VALUES (?, ?, ?)");
      const sources = view.prepare("INSERT INTO source_bounds VALUES (?, ?, ?, ?, ?, ?, ?)");
      const clocks = view.prepare("INSERT INTO clock_totals VALUES (?, ?, ?, ?, ?, ?, ?)");
      const timing = view.prepare("INSERT INTO timing VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const workflows = view.prepare("INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const totals = view.prepare("INSERT INTO operation_totals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const mixed = view.prepare("INSERT INTO mixed_groups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const selection = view.prepare("INSERT INTO timing_selection VALUES (?, ?, ?, ?, ?, ?)");
      const stats = ({ occupancy }: WindowRow) => [
        occupancy.stats.count, seconds(metrics.mean(occupancy.stats)), seconds(metrics.measured_total(occupancy.stats)),
        seconds(metrics.measured_union(occupancy)), occupancy.stats.missing,
      ] as const;
      for (const { key, bounds, summary: report } of rows(metrics.window_reports(spans, cutoff))) {
        windows.run(key, bounds.from, bounds.to);
        sourceNames.forEach((name, ordinal) => {
          const { observed, receipt } = sourceClocks.get(name)!;
          sources.run(key, ordinal, name, observed.from || null, observed.to || null,
            receipt.to || null, metrics.source_position(bounds, observed.to));
        });
        for (const row of rows(report.clocks)) {
          const [count, , total, union, missing] = stats(row);
          clocks.run(key, row.clock, count, total, union, missing, row.occupancy.unplaced);
        }
        const select = (row: WindowRow, rank: number, kind: number, selectors: List<TimingSelector>) => {
          for (const { workflow, operation } of rows(selectors)) {
            selection.run(key, row.clock, workflow, operation, kind, rank);
          }
        };
        rows(report.operations).forEach((row, rank) => {
          timing.run(key, row.clock, row.workflow, row.operation, ...stats(row), rank);
          select(row, rank, 0, metrics.window_operation_selectors(row, report.mixed, false));
        });
        rows(report.workflows).forEach((row, rank) => {
          const [count, mean, total, union, missing] = stats(row);
          workflows.run(key, row.clock, row.workflow, total, union, count, mean, missing, rank);
        });
        rows(report.totals).forEach((row, rank) => {
          totals.run(key, row.clock, row.operation, ...stats(row), Number(metrics.operation_area(row.occupancy.stats)), rank);
          select(row, rank, 2, metrics.window_operation_selectors(row, report.mixed, true));
        });
        rows(report.mixed).forEach((row, rank) => {
          mixed.run(key, row.clock, row.operation, ...stats(row), rank);
          select(row, rank, 1, metrics.window_mixed_selectors(row));
        });
      }
    },
  };
}

export function rows<T>(list: List<T>): T[] {
  const result: T[] = [];
  for (let row = list; row.$ === "Con"; row = row.tail) result.push(row.head);
  return result;
}
