import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { admissionPolicy, saveAttempt, saveAttempts, type ActionAttempt, type AdmissionPolicy } from "./actions.ts";
import { saveDelivery, type PullRequest, type ReleaseEvidence } from "../delivery/delivery.ts";
import { saveRejectedRollout, saveRollout, saveThread, writeSources, type RolloutEvidence, type RolloutImport, type ThreadEvidence } from "./sources.ts";

export type ChangedCodeFile = ({ path: string } | { pathBytesBase64: string }) & { commits: number };
type ChangedCodeReport = {
  revision: string;
  commitsScanned: number;
  hasMoreCommits: boolean;
  shallow: boolean;
  files: ChangedCodeFile[];
};

export { admissionPolicy, type AdmissionPolicy } from "./actions.ts";

export async function buildAdmissionPolicy(directory: string): Promise<AdmissionPolicy> {
  return loadPolicy(await buildPolicy(directory, admissionPolicy, "admission.mjs"));
}

export type EvidenceBatch =
  | { source: "github-actions"; attempt: ActionAttempt }
  | { source: "github-actions-window"; attempts: ActionAttempt[] }
  | { source: "github-delivery"; pullRequest: PullRequest; release?: ReleaseEvidence }
  | { source: "codex"; rollout: RolloutEvidence }
  | { source: "t3-rollout"; rollout: RolloutEvidence; t3Instance: string; thread: string }
  | { source: "codex-rejected"; receipt: RolloutImport }
  | { source: "git-change-scan"; repository: string; report: ChangedCodeReport; inventory?: ChangedCodeFile[] }
  | { source: "t3"; thread: ThreadEvidence };

function saveChangedCode(database: string, repository: string, report: ChangedCodeReport, inventory?: ChangedCodeFile[]) {
  writeSources(database, (db) => {
    db.prepare(`
      INSERT INTO git_change_scans VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repository) DO UPDATE SET revision=excluded.revision, commits_scanned=excluded.commits_scanned,
        truncated=excluded.truncated, shallow=excluded.shallow
    `).run(repository, report.revision, report.commitsScanned, Number(report.hasMoreCommits), Number(report.shallow));
    db.prepare("DELETE FROM git_changed_files WHERE repository = ?").run(repository);
    const insert = db.prepare("INSERT INTO git_changed_files VALUES (?, ?, ?, ?, ?)");
    report.files.forEach((file, rank) => insert.run(repository, rank, "path" in file ? file.path : null,
      "pathBytesBase64" in file ? file.pathBytesBase64 : null, file.commits));
    db.prepare("INSERT OR REPLACE INTO git_change_inventory VALUES (?, ?)").run(repository,
      inventory === undefined ? null : JSON.stringify(inventory));
  });
}

export function loadEvidence(database: string, batch: EvidenceBatch, policy: AdmissionPolicy) {
  switch (batch.source) {
    case "github-actions-window": return saveAttempts(database, batch.attempts, policy);
    case "codex-rejected": return saveRejectedRollout(database, batch.receipt);
    case "github-actions": return saveAttempt(database, batch.attempt, policy);
    case "github-delivery": return saveDelivery(database, batch.pullRequest, batch.release, policy);
    case "codex": return saveRollout(database, batch.rollout, policy);
    case "t3-rollout": {
      saveRollout(database, batch.rollout, policy);
      return writeSources(database, (db) => {
        db.prepare(`INSERT INTO t3_codex_links VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(batch.t3Instance, batch.thread, batch.rollout.instance, batch.rollout.session);
      });
    }
    case "git-change-scan": return saveChangedCode(database, batch.repository, batch.report, batch.inventory);
    case "t3": return saveThread(database, batch.thread, policy);
  }
}
export function githubPollRows(path: string, repository: string) {
  closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
    const prs = table.get("github_prs") ? db.prepare(
      table.get("github_pr_titles")
        ? `SELECT pr_number, merge_sha, updated_at, title FROM github_prs
           LEFT JOIN github_pr_titles USING (repository, pr_number) WHERE repository=?`
        : "SELECT pr_number, merge_sha, updated_at FROM github_prs WHERE repository=?",
    ).all(repository) : [];
    const attempts = table.get("action_attempts") ? db.prepare(
      "SELECT run_id, attempt, status, source_updated FROM action_attempts WHERE repository=?",
    ).all(repository) : [];
    const releases = table.get("github_release_observations") ? db.prepare(
      "SELECT pr_number, release_id, merge_sha, shipped FROM github_release_observations WHERE repository=?",
    ).all(repository) : [];
    return { prs, attempts, releases };
  } finally {
    db.close();
  }
}


type CodexSpan = {
  $: "NativeSpan"; trace_id: string; span_id: string; parent_id: string; operation: string;
  start_ns: string; end_ns: string; conversation: string; turn: string; call: string; status: number;
};

type CodexSpanEvent = {
  $: "NativeEvent"; event: string; at_ns: string; conversation: string; turn: string; call: string;
  duration_ms: string; success: string;
};

export type CodexOtelPolicy = {
  observe_span(trace: string, span: string, parent: string, operation: string, start: string, end: string,
    conversation: string, turn: string, call: string, status: number):
    { $: "UnrecognizedSpan" | "InvalidSpan" } | { $: "ObservedSpan"; fact: CodexSpan };
  observe_event(event: string, at: string, conversation: string, turn: string, call: string,
    duration: string, success: string):
    { $: "UnrecognizedEvent" | "InvalidEvent" } | { $: "ObservedEvent"; fact: CodexSpanEvent };
  admit_replay(saved: string, received: string): boolean;
};

export type CodexOtelFact = { span: CodexSpan; events: CodexSpanEvent[] };
export const codexOtelPolicy = new URL("./codex-otel.bend", import.meta.url);
export class CodexOtelConflict extends Error {}

export function saveCodexOtel(path: string, instance: string, facts: CodexOtelFact[], policy: CodexOtelPolicy) {
  writeSources(path, (db) => {
    const read = db.prepare("SELECT fingerprint FROM codex_otel_spans WHERE instance=? AND trace_id=? AND span_id=?");
    const insertSpan = db.prepare("INSERT INTO codex_otel_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEvent = db.prepare("INSERT INTO codex_otel_span_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const fact of facts) {
      const { span, events } = fact;
      const identity = [instance, span.trace_id, span.span_id] as const;
      const fingerprint = createHash("sha256").update(JSON.stringify(fact)).digest("hex");
      const previous = read.get(...identity);
      if (previous) {
        if (!policy.admit_replay(String(previous.fingerprint), fingerprint)) throw new CodexOtelConflict();
        continue;
      }
      insertSpan.run(...identity, span.parent_id || null, span.operation, span.start_ns, span.end_ns, span.status,
        span.conversation || null, span.turn || null, span.call || null, fingerprint);
      events.forEach((event, index) => insertEvent.run(...identity, index, event.event, event.at_ns, event.conversation || null,
        event.turn || null, event.call || null, event.duration_ms ? Number(event.duration_ms) : null,
        event.success ? Number(event.success === "true") : null));
    }
  });
}
