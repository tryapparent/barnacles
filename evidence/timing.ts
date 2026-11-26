import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { List } from "./sources.ts";
import type { IntervalClock, ObservedInterval } from "./intervals.ts";

type Ratio = { numerator: number; denominator: number };
export const seconds = ({ numerator, denominator }: Ratio) => denominator ? numerator / denominator / 1000 : null;
export type Stats = { $: "Stats"; count: number; total: number; missing: number };
export type Timing = { clock: string; workflow: number; operation: string; stats: Stats };
const epochMillis = (time: SQLOutputValue) => time === null ? null : Number(time) * 1000;
export const millis = (time: SQLOutputValue) => epochMillis(time) ?? 0;

export type TimingPolicy = {
  interval_clock(clock: IntervalClock): string;
  mean(sample: Stats): Ratio;
  operation_area(sample: Stats): boolean;
  measured_total(sample: Stats): Ratio;
  empty_timing(): unknown;
  timing_observe(state: unknown, clock: IntervalClock, workflow: number, name: string, start: number, end: number): unknown;
  timing_codex(state: unknown, clock: IntervalClock, categories: string, start: number, end: number): unknown;
  timing_result(state: unknown): { operations: List<Timing>; workflows: List<Timing>; totals: List<Timing>; mixed: List<Timing> };
};

export const empty: Stats = { $: "Stats", count: 0, total: 0, missing: 0 };

export function collectTiming(source: DatabaseSync, repo: string, metrics: TimingPolicy) {
  const all = (sql: string) => source.prepare(sql).all(repo);
  let state = metrics.empty_timing();
  function add({ clock, start, end }: ObservedInterval, id: number, operation: string) {
    state = metrics.timing_observe(state, clock, id, operation, start ?? 0, end ?? 0);
  }
  if (source.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get("action_jobs")) {
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
      state = metrics.timing_codex(state, clock, categories, start ?? 0, end ?? 0);
    },
    result: () => metrics.timing_result(state),
  };
}

export function rows<T>(list: List<T>): T[] {
  const result: T[] = [];
  for (let row = list; row.$ === "Con"; row = row.tail) result.push(row.head);
  return result;
}
