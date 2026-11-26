import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { IntervalClock, ObservedInterval } from "./intervals.ts";

type Ratio = { numerator: number; denominator: number };
export const seconds = ({ numerator, denominator }: Ratio) => denominator ? numerator / denominator / 1000 : null;
export type Stats = { $: "Stats"; count: number; total: number; missing: number };
type Timing = { clock: string; workflow: number; operation: string; stats: Stats };
export const epochMillis = (time: SQLOutputValue) => time === null ? null : Number(time) * 1000;
export const millis = (time: SQLOutputValue) => epochMillis(time) ?? 0;

export type TimingPolicy = {
  interval_clock(clock: IntervalClock): string;
  record_interval(sample: Stats, start: number, end: number): Stats;
  mean(sample: Stats): Ratio;
  operation_area(sample: Stats): boolean;
  measured_total(sample: Stats): Ratio;
  ranks_before(total: number, key: string, otherTotal: number, otherKey: string): boolean;
};

export const empty: Stats = { $: "Stats", count: 0, total: 0, missing: 0 };

export function collectTiming(source: DatabaseSync, repo: string, metrics: TimingPolicy) {
  const all = (sql: string) => source.prepare(sql).all(repo);
  const timing = new Map<string, Timing>();
  const workflow = new Map<string, Timing>();
  const operations = new Map<string, Timing>();
  const mixes = new Map<string, Timing>();
  function add(interval: ObservedInterval, id: number, operation: string, group?: string) {
    const { start, end } = interval;
    const clock = metrics.interval_clock(interval.clock);
    function record(collection: Map<string, Timing>, key: string, name: string) {
      const row = collection.get(key) ?? { clock, workflow: id, operation: name, stats: empty };
      row.stats = metrics.record_interval(row.stats, start ?? 0, end ?? 0);
      collection.set(key, row);
    }
    record(timing, JSON.stringify([clock, id, operation]), operation);
    record(workflow, JSON.stringify([clock, id]), operation);
    record(operations, JSON.stringify([clock, operation]), operation);
    if (group !== undefined) record(mixes, JSON.stringify([clock, group]), group);
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
  const compare = <T>(left: [string, T], right: [string, T], total: (data: T) => number) =>
    Number(metrics.ranks_before(total(right[1]), right[0], total(left[1]), left[0])) -
    Number(metrics.ranks_before(total(left[1]), left[0], total(right[1]), right[0]));
  const ranked = (collection: Map<string, Timing>) =>
    [...collection].sort((a, b) => compare(a, b, (row) => row.stats.total)).map(([, row]) => row);
  return {
    add,
    operations: () => ranked(timing),
    workflows: () => ranked(workflow),
    operationTotals: () => ranked(operations),
    mixedGroups: () => ranked(mixes),
  };
}
