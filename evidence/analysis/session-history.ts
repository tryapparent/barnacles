import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { rows } from "../projection/timing.ts";
import type { List } from "../storage/sources.ts";

const historyList = <T>(values: T[]): List<T> =>
  values.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

type PlowRun = { $: "Run"; requested: number; started: number; completed: number; status: string };
type PlowThread = { $: "Thread"; created: number; updated: number; runs: List<PlowRun> };
type PlowSpan = { a: number; b: number; name: string };
type PlowTrace = { start: number; end: number; work: List<PlowSpan>; wait: List<PlowSpan>; errors: List<number> };
type PlowHistoryTime = { work: number; workflow: number };
type PlowPolicy = { project_feed(threads: List<PlowThread>): { observed: number; traces: List<PlowTrace>;
  history: { first: number; threads: List<PlowHistoryTime> } } };

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
    return { observed: projected.observed, history: {
      first: projected.history.first,
      threads: rows(projected.history.threads).map(({ work, workflow }) => ({ work, workflow })),
    }, traces: rows(projected.traces).map(trace => ({
      startUtcMs: trace.start, end: trace.end / 1000,
      work: spans(trace.work), wait: spans(trace.wait), errors: rows(trace.errors).map(at => at / 1000),
    })) };
  } finally {
    db.close();
  }
}

type JoinedRun = { $: "Run"; id: string; requested: string; started: string; completed: string };
type JoinedSpan = { $: "Span"; id: string; operation: string; start: string; end: string };
type JoinedJob = { $: "Job"; id: string; label: string; status: string; conclusion: string; prior: boolean;
  created: string; queued: string; started: string; completed: string };
type JoinedReplay = { runs: number; spans: number; attempts: number; jobs: number; carried: number };
type JoinedPolicy = {
  project(thread: string, runs: List<JoinedRun>, spans: List<JoinedSpan>, attempts: number, jobs: List<JoinedJob>): JoinedReplay;
  files(result: JoinedReplay): List<unknown>;
  costs(result: JoinedReplay): List<unknown>;
  findings(result: JoinedReplay): List<unknown>;
  patterns(result: JoinedReplay): List<unknown>;
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
    SELECT j.* FROM (${attempts}) o JOIN action_attempts a USING (repository,run_id,attempt,head_sha)
    JOIN action_jobs j USING (repository,run_id,attempt)
    ORDER BY j.repository,j.run_id,j.attempt,j.job_id LIMIT 4097`).all(...key)
    .map((j) => ({ $: "Job", id: JSON.stringify([j.repository,j.run_id,j.attempt,j.job_id]), label: String(j.label),
      status: String(j.status), conclusion: String(j.conclusion), prior: Boolean(j.prior_execution),
      created: String(j.created_at ?? ""), queued: String(j.queue_end ?? ""),
      started: String(j.execution_start ?? ""), completed: String(j.execution_end ?? "") })) : [];
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
type DashboardPolicy = {
  select_threads(input: List<ThreadKey>): List<ThreadKey>;
  ranking(input: List<{ $: "Thread"; id: string; rules: List<string> }>): List<unknown>;
  public_rule(finding: unknown): string;
  refresh_needed(stored: string, observed: string): boolean;
};

async function dashboardPolicy(scratch: string) {
  return loadPolicy<DashboardPolicy>(
    await buildPolicy(scratch, new URL("./joined/dashboard.bend", import.meta.url), "joined-dashboard.mjs"));
}

function candidateKeys(db: DatabaseSync, policy: DashboardPolicy, instance?: string) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='t3_threads'").get()) return { keys: [], bounded: false };
  const filter = instance === undefined ? `EXISTS (SELECT 1 FROM t3_live_codex_links l
    WHERE l.t3_instance=t.instance AND l.thread_id=t.thread_id) OR EXISTS (SELECT 1 FROM t3_ci_links c
    WHERE c.t3_instance=t.instance AND c.thread_id=t.thread_id)` : "t.instance=?";
  const keys = db.prepare(`SELECT instance,thread_id FROM t3_threads t WHERE ${filter}
    ORDER BY updated_ms DESC,instance,thread_id LIMIT 51`).all(...(instance === undefined ? [] : [instance]))
    .map((r): ThreadKey => ({ $: "Target", instance: String(r.instance), thread: String(r.thread_id) }));
  return { keys: rows(policy.select_threads(historyList(keys))), bounded: keys.length > 50 };
}

export async function backupAnalysisInput(input: string, output: string) {
  const db = new DatabaseSync(input, { readOnly: true });
  try {
    await backup(db, output);
  } finally {
    db.close();
  }
}

export async function joinedTargets(path: string, scratch: string, instance: string) {
  const policy = await dashboardPolicy(scratch);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return candidateKeys(db, policy, instance).keys;
  } finally {
    db.close();
  }
}

type PublishedThread = {
  id: string; coverage: ReturnType<typeof replayJoinedThread>["coverage"]; costs: unknown[]; rules: string[];
};

export async function publishJoinedAnalysis(input: string, output: string, scratch: string) {
  const from = statSync(input, { bigint: true });
  const to = statSync(output, { bigint: true, throwIfNoEntry: false });
  if (from.dev === to?.dev && from.ino === to?.ino) throw Error("Use a separate analysis database");
  const [policy, summary] = await Promise.all([joinedPolicy(scratch), dashboardPolicy(scratch)]);
  const source = new DatabaseSync(input, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout=5000; BEGIN");
    const { keys, bounded } = candidateKeys(source, summary);
    const revision = createHash("sha256").update(readFileSync(join(scratch, "joined-bottleneck.mjs")))
      .update(readFileSync(join(scratch, "joined-dashboard.mjs"))).digest("hex");
    closeSync(openSync(output, "a", 0o600));
    const db = new DatabaseSync(output);
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      db.exec(`CREATE TABLE IF NOT EXISTS analysis_summary (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS analysis_threads (id TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS analysis_fingerprints (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT;`);
      const previous = db.prepare("SELECT payload,fingerprint FROM analysis_threads JOIN analysis_fingerprints USING(id) WHERE id=?");
      db.exec("CREATE TEMP TABLE selected_analysis_threads (id TEXT PRIMARY KEY)");
      const selected = db.prepare("INSERT INTO selected_analysis_threads VALUES (?)");
      const store = db.prepare("INSERT OR REPLACE INTO analysis_threads VALUES (?,?)");
      const mark = db.prepare("INSERT OR REPLACE INTO analysis_fingerprints VALUES (?,?)");
      let recomputed = 0;
      const details = keys.map(({ instance, thread }) => {
        const id = createHash("sha256").update(JSON.stringify([instance, thread])).digest("hex").slice(0, 24);
        selected.run(id);
        const evidence = joinedInput(source, instance, thread);
        const fingerprint = createHash("sha256").update(revision).update(JSON.stringify(evidence)).digest("hex");
        const saved = previous.get(id);
        if (saved && !summary.refresh_needed(String(saved.fingerprint), fingerprint)) {
          return JSON.parse(String(saved.payload)) as PublishedThread;
        }
        const result = replayJoinedThread(policy, thread, evidence);
        const detail = { id, coverage: result.coverage, costs: result.costs, rules: result.findings.map(summary.public_rule) };
        store.run(id, JSON.stringify(detail));
        mark.run(id, fingerprint);
        recomputed++;
        return detail;
      });
      const latest = {
        version: 1, analyzedAt: new Date().toISOString(), bounded,
        ranking: rows(summary.ranking(historyList(details.map(({ id, rules }) =>
          ({ $: "Thread", id, rules: historyList(rules) }))))),
        threads: details.map(({ id, coverage }) => ({ id, coverage })),
      };
      db.exec(`DELETE FROM analysis_threads WHERE id NOT IN (SELECT id FROM selected_analysis_threads);
        DELETE FROM analysis_fingerprints WHERE id NOT IN (SELECT id FROM selected_analysis_threads);`);
      db.prepare("INSERT OR REPLACE INTO analysis_summary VALUES(1,?)").run(JSON.stringify(latest));
      db.exec("COMMIT");
      return { analyzedThreads: details.length, recomputed, bounded };
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
