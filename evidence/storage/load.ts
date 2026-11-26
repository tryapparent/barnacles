import { saveAttempt, type ActionAttempt } from "./actions.ts";
import { saveDelivery, type PullRequest, type ReleaseEvidence } from "../delivery/delivery.ts";
import { saveRollout, saveThread, type RolloutEvidence, type ThreadEvidence } from "./sources.ts";

export type EvidenceBatch =
  | { source: "github-actions"; attempt: ActionAttempt }
  | { source: "github-delivery"; pullRequest: PullRequest; release?: ReleaseEvidence }
  | { source: "codex"; rollout: RolloutEvidence }
  | { source: "t3"; thread: ThreadEvidence };

export function loadEvidence(database: string, batch: EvidenceBatch) {
  switch (batch.source) {
    case "github-actions": return saveAttempt(database, batch.attempt);
    case "github-delivery": return saveDelivery(database, batch.pullRequest, batch.release);
    case "codex": return saveRollout(database, batch.rollout);
    case "t3": return saveThread(database, batch.thread);
  }
}
