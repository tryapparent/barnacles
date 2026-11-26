import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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

export function saveAttempt(path: string, attempt: ActionAttempt) {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    db.exec(schema);
    const key = [attempt.repository, attempt.runId, attempt.attempt] as const;
    const previous = db.prepare(
      "SELECT head_sha, status, source_updated, observed_at FROM action_attempts WHERE repository=? AND run_id=? AND attempt=?",
    ).get(...key);
    if (previous && (previous.head_sha !== attempt.sha ||
        Number(previous.source_updated) > attempt.sourceUpdated ||
        Number(previous.observed_at) > attempt.observedAt ||
        (previous.status === "completed" && attempt.status !== "completed"))) {
      throw new Error("Conflicting or older observation. Existing evidence was preserved.");
    }
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
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
