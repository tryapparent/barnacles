import { saveAttempt, type ActionAttempt } from "./actions.ts";
import { saveDelivery, type PullRequest, type ReleaseEvidence } from "../delivery/delivery.ts";
import { saveRollout, saveThread, writeSources, type RolloutEvidence, type ThreadEvidence } from "./sources.ts";

export type ChangedCodeFile = ({ path: string } | { pathBytesBase64: string }) & { commits: number };
type ChangedCodeReport = {
  revision: string;
  commitsScanned: number;
  hasMoreCommits: boolean;
  shallow: boolean;
  files: ChangedCodeFile[];
};

export type EvidenceBatch =
  | { source: "github-actions"; attempt: ActionAttempt }
  | { source: "github-delivery"; pullRequest: PullRequest; release?: ReleaseEvidence }
  | { source: "codex"; rollout: RolloutEvidence }
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

export function loadEvidence(database: string, batch: EvidenceBatch) {
  switch (batch.source) {
    case "github-actions": return saveAttempt(database, batch.attempt);
    case "github-delivery": return saveDelivery(database, batch.pullRequest, batch.release);
    case "codex": return saveRollout(database, batch.rollout);
    case "git-change-scan": return saveChangedCode(database, batch.repository, batch.report);
    case "t3": return saveThread(database, batch.thread);
  }
}
