import { DatabaseSync } from "node:sqlite";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { rows } from "../projection/timing.ts";
import type { List } from "../storage/sources.ts";

const historyList = <T>(values: T[]): List<T> =>
  values.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

type PlowRun = { $: "Run"; requested: number; started: number; completed: number; status: string };
type PlowThread = { $: "Thread"; created: number; updated: number; runs: List<PlowRun> };
type PlowSpan = { a: number; b: number; name: string };
type PlowTrace = { start: number; end: number; work: List<PlowSpan>; wait: List<PlowSpan>; errors: List<number> };
type PlowPolicy = { project_feed(threads: List<PlowThread>): { observed: number; traces: List<PlowTrace> } };

export async function projectPlowFeed(path: string, scratch: string) {
  const module = await buildPolicy(scratch, new URL("./plow-feed.bend", import.meta.url), "plow-feed.mjs");
  const policy = await loadPolicy<PlowPolicy>(module);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN");
    const threads = db.prepare("SELECT instance, thread_id, created_ms, updated_ms FROM t3_threads ORDER BY instance, thread_id").all();
    const runs = db.prepare(`SELECT requested_ms, started_ms, completed_ms, status FROM t3_runs
      WHERE instance=? AND thread_id=? ORDER BY run_id`);
    const projected = policy.project_feed(historyList(threads.map(thread => ({
      $: "Thread", created: Number(thread.created_ms), updated: Number(thread.updated_ms),
      runs: historyList(runs.all(thread.instance, thread.thread_id).map(run => ({
        $: "Run", requested: Number(run.requested_ms), started: Number(run.started_ms),
        completed: Number(run.completed_ms), status: String(run.status),
      }))),
    }))));
    const spans = (list: List<PlowSpan>) => rows(list).map(({ a, b, name }) => [a / 1000, b / 1000, name]);
    return { observed: projected.observed, traces: rows(projected.traces).map(trace => ({
      startUtcMs: trace.start, end: trace.end / 1000,
      work: spans(trace.work), wait: spans(trace.wait), errors: rows(trace.errors).map(at => at / 1000),
    })) };
  } finally {
    db.close();
  }
}
