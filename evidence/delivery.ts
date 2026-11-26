import { DatabaseSync } from "node:sqlite";
import { writeSources, type Elapsed, type ReleaseOrder, type SourcePolicy } from "./sources.ts";

export type PullRequest = {
  repository: string; number: number; opened: number; merged: number | null;
  mergeSha: string | null; state: string; firstCommit: { sha: string; at: number } | null;
  firstCI?: { id: number; at: number } | null;
  firstReview: { id: number; at: number } | null; commitsComplete: boolean; reviewsComplete: boolean;
  updated: number;
};

export type ReleaseEvidence = {
  id: number; tag: string; source: string; tagMatches: boolean; channel: string;
  published: number | null; assetId: number | null; checked: number;
  http: number | null; bytes: number | null; accessible: boolean; ancestry: string; shipped: boolean;
  dispatch?: { id: number; at: number } | null;
};

function secondsFromElapsed(value: Elapsed): number | null {
  return value.$ === "Duration" ? (value.seconds * 1000 - value.subtract_ms) / 1000 : null;
}

export function saveDelivery(path: string, pr: PullRequest, release?: ReleaseEvidence) {
  writeSources(path, (db) => {
    const before = db.prepare("SELECT updated_at FROM github_prs WHERE repository=? AND pr_number=?")
      .get(pr.repository, pr.number);
    if (before && Number(before.updated_at) > pr.updated) throw Error("Older pull request snapshot");
    db.prepare("INSERT OR REPLACE INTO github_prs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      pr.repository, pr.number, pr.state, pr.opened, pr.merged, pr.mergeSha,
      pr.firstCommit?.at ?? null, pr.firstCommit?.sha ?? null, Number(pr.commitsComplete),
      pr.firstReview?.at ?? null, pr.firstReview?.id ?? null, Number(pr.reviewsComplete), pr.updated);
    if (pr.firstCI) {
      db.prepare("INSERT OR REPLACE INTO github_pr_ci VALUES (?, ?, ?, ?)")
        .run(pr.repository, pr.number, pr.firstCI.id, pr.firstCI.at);
    }
    if (!release) return;
    db.prepare(`INSERT INTO github_release_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`).run(
      pr.repository, pr.number, release.id, release.channel, release.checked, pr.mergeSha ?? "",
      release.source, release.tag, Number(release.tagMatches), release.published ?? 0, release.assetId ?? 0,
      release.http ?? 0, release.bytes ?? 0, Number(release.accessible), release.ancestry, Number(release.shipped),
      release.dispatch?.id ?? 0, release.dispatch?.at ?? 0);
  });
}

export function deliveryReport(path: string, policy: SourcePolicy) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    return readDelivery(db, policy);
  } finally {
    db.close();
  }
}

export function readDelivery(db: DatabaseSync, policy: SourcePolicy, repository?: string) {
  const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
  const pullRequests = db.prepare(`
    SELECT repository, pr_number, state, opened_at, merged_at, merge_sha,
           first_commit_at, first_review_at, commits_complete, reviews_complete
    FROM github_prs WHERE (? IS NULL OR repository = ?) ORDER BY repository, pr_number
  `).all(repository ?? null, repository ?? null);
  const current = table("github_release_observations") ? db.prepare(`
    SELECT channel, published_at, checked_at, ancestry, release_id, asset_id, shipped, merge_sha,
           source_sha, 1 AS observation_count, asset_id AS release_asset_id, dispatch_run, dispatched_at
    FROM github_release_observations WHERE repository = ? AND pr_number = ?
  `) : null;
  const legacy = table("github_release_proofs") ? db.prepare(`
    SELECT proof.channel, release.published_at, proof.checked_at, proof.ancestry, proof.release_id,
           asset.asset_id, proof.shipped, proof.merge_sha, release.source_sha,
           release.asset_id AS release_asset_id,
           (SELECT count(*) FROM github_asset_checks c WHERE c.repository = proof.repository
             AND c.release_id = proof.release_id AND c.channel = proof.channel) AS observation_count,
           NULL AS dispatch_run, NULL AS dispatched_at
    FROM github_release_proofs proof
    JOIN github_releases release USING (repository, release_id, channel)
    JOIN github_asset_checks asset USING (repository, release_id, channel, checked_at)
    WHERE proof.repository = ? AND proof.pr_number = ?
  `) : null;
  const owners = db.prepare(`
    SELECT owning, created_ms FROM t3_pr_links JOIN t3_threads USING (instance, thread_id)
    WHERE repository = ? AND pr_number = ?
  `);
  const ci = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='github_pr_ci'").get()
    ? db.prepare("SELECT run_id, started_at FROM github_pr_ci WHERE repository=? AND pr_number=?") : null;
  const none: ReleaseOrder = { $: "Release", published: 0xffffffff, checked: 0xffffffff, id: "", dispatch: 0, index: 0 };
  return pullRequests.flatMap(({ merge_sha, ...pr }) => {
    const key = [pr.repository, pr.pr_number] as const;
    const firstCI = ci?.get(...key);
    const groups = Map.groupBy([...(current?.all(...key) ?? []), ...(legacy?.all(...key) ?? [])], (release) => release.channel);
    const selected = [];
    for (const releases of groups.values()) {
      const first = releases.reduce((best, candidate, index) => policy.pick_release(best, {
        $: "Release", published: Number(candidate.published_at ?? 0), checked: Number(candidate.checked_at),
        id: [String(candidate.release_id).padStart(16, "0"), candidate.source_sha, candidate.asset_id].join(":"),
        dispatch: Number(candidate.dispatched_at ?? 0), index: index + 1,
      }, policy.release_eligible(candidate.shipped === 1, String(candidate.merge_sha ?? ""), String(merge_sha ?? ""),
        Number(candidate.published_at ?? 0), Number(candidate.checked_at), String(candidate.asset_id ?? "0"),
        String(candidate.release_asset_id ?? "0"), Number(candidate.observation_count))), none);
      if (first.index) selected.push(releases[first.index - 1]);
    }
    const owner = owners.all(...key).reduce((value, row) => {
      const ms = Number(row.created_ms);
      return policy.count_owner(value, row.owning === 1, Math.floor(ms / 1000), ms % 1000);
    }, { $: "Owners" as const, count: 0, s: 0, ms: 0 });
    return (selected.length ? selected : [null]).map((release) => {
      const opened = Number(pr.opened_at);
      const published = Number(release?.published_at ?? 0);
      const cycle = policy.thread_to_release(owner.count, owner.s, owner.ms, opened, published);
      return {
        ...pr, channel: release?.channel ?? null, published_at: release?.published_at ?? null,
        first_ci_at: firstCI?.started_at ?? null, first_ci_run: firstCI?.run_id ?? null,
        release_dispatched_at: release?.dispatched_at || null, release_run: release?.dispatch_run || null,
        checked_at: release?.checked_at ?? null, ancestry: release?.ancestry ?? null,
        release_id: release?.release_id ?? null, asset_id: release?.asset_id ?? null,
        owner_count: owner.count, thread_started_ms: owner.s ? owner.s * 1000 + owner.ms : null,
        pr_to_release_seconds: secondsFromElapsed(policy.pr_to_release(opened, published)),
        thread_to_release_seconds: secondsFromElapsed(cycle),
      };
    });
  });
}
