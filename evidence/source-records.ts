export type ThreadEvidence = {
  instance: string; id: string; created: number; updated: number; status: string; origin: string;
  settled: boolean;
  runs: { id: string; requested: number | null; started: number | null; completed: number | null; status: string }[];
  pullRequests: { repository: string; number: number; source: string; state: string; owning: boolean }[];
};

export type RolloutEvidence = {
  instance: string; session: string; lines: number; malformed: number; orphans: number;
  calls: { id: string; line: number; tool: string; start: number | null; end: number | null;
    async: boolean; asyncEnd: number | null; terminalCall: string | null; ambiguous: boolean }[];
};

export type PullRequest = {
  repository: string; number: number; opened: number; merged: number | null;
  mergeSha: string | null; state: string; firstCommit: { sha: string; at: number } | null;
  firstReview: { id: number; at: number } | null; commitsComplete: boolean; reviewsComplete: boolean;
  updated: number;
};

export type ReleaseEvidence = {
  id: number; tag: string; source: string; tagMatches: boolean; channel: string;
  published: number | null; assetId: number | null; checked: number;
  http: number | null; bytes: number | null; accessible: boolean; ancestry: string; shipped: boolean;
};
