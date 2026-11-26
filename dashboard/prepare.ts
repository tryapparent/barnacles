import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { buildPolicy } from "../collector/build.ts";
import { repository } from "../collector/wire.ts";
import { deliveryReport, type SourcePolicy } from "../evidence/sources.ts";
import { dashboards } from "./panels.ts";
import { encodeTrace, type TracePolicy } from "./trace.ts";

type Ratio = { numerator: number; denominator: number };
const seconds = ({ numerator, denominator }: Ratio) => denominator ? numerator / denominator / 1000 : null;
type Stats = { $: "Stats"; count: number; total: number; missing: number };
type Shipping = { $: "Delivery"; shipped: number; cycles: Stats };
type CycleStage = { $: "Measured"; ms: number } | { $: "Missing" };
type Metrics = TracePolicy & {
  record_release(sample: Shipping, linked: boolean, elapsedMs: number): Shipping;
  visible_release(channel: string, published: number): boolean;
  codex_clock(clock: string): string;
  record_interval(sample: Stats, start: number, end: number): Stats;
  cycle_stage(start: number, end: number): CycleStage;
  count_cycle_stage(sample: Stats, stage: CycleStage): Stats;
  mean(sample: Stats): Ratio;
  week(epoch: number): number;
  previous_week(epoch: number): number;
  direction(recent: Stats, prior: Stats): { $: "Insufficient" } | { $: "Gardening" | "Shipping"; delta: Ratio };
  count_in_map(clock: string): boolean;
  ranks_before(total: number, key: string, otherTotal: number, otherKey: string): boolean;
  visible_open(owning: boolean, state: string, settled: boolean): boolean;
};

const empty: Stats = { $: "Stats", count: 0, total: 0, missing: 0 };
const emptyShipping: Shipping = { $: "Delivery", shipped: 0, cycles: empty };
type Timing = { clock: string; workflow: number; operation: string; stats: Stats };
const millis = (seconds: SQLOutputValue) => seconds === null ? 0 : Number(seconds) * 1000;

function writeSnapshot(input: string, output: string, otlp: string, repo: string, policy: SourcePolicy, metrics: Metrics, cutoff: number) {
  const source = new DatabaseSync(input, { readOnly: true });
  closeSync(openSync(output, "wx", 0o600));
  const view = new DatabaseSync(output);
  const payloads = openSync(otlp, "wx", 0o600);
  const all = (sql: string, ...params: SQLInputValue[]) => source.prepare(sql).all(...params);
  const table = (name: string) => Boolean(source.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
  try {
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
      CREATE TABLE time_map(clock TEXT, total_seconds REAL, rank INTEGER);
      CREATE TABLE workflows(clock TEXT, workflow INTEGER, total_seconds REAL, count INTEGER,
        mean_seconds REAL, unmeasured INTEGER, rank INTEGER);
      CREATE TABLE trace(session INTEGER, source_line INTEGER, operation TEXT, clock TEXT, started INTEGER, ended INTEGER);
      CREATE TABLE trace_windows(session INTEGER, trace_id TEXT, started INTEGER, ended INTEGER, measured INTEGER);
      CREATE TABLE trace_reasoning(session INTEGER, source_line INTEGER, observed INTEGER,
        PRIMARY KEY (session, source_line));
      CREATE INDEX trace_reasoning_window ON trace_reasoning(session, observed);
    `);
    const url = (number: number) => `https://github.com/${repo}/pull/${number}`;
    const prs = table("github_prs") ? deliveryReport(input, policy).filter((row) => row.repository === repo) : [];
    const weeks = new Map<number, Shipping>();
    const release = view.prepare("INSERT INTO releases VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const milestone = view.prepare("INSERT INTO delivery_milestones VALUES (?, ?, ?, ?, ?)");
    const milestoneNames = ["Thread started", "First commit", "PR opened", "First PR CI", "PR merged", "Release dispatch", "Shipped", "Access verified"];
    const stageNames = ["Thread → commit", "Commit → PR open", "PR open → first CI", "First CI → merge", "Merge → dispatch",
      "Dispatch → ship", "PR open → merge", "Merge → ship", "Thread → ship"];
    const stageStats = stageNames.map(() => empty);
    let delivery = emptyShipping;
    for (const row of prs) {
      if (!metrics.visible_release(String(row.channel ?? ""), Number(row.published_at ?? 0))) continue;
      const number = Number(row.pr_number);
      release.run(number, row.opened_at, row.merged_at, row.published_at, row.checked_at,
        row.thread_to_release_seconds, row.pr_to_release_seconds, url(number));
      const clocks = [Number(row.thread_started_ms ?? 0), millis(row.first_commit_at), millis(row.opened_at),
        millis(row.first_ci_at), millis(row.merged_at), millis(row.release_dispatched_at),
        millis(row.published_at), millis(row.checked_at)];
      const stages = clocks.slice(1, -1).map((clock, index) => metrics.cycle_stage(clocks[index], clock));
      const elapsed = [{ $: "Missing" } as const, ...stages, { $: "Missing" } as const];
      clocks.forEach((clock, index) => {
        const part = elapsed[index];
        milestone.run(number, index, milestoneNames[index], clock || null, part.$ === "Measured" ? part.ms / 1000 : null);
      });
      stages.push(metrics.cycle_stage(clocks[2], clocks[4]), metrics.cycle_stage(clocks[4], clocks[6]),
        metrics.cycle_stage(row.thread_to_release_seconds === null ? 0 : clocks[0], clocks[6]));
      stages.forEach((part, index) => { stageStats[index] = metrics.count_cycle_stage(stageStats[index], part); });
      const params = [row.thread_to_release_seconds !== null, Math.round((row.thread_to_release_seconds ?? 0) * 1000)] as const;
      delivery = metrics.record_release(delivery, ...params);
      const week = metrics.week(Number(row.published_at));
      weeks.set(week, metrics.record_release(weeks.get(week) ?? emptyShipping, ...params));
    }
    const stageInsert = view.prepare("INSERT INTO delivery_stages VALUES (?, ?, ?, ?, ?)");
    stageStats.forEach((stats, index) => stageInsert.run(index, stageNames[index], seconds(metrics.mean(stats)), stats.count, stats.missing));
    const weekInsert = view.prepare("INSERT INTO weeks VALUES (?, ?, ?, ?)");
    for (const [week, { shipped, cycles }] of weeks) {
      weekInsert.run(week, shipped, cycles.count, seconds(metrics.mean(cycles)));
    }
    const recentWeek = metrics.previous_week(cutoff);
    const priorWeek = metrics.previous_week(recentWeek);
    const recent = weeks.get(recentWeek)?.cycles ?? empty;
    const prior = weeks.get(priorWeek)?.cycles ?? empty;
    const direction = metrics.direction(recent, prior);
    view.prepare("INSERT INTO coverage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      cutoff, prs.length, delivery.shipped, delivery.cycles.count, priorWeek, recentWeek, prior.count, recent.count, direction.$,
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

    const timing = new Map<string, Timing>();
    const workflow = new Map<string, Timing>();
    const totals = new Map<string, Stats>();
    function add(clock: string, id: number, operation: string, start: number, end: number) {
      const operationKey = JSON.stringify([clock, id, operation]);
      for (const [collection, key] of [[timing, operationKey], [workflow, JSON.stringify([clock, id])]] as const) {
        const row = collection.get(key) ?? { clock, workflow: id, operation, stats: empty };
        row.stats = metrics.record_interval(row.stats, start, end);
        collection.set(key, row);
      }
      if (metrics.count_in_map(clock)) totals.set(clock, metrics.record_interval(totals.get(clock) ?? empty, start, end));
    }
    if (table("action_jobs")) {
      for (const row of all(`
        SELECT workflow_id, label, action_jobs.created_at, queue_end, execution_start, execution_end
        FROM action_jobs JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
      `, repo)) {
        add("CI queue", Number(row.workflow_id), String(row.label), millis(row.created_at), millis(row.queue_end));
        add("CI execution", Number(row.workflow_id), String(row.label), millis(row.execution_start), millis(row.execution_end));
      }
      for (const row of all(`
        SELECT workflow_id, label, action_steps.started_at, action_steps.completed_at
        FROM action_steps JOIN action_attempts USING (repository, run_id, attempt) WHERE repository = ?
      `, repo)) {
        add("CI steps", Number(row.workflow_id), String(row.label), millis(row.started_at), millis(row.completed_at));
      }
    }

    const traceWindows = [];
    if (table("codex_spans")) {
      const spans = table("codex_commands")
        ? all(`SELECT codex_spans.*, command FROM codex_spans LEFT JOIN codex_commands USING (instance, session_id, call_id)
            ORDER BY started_ms, source_line, clock`)
        : all("SELECT * FROM codex_spans ORDER BY started_ms, source_line, clock");
      const markers = table("codex_reasoning") ? all("SELECT * FROM codex_reasoning ORDER BY observed_ms, source_line") : [];
      const sessionKey = (row: Record<string, SQLOutputValue>) => JSON.stringify([row.instance, row.session_id]);
      const sessions = Map.groupBy(spans, sessionKey);
      const bySession = Map.groupBy(markers, sessionKey);
      for (const key of bySession.keys()) if (!sessions.has(key)) sessions.set(key, []);
      const insert = view.prepare("INSERT INTO trace VALUES (?, ?, ?, ?, ?, ?)");
      const mark = view.prepare("INSERT INTO trace_reasoning VALUES (?, ?, ?)");
      const windows = view.prepare("INSERT INTO trace_windows VALUES (?, ?, ?, ?, ?)");
      for (const [key, rows] of sessions) {
        const session = traceWindows.length + 1;
        const observations = rows.map((row) => ({ call: String(row.call_id), terminal: row.terminal_call_id as string | null,
          line: Number(row.source_line), tool: String(row.tool), command: String(row.command ?? ""), clock: String(row.clock),
          start: row.started_ms as number | null, end: row.ended_ms as number | null }));
        const events = (bySession.get(key) ?? []).map((row) => ({ line: Number(row.source_line), at: Number(row.observed_ms) }));
        for (const row of observations) {
          const clock = metrics.codex_clock(row.clock);
          add(clock, 0, row.tool, row.start ?? 0, row.end ?? 0);
          insert.run(session, row.line, metrics.trace_operation(row.clock, row.tool, row.command),
            clock, row.start, row.end);
        }
        for (const event of events) mark.run(session, event.line, event.at);
        const trace = encodeTrace(key, observations, events, metrics);
        if (trace) {
          writeSync(payloads, JSON.stringify(trace.payload) + "\n");
        }
        windows.run(session, trace?.traceId ?? null, trace?.bounds.from ?? null, trace?.bounds.to ?? null, trace?.spans ?? 0);
        traceWindows.push({ session, from: trace?.bounds.from ?? cutoff * 1000, to: trace?.bounds.to ?? cutoff * 1000,
          traceId: trace?.traceId ?? "" });
      }
    }
    const compare = <T>(left: [string, T], right: [string, T], total: (data: T) => number) =>
      Number(metrics.ranks_before(total(right[1]), right[0], total(left[1]), left[0])) -
      Number(metrics.ranks_before(total(left[1]), left[0], total(right[1]), right[0]));
    const timingInsert = view.prepare("INSERT INTO timing VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    [...timing].sort((a, b) => compare(a, b, (row) => row.stats.total)).forEach(([, row], rank) =>
      timingInsert.run(row.clock, row.workflow, row.operation, row.stats.count,
        seconds(metrics.mean(row.stats)), row.stats.total / 1000, row.stats.missing, rank));
    const workflowInsert = view.prepare("INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?)");
    [...workflow].sort((a, b) => compare(a, b, (row) => row.stats.total)).forEach(([, row], rank) =>
      workflowInsert.run(row.clock, row.workflow, row.stats.total / 1000,
        row.stats.count, seconds(metrics.mean(row.stats)), row.stats.missing, rank));
    const mapInsert = view.prepare("INSERT INTO time_map VALUES (?, ?, ?)");
    [...totals].sort((a, b) => compare(a, b, (stats) => stats.total)).forEach(([clock, stats], rank) => {
      if (stats.total) mapInsert.run(clock, stats.total / 1000, rank);
    });

    view.exec("COMMIT");
    return { from: Math.min(priorWeek, ...weeks.keys()), to: cutoff, traceWindows };
  } finally {
    closeSync(payloads);
    source.close();
    view.close();
  }
}

async function main() {
  const [input, output, requestedRepository, ...extra] = process.argv.slice(2);
  if (!input || !output || !requestedRepository || extra.length) {
    throw Error("Usage: node dashboard/prepare.ts EVIDENCE_SQLITE NEW_OUTPUT_DIRECTORY OWNER/REPO");
  }
  const repo = repository(requestedRepository);
  const directory = resolve(output);
  mkdirSync(directory, { mode: 0o700 });
  const scratch = mkdtempSync(join(directory, "build-"));
  try {
    const [metrics, sources] = await Promise.all([
      buildPolicy(scratch, new URL("./metrics.bend", import.meta.url), "metrics.mjs"),
      buildPolicy(scratch, new URL("../evidence/sources.bend", import.meta.url), "sources.mjs"),
    ]);
    const load = async (path: string) => (await import(pathToFileURL(path).href)).default;
    const snapshot = join(scratch, "dashboard.sqlite");
    const otlp = join(scratch, "tempo.ndjson");
    const range = writeSnapshot(resolve(input), snapshot, otlp, repo, await load(sources), await load(metrics), Math.floor(Date.now() / 1000));
    const configs = dashboards(range);
    const provision = join(directory, "dashboards");
    mkdirSync(provision);
    for (const [name, config] of Object.entries(configs)) {
      writeFileSync(join(provision, name + ".json"), JSON.stringify(config), { flag: "wx" });
    }
    renameSync(snapshot, join(directory, "dashboard.sqlite"));
    renameSync(otlp, join(directory, "tempo.ndjson"));
    console.log("Prepared local Grafana snapshot");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
