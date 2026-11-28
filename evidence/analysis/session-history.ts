import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { rows } from "../projection/timing.ts";
import type { List } from "../storage/sources.ts";

const historyList = <T>(values: T[]): List<T> =>
  values.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

type JoinedRun = { $: "Run"; id: string; requested: string; started: string; completed: string };
type JoinedSpan = { $: "Span"; id: string; operation: string; start: string; end: string };
type JoinedJob = { $: "Job"; id: string; label: string; status: string; conclusion: string; prior: boolean;
  created: string; queued: string; started: string; completed: string; scope: string };
type JoinedReplay = { runs: number; spans: number; attempts: number; jobs: number; carried: number };
type Window = { $: "DayWindow"; from: number; to: number };
type Observation = { $: "DayObservation"; rule: string; id: string };
type Measure = { $: "Some"; value: number } | { $: "None" };
type Signal = { $: "Signal"; kind: string; scope: string; event: string; elapsed: Measure };
type ImpactPattern = { pattern: string; stage: string; uniqueMs: number | null; medianMs: number | null; worstMs: number | null;
  affectedOutcomes: number; coverage: { sufficient: number; occurrences: number } };
type Delay = { $: "Delay"; pattern: string; stage: string; elapsed: number; measured: number; occurrences: number;
  outcomes: number; median: Measure; worst: Measure };

const measure = (value: number | null): Measure => value === null ? { $: "None" } : { $: "Some", value };
const delayInput = ({ pattern, stage, uniqueMs, medianMs, worstMs, affectedOutcomes, coverage }: ImpactPattern): Delay =>
  ({ $: "Delay", pattern, stage, elapsed: uniqueMs ?? 0, measured: coverage.sufficient, occurrences: coverage.occurrences,
    outcomes: affectedOutcomes, median: measure(medianMs), worst: measure(worstMs) });

type JoinedPolicy = {
  project(thread: string, runs: List<JoinedRun>, spans: List<JoinedSpan>, attempts: number, jobs: List<JoinedJob>): JoinedReplay;
  files(result: JoinedReplay): List<unknown>;
  costs(result: JoinedReplay): List<unknown>;
  findings(result: JoinedReplay): List<unknown>;
  patterns(result: JoinedReplay): List<unknown>;
  window_observations(window: Window, jobs: List<JoinedJob>): List<Observation>;
  priority_signals(window: Window, thread: string, runs: List<JoinedRun>, jobs: List<JoinedJob>): List<Signal>;
};

const joinedPolicy = async (scratch: string) => loadPolicy<JoinedPolicy>(
  await buildPolicy(scratch, new URL("./joined/bottleneck.bend", import.meta.url), "joined-bottleneck.mjs"));

export async function analyzeJoinedThread(path: string, scratch: string, instance: string, thread: string) {
  const policy = await joinedPolicy(scratch);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN");
    return replayJoinedThread(policy, thread, joinedInput(db, instance, thread));
  } finally {
    db.close();
  }
}

function joinedInput(db: DatabaseSync, instance: string, thread: string) {
  const key = [instance, thread] as const;
  if (!db.prepare("SELECT 1 FROM t3_threads WHERE instance=? AND thread_id=?").get(...key)) {
    throw Error("The selected T3 thread is absent from the evidence database");
  }
  const runs: JoinedRun[] = db.prepare(`
    SELECT run_id, requested_ms, started_ms, completed_ms FROM t3_runs
    WHERE instance=? AND thread_id=? ORDER BY run_id LIMIT 4097`).all(...key)
    .map((r) => ({ $: "Run", id: String(r.run_id), requested: String(r.requested_ms ?? ""),
      started: String(r.started_ms ?? ""), completed: String(r.completed_ms ?? "") }));
  const spans: JoinedSpan[] = db.prepare(`
    SELECT s.instance, s.trace_id, s.span_id, s.operation, s.start_ns, s.end_ns
    FROM t3_live_codex_links t
    JOIN t3_live_codex_span_links l ON (l.codex_instance,l.session_id)=(t.codex_instance,t.session_id)
    JOIN codex_otel_spans s ON (s.instance,s.trace_id,s.span_id)=(l.codex_instance,l.trace_id,l.span_id)
    WHERE t.t3_instance=? AND t.thread_id=? ORDER BY s.instance,s.trace_id,s.span_id LIMIT 4097`).all(...key)
    .map((s) => ({ $: "Span", id: JSON.stringify([s.instance,s.trace_id,s.span_id]), operation: String(s.operation),
      start: String(s.start_ns), end: String(s.end_ns) }));
  const attempts = `
    SELECT DISTINCT o.repository,o.run_id,o.attempt,o.head_sha
    FROM t3_ci_links l JOIN t3_ci_observations o USING (t3_instance,thread_id,observation_id)
    WHERE o.t3_instance=? AND o.thread_id=?
    ORDER BY o.repository,o.run_id,o.attempt,o.head_sha LIMIT 4097`;
  const hasGitHub = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='action_jobs'").get();
  const captured = hasGitHub ? db.prepare(`
    SELECT count(*) AS total FROM (${attempts}) o JOIN action_attempts a USING (repository,run_id,attempt,head_sha)`).get(...key) : undefined;
  const jobs: JoinedJob[] = hasGitHub ? db.prepare(`
    SELECT j.*, a.workflow_id FROM (${attempts}) o JOIN action_attempts a USING (repository,run_id,attempt,head_sha)
    JOIN action_jobs j USING (repository,run_id,attempt)
    ORDER BY j.repository,j.run_id,j.attempt,j.job_id LIMIT 4097`).all(...key)
    .map((j) => ({ $: "Job", id: JSON.stringify([j.repository,j.run_id,j.attempt,j.job_id]), label: String(j.label),
      status: String(j.status), conclusion: String(j.conclusion), prior: Boolean(j.prior_execution),
      created: String(j.created_at ?? ""), queued: String(j.queue_end ?? ""),
      started: String(j.execution_start ?? ""), completed: String(j.execution_end ?? ""),
      scope: `${j.repository} · workflow ${j.workflow_id} · ` })) : [];
  const attemptCount = Number(captured?.total ?? 0);
  if ([runs.length, spans.length, jobs.length, attemptCount].some((count) => count > 4096)) {
    throw Error("The selected thread exceeds the analysis record limit");
  }
  return { runs, spans, attemptCount, jobs };
}

function replayJoinedThread(policy: JoinedPolicy, thread: string, input: ReturnType<typeof joinedInput>) {
  const { runs, spans, attemptCount, jobs } = input;
  const replay = policy.project(thread, historyList(runs), historyList(spans), attemptCount, historyList(jobs));
  return {
    version: 1,
    coverage: { t3Runs: replay.runs, codexSpans: replay.spans, githubAttempts: replay.attempts,
      githubJobs: replay.jobs, carriedGitHubJobs: replay.carried },
    files: rows(policy.files(replay)), costs: rows(policy.costs(replay)),
    findings: rows(policy.findings(replay)), patterns: rows(policy.patterns(replay)),
  };
}

type ThreadKey = { $: "Target"; instance: string; thread: string };
type RunClock = { $: "RunClock"; requested: number; started: number; completed: number };
type RankedThread = { $: "Thread"; id: string; codex: number; ci: number; observations: List<Observation> };
type Batch = { $: "Batch"; thread: string; signals: List<Signal> };
type DashboardPolicy = {
  select_threads(input: List<ThreadKey>): List<ThreadKey>;
  report_window(range: string, to: number): Window;
  active(window: Window, created: number, runs: List<RunClock>): boolean;
  ranking(input: List<RankedThread>): List<unknown>;
  source_coverage(input: List<RankedThread>): unknown;
  top_priorities(batches: List<Batch>, delays: List<Delay>): List<unknown>;
  active_count(batches: List<Batch>): number;
  refresh_needed(stored: string, observed: string): boolean;
};

async function dashboardPolicy(scratch: string) {
  return loadPolicy<DashboardPolicy>(
    await buildPolicy(scratch, new URL("./joined/dashboard.bend", import.meta.url), "joined-dashboard.mjs"));
}

export async function analysisWindow(scratch: string, now: number, range = "24h") {
  return (await dashboardPolicy(scratch)).report_window(range, now);
}

export async function joinedTargets(path: string, scratch: string, instance: string) {
  const policy = await dashboardPolicy(scratch);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='t3_threads'").get()) return [];
    const keys = db.prepare(`SELECT instance,thread_id FROM t3_threads WHERE instance=?
      ORDER BY updated_ms DESC,thread_id LIMIT 50`).all(instance)
      .map((r): ThreadKey => ({ $: "Target", instance: String(r.instance), thread: String(r.thread_id) }));
    return rows(policy.select_threads(historyList(keys)));
  } finally {
    db.close();
  }
}

function activeKeys(db: DatabaseSync, policy: DashboardPolicy, window: Window, scope?: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='t3_threads'").get()) return [];
  const runs = db.prepare(`SELECT requested_ms,started_ms,completed_ms FROM t3_runs
    WHERE instance=? AND thread_id=? ORDER BY run_id`);
  const keys: ThreadKey[] = [];
  for (const row of db.prepare("SELECT instance,thread_id,created_ms FROM t3_threads WHERE (? IS NULL OR instance=?) ORDER BY created_ms DESC,instance,thread_id").iterate(scope ?? null, scope ?? null)) {
    const clocks = runs.all(row.instance, row.thread_id).map((r): RunClock => ({
      $: "RunClock", requested: Number(r.requested_ms), started: Number(r.started_ms), completed: Number(r.completed_ms),
    }));
    if (policy.active(window, Number(row.created_ms), historyList(clocks))) {
      keys.push({ $: "Target", instance: String(row.instance), thread: String(row.thread_id) });
    }
  }
  return keys;
}

type PublishedThread = {
  id: string; coverage: ReturnType<typeof replayJoinedThread>["coverage"]; costs: unknown[]; rules: string[];
};

const analysisId = (instance: string, thread: string) =>
  createHash("sha256").update(JSON.stringify([instance, thread])).digest("hex").slice(0, 24);

export async function publishJoinedAnalysis(input: string, output: string, scratch: string, asOf = Date.now(),
  readImpact?: (window: Window) => Promise<{ patterns: ImpactPattern[] }>, scope?: string) {
  const from = statSync(input, { bigint: true });
  const to = statSync(output, { bigint: true, throwIfNoEntry: false });
  if (from.dev === to?.dev && from.ino === to?.ino) throw Error("Use a separate analysis database");
  const [policy, summary] = await Promise.all([joinedPolicy(scratch), dashboardPolicy(scratch)]);
  const source = new DatabaseSync(input, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout=5000; BEGIN");
    const window = summary.report_window("24h", asOf);
    const week = summary.report_window("7d", asOf);
    const outcomeImpact = await readImpact?.(window) ?? null;
    const weeklyImpact = await readImpact?.(week);
    const revision = createHash("sha256").update(readFileSync(join(scratch, "joined-bottleneck.mjs")))
      .update(readFileSync(join(scratch, "joined-dashboard.mjs"))).digest("hex");
    closeSync(openSync(output, "a", 0o600));
    const db = new DatabaseSync(output);
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE IF NOT EXISTS analysis_summary (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS analysis_week (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS analysis_threads (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS analysis_fingerprints (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT;`);
      const previous = db.prepare("SELECT payload,fingerprint FROM analysis_threads JOIN analysis_fingerprints USING(id) WHERE id=?");
      db.exec("CREATE TEMP TABLE selected_analysis_threads (id TEXT PRIMARY KEY)");
      const selected = db.prepare("INSERT INTO selected_analysis_threads VALUES (?)");
      const store = db.prepare("INSERT OR REPLACE INTO analysis_threads VALUES (?,?)");
      const mark = db.prepare("INSERT OR REPLACE INTO analysis_fingerprints VALUES (?,?)");
      let recomputed = 0;
      const cohort = activeKeys(source, summary, window, scope).map(({ instance, thread }) => {
        const id = analysisId(instance, thread);
        selected.run(id);
        const evidence = joinedInput(source, instance, thread);
        const jobs = historyList(evidence.jobs);
        const observations = policy.window_observations(window, jobs);
        const signals = policy.priority_signals(window, id, historyList(evidence.runs), jobs);
        const rules = rows(observations).map(({ rule }) => rule);
        const fingerprint = createHash("sha256").update(revision).update(JSON.stringify([evidence, observations])).digest("hex");
        const saved = previous.get(id);
        if (saved && !summary.refresh_needed(String(saved.fingerprint), fingerprint)) {
          return { detail: JSON.parse(String(saved.payload)) as PublishedThread, observations, signals };
        }
        const result = replayJoinedThread(policy, thread, evidence);
        const detail = { id, coverage: result.coverage, costs: result.costs, rules };
        store.run(id, JSON.stringify(detail));
        mark.run(id, fingerprint);
        recomputed++;
        return { detail, observations, signals };
      });
      const projected = historyList(cohort.map(({ detail: { id, coverage }, observations }): RankedThread =>
        ({ $: "Thread", id, codex: coverage.codexSpans, ci: coverage.githubAttempts, observations })));
      const analyzedAt = new Date(asOf).toISOString();
      const batches = historyList(cohort.map(({ detail, signals }): Batch => ({ $: "Batch", thread: detail.id, signals })));
      const rank = (batches: List<Batch>, patterns: ImpactPattern[] = []) =>
        JSON.parse(JSON.stringify(rows(summary.top_priorities(batches, historyList(patterns.map(delayInput)))), (_key, value) =>
          value?.$ === "Some" ? value.value : value?.$ === "None" ? null : value));
      const latest = {
        version: 2, analyzedAt, window: { from: new Date(window.from).toISOString(), to: analyzedAt },
        coverage: summary.source_coverage(projected),
        outcomeImpact,
        priorities: rank(batches, outcomeImpact?.patterns),
        ranking: rows(summary.ranking(projected)),
        threads: cohort.map(({ detail: { id, coverage } }) => ({ id, coverage })),
      };
      db.exec(`DELETE FROM analysis_threads WHERE id NOT IN (SELECT id FROM selected_analysis_threads);
        DELETE FROM analysis_fingerprints WHERE id NOT IN (SELECT id FROM selected_analysis_threads);`);
      const weekly = historyList(activeKeys(source, summary, week, scope).map(({ instance, thread }): Batch => {
        const id = analysisId(instance, thread);
        const { runs, jobs } = joinedInput(source, instance, thread);
        return { $: "Batch", thread: id, signals: policy.priority_signals(week, id, historyList(runs), historyList(jobs)) };
      }));
      db.prepare("INSERT OR REPLACE INTO analysis_week VALUES(1,?)").run(JSON.stringify({
        range: "7d", window: { from: new Date(week.from).toISOString(), to: analyzedAt },
        coverage: { active: summary.active_count(weekly) }, priorities: rank(weekly, weeklyImpact?.patterns),
      }));
      db.prepare("INSERT OR REPLACE INTO analysis_summary VALUES(1,?)").run(JSON.stringify(latest));
      db.exec("COMMIT");
      return { analyzedThreads: cohort.length, recomputed };
    } finally {
      db.close();
    }
  } finally {
    source.close();
  }
}

async function joinedAnalysisCli() {
  const [option, job, database, instance, thread, ...rest] = process.argv.slice(2);
  if (option !== "--joined-bottlenecks" || !job || !database || !instance || !thread || rest.length) {
    throw Error("Usage: session-history.ts --joined-bottlenecks JOB_DIRECTORY DATABASE T3_INSTANCE THREAD_ID");
  }
  const scratch = mkdtempSync(join(job, "joined-analysis-"));
  try {
    console.log(JSON.stringify(await analyzeJoinedThread(database, scratch, instance, thread), null, 2));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) joinedAnalysisCli().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
