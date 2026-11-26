import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { List } from "../storage/sources.ts";

type Ratio = { numerator: number; denominator: number };
export const seconds = ({ numerator, denominator }: Ratio) => denominator ? numerator / denominator / 1000 : null;
export type Stats = { $: "Stats"; count: number; total: number; missing: number };
export type Timing = { clock: string; workflow: number; operation: string; stats: Stats };
export const millis = (time: SQLOutputValue) => Number(time ?? 0) * 1000;

export type TimingPolicy = {
  mean(sample: Stats): Ratio;
  operation_area(sample: Stats): boolean;
  measured_total(sample: Stats): Ratio;
  empty_timing(): unknown;
  timing_action_job(state: unknown, workflow: number, name: string, created: number, queued: number,
    started: number, ended: number): unknown;
  timing_action_step(state: unknown, workflow: number, name: string, started: number, ended: number): unknown;
  timing_result(state: unknown): { operations: List<Timing>; workflows: List<Timing>; totals: List<Timing>; mixed: List<Timing> };
};

export function collectTiming(source: DatabaseSync, repo: string, metrics: TimingPolicy) {
  const all = (sql: string) => source.prepare(sql).all(repo);
  let state = metrics.empty_timing();
  if (source.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get("action_jobs")) {
    for (const row of all(`
      SELECT workflow_id, label, action_jobs.created_at, queue_end, execution_start, execution_end
      FROM action_jobs JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
    `)) {
      state = metrics.timing_action_job(state, Number(row.workflow_id), String(row.label), millis(row.created_at),
        millis(row.queue_end), millis(row.execution_start), millis(row.execution_end));
    }
    for (const row of all(`
      SELECT workflow_id, label, action_steps.started_at, action_steps.completed_at
      FROM action_steps JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
    `)) {
      state = metrics.timing_action_step(state, Number(row.workflow_id), String(row.label),
        millis(row.started_at), millis(row.completed_at));
    }
  }
  return state;
}

export function rows<T>(list: List<T>): T[] {
  const result: T[] = [];
  for (let row = list; row.$ === "Con"; row = row.tail) result.push(row.head);
  return result;
}
