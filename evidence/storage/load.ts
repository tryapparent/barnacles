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
  | { source: "codex-rejected"; receipt: RolloutImport }
  | { source: "git-change-scan"; repository: string; report: ChangedCodeReport }
  | { source: "t3"; thread: ThreadEvidence };

function saveChangedCode(database: string, repository: string, report: ChangedCodeReport) {
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
  });
}

export function loadEvidence(database: string, batch: EvidenceBatch, policy: AdmissionPolicy) {
  switch (batch.source) {
    case "github-actions-window": return saveAttempts(database, batch.attempts, policy);
    case "codex-rejected": return saveRejectedRollout(database, batch.receipt);
    case "github-actions": return saveAttempt(database, batch.attempt, policy);
    case "github-delivery": return saveDelivery(database, batch.pullRequest, batch.release, policy);
    case "codex": return saveRollout(database, batch.rollout, policy);
    case "git-change-scan": return saveChangedCode(database, batch.repository, batch.report);
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
      "SELECT pr_number, merge_sha, updated_at FROM github_prs WHERE repository=?",
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
