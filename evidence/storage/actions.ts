import { closeSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Revision = { $: "Revision"; high: number; low: number };
type Snapshot = { $: "NoSnapshot" } | { $: "Snapshot"; revision: Revision };
type AttemptRevision = { $: "AttemptRevision"; sha: string; status: string; updated: Revision; observed: Revision };
type PriorAttempt = { $: "None" } | { $: "Some"; value: AttemptRevision };
type Admission = { $: "Admit" } | { $: "Reject"; message: string };

export type AdmissionPolicy = {
  t3_rollout_matches(refs: unknown, session: string): boolean;
  thread_admission(previous: Snapshot, revision: Revision): Admission;
  rollout_admission(previous: Snapshot, revision: Revision): Admission;
  pr_admission(previous: Snapshot, revision: Revision): Admission;
  attempt_admission(previous: PriorAttempt, incoming: AttemptRevision): Admission;
};

export const admissionPolicy = new URL("./admission.bend", import.meta.url);

const ieee754 = new DataView(new ArrayBuffer(8));

export function revision(value: number): Revision {
  ieee754.setFloat64(0, Number(value) + 0);
  return { $: "Revision", high: ieee754.getUint32(0), low: ieee754.getUint32(4) };
}

export function snapshot(value: number | undefined): Snapshot {
  return value === undefined ? { $: "NoSnapshot" } : { $: "Snapshot", revision: revision(value) };
}

export function requireAdmission(admission: Admission) {
  if (admission.$ === "Reject") throw Error(admission.message);
}

export type AttemptIdentity = { repository: string; runId: number; attempt: number; sha: string };

type ActionStep = {
  number: number; label: string; status: string; conclusion: string;
  start: number | null; end: number | null;
};

type ActionJob = {
  id: number; label: string; status: string; conclusion: string; created: number | null;
  priorExecution: boolean; queueEnd: number | null; executionStart: number | null;
  executionEnd: number | null; steps: ActionStep[];
};

export type ActionAttempt = AttemptIdentity & {
  workflowId: number; status: string; conclusion: string;
  createdAt: number | null; startedAt: number | null; sourceUpdated: number;
  observedAt: number; jobs: ActionJob[];
};


const schema = readFileSync(new URL("./actions.sql", import.meta.url), "utf8");

export function saveAttempt(path: string, attempt: ActionAttempt, policy: AdmissionPolicy) {
  saveAttempts(path, [attempt], policy);
}

export function saveAttempts(path: string, attempts: ActionAttempt[], policy: AdmissionPolicy) {
  closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    db.exec(schema);
    for (const attempt of attempts) replaceAttempt(db, attempt, policy);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function replaceAttempt(db: DatabaseSync, attempt: ActionAttempt, policy: AdmissionPolicy) {
  const key = [attempt.repository, attempt.runId, attempt.attempt] as const;
  const previous = db.prepare(
    "SELECT head_sha, status, source_updated, observed_at FROM action_attempts WHERE repository=? AND run_id=? AND attempt=?",
  ).get(...key);
  const prior: PriorAttempt = previous ? { $: "Some", value: { $: "AttemptRevision",
    sha: String(previous.head_sha), status: String(previous.status),
    updated: revision(Number(previous.source_updated)), observed: revision(Number(previous.observed_at)),
  } } : { $: "None" };
  requireAdmission(policy.attempt_admission(prior, { $: "AttemptRevision", sha: attempt.sha, status: attempt.status,
    updated: revision(attempt.sourceUpdated), observed: revision(attempt.observedAt) }));
  db.prepare("DELETE FROM action_attempts WHERE repository=? AND run_id=? AND attempt=?").run(...key);
  db.prepare("INSERT INTO action_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    ...key, attempt.sha, attempt.workflowId, attempt.status, attempt.conclusion,
    attempt.createdAt, attempt.startedAt, attempt.sourceUpdated, attempt.observedAt, attempt.jobs.length,
  );
  const jobRow = db.prepare("INSERT INTO action_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const stepRow = db.prepare("INSERT INTO action_steps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const job of attempt.jobs) {
    jobRow.run(...key, job.id, job.label, job.status, job.conclusion,
      job.created, Number(job.priorExecution), job.queueEnd, job.executionStart, job.executionEnd);
    for (const step of job.steps) {
      stepRow.run(...key, job.id, step.number, step.label, step.status, step.conclusion, step.start, step.end);
    }
  }
}

export type HistoryProgress = {
  $: "Progress"; position: number; total: number; revision: string; status: string;
};

export type HistoryFact = {
  $: "Fact"; position: number; id: string; kind: string; status: string; seconds: number; millis: number;
};

export type T3Command = {
  $: "Command"; id: string; thread: string; run: string; provider_thread: string; provider_turn: string;
  native_item: string; status: string; exit_code: string; started: string; completed: string; updated: string;
};

export function openT3History(path: string, instance: string,
  replay: (saved: number, incoming: number, previous: string, next: string) => { $: "Write" | "Ignore" | "Conflict" }) {
  closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS t3_history_progress (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, cursor TEXT NOT NULL,
        PRIMARY KEY (instance, thread_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS t3_history_rotation (
        instance TEXT PRIMARY KEY, last_thread_id TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS t3_history_commands (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, item_id TEXT NOT NULL, snapshot_sequence INTEGER NOT NULL,
        run_id TEXT, provider_thread_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, native_item_id TEXT NOT NULL,
        status TEXT NOT NULL, exit_code INTEGER, t3_started_ms INTEGER, t3_completed_ms INTEGER, t3_updated_ms INTEGER,
        PRIMARY KEY (instance, thread_id, item_id)
      ) STRICT, WITHOUT ROWID;
    `);
    const cursor = db.prepare("SELECT cursor FROM t3_history_progress WHERE instance=? AND thread_id=?");
    db.prepare("INSERT OR IGNORE INTO t3_history_rotation VALUES (?, '')").run(instance);
    const rotation = db.prepare("SELECT last_thread_id FROM t3_history_rotation WHERE instance=?");
    const advance = db.prepare("UPDATE t3_history_rotation SET last_thread_id=? WHERE instance=? AND last_thread_id=?");
    const progress = db.prepare("INSERT INTO t3_history_progress VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET cursor=excluded.cursor");
    const read = db.prepare(`SELECT snapshot_sequence, run_id, provider_thread_id, provider_turn_id, native_item_id,
      status, exit_code, t3_started_ms, t3_completed_ms, t3_updated_ms
      FROM t3_history_commands WHERE instance=? AND thread_id=? AND item_id=?`);
    read.setReturnArrays(true);
    const save = db.prepare(`INSERT INTO t3_history_commands VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET snapshot_sequence=excluded.snapshot_sequence, run_id=excluded.run_id,
      provider_thread_id=excluded.provider_thread_id, provider_turn_id=excluded.provider_turn_id,
      native_item_id=excluded.native_item_id, status=excluded.status, exit_code=excluded.exit_code,
      t3_started_ms=excluded.t3_started_ms, t3_completed_ms=excluded.t3_completed_ms, t3_updated_ms=excluded.t3_updated_ms`);
    const readCursor = (thread: string) => String(cursor.get(instance, thread)?.cursor ?? "");
    return {
      cursor: readCursor,
      rotation: () => String(rotation.get(instance)!.last_thread_id),
      advance: (expected: string, thread: string) => advance.run(thread, instance, expected).changes > 0,
      commit(thread: string, expected: string, next: string, sequence: number, commands: T3Command[]) {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (readCursor(thread) !== expected) throw Error("T3 history cursor changed during capture");
          for (const item of commands) {
            const key = [instance, thread, item.id] as const;
            const values = [item.run || null, item.provider_thread, item.provider_turn, item.native_item, item.status,
              item.exit_code === "" ? null : Number(item.exit_code), Number(item.started) || null,
              Number(item.completed) || null, Number(item.updated) || null];
            const previous = read.get(...key) as unknown[] | undefined;
            const outcome = previous ? replay(Number(previous[0]), sequence, JSON.stringify(previous.slice(1)), JSON.stringify(values)).$ : "Write";
            if (outcome === "Conflict") throw Error("Conflicting T3 command at the same snapshot sequence");
            if (outcome === "Write") save.run(...key, sequence, ...values);
          }
          progress.run(instance, thread, next);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}


export function openHistory(path: string, source: string, repository: string, targets: string[]) {
  closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path);

  function transaction<T>(write: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  try {
    db.exec("PRAGMA busy_timeout = 1000");
    transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS history_progress (
          source TEXT NOT NULL, repository TEXT NOT NULL, target TEXT NOT NULL,
          generation INTEGER NOT NULL, position INTEGER NOT NULL, total INTEGER NOT NULL,
          revision TEXT NOT NULL, status TEXT NOT NULL,
          PRIMARY KEY (source, repository, target)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS history_t3_activity (
          environment TEXT NOT NULL, thread TEXT NOT NULL, position INTEGER NOT NULL,
          item TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, updated_at_ms INTEGER,
          PRIMARY KEY (environment, thread, position, item),
          UNIQUE (environment, thread, position), UNIQUE (environment, thread, item)
        ) STRICT;
      `);
      const seed = db.prepare("INSERT OR IGNORE INTO history_progress VALUES (?, ?, ?, 0, 0, 0, '', 'pending')");
      for (const target of targets) seed.run(source, repository, target);
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const read = db.prepare("SELECT generation, position, total, revision, status FROM history_progress WHERE source=? AND repository=? AND target=?");
  const update = db.prepare(`
    UPDATE history_progress SET generation=generation+1, position=?, total=?, revision=?, status=?
    WHERE source=? AND repository=? AND target=? AND generation=?
  `);
  return {
    read(target: string) {
      const row = read.get(source, repository, target)!;
      return {
        generation: Number(row.generation),
        progress: { $: "Progress", position: Number(row.position), total: Number(row.total),
          revision: String(row.revision), status: String(row.status) } satisfies HistoryProgress,
      };
    },
    commit(target: string, generation: number, progress: HistoryProgress,
      change?: { attempt: ActionAttempt; admission: AdmissionPolicy } | {
        environment: string; thread: string; facts: Iterable<HistoryFact>;
      }) {
      return transaction(() => {
        const { position, total, revision, status } = progress;
        if (!update.run(position, total, revision, status, source, repository, target, generation).changes) return false;
        if (change && "attempt" in change) {
          db.exec(schema);
          replaceAttempt(db, change.attempt, change.admission);
        }
        if (change && "facts" in change) {
          const insert = db.prepare("INSERT INTO history_t3_activity VALUES (?, ?, ?, ?, ?, ?, ?)");
          for (const fact of change.facts) insert.run(change.environment, change.thread, fact.position - 1,
            fact.id, fact.kind, fact.status, fact.seconds ? fact.seconds * 1000 + fact.millis : null);
        }
        return true;
      });
    },
    close: () => db.close(),
  };
}
