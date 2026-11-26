import { closeSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Revision = { $: "Revision"; high: number; low: number };
type Snapshot = { $: "NoSnapshot" } | { $: "Snapshot"; revision: Revision };
type AttemptRevision = { $: "AttemptRevision"; sha: string; status: string; updated: Revision; observed: Revision };
type PriorAttempt = { $: "None" } | { $: "Some"; value: AttemptRevision };
type Admission = { $: "Admit" } | { $: "Reject"; message: string };

export type AdmissionPolicy = {
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
