import { closeSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { secondsFromElapsed, type SourcePolicy } from "./source-policy.ts";
import type { PullRequest, ReleaseEvidence, RolloutEvidence, ThreadEvidence } from "./source-records.ts";

const schema = readFileSync(new URL("./sources.sql", import.meta.url), "utf8");

function write(path: string, action: (db: DatabaseSync) => void) {
  closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    db.exec(schema);
    action(db);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function saveThread(path: string, data: ThreadEvidence) {
  write(path, (db) => {
    const key = [data.instance, data.id] as const;
    const before = db.prepare("SELECT updated_ms FROM t3_threads WHERE instance=? AND thread_id=?").get(...key);
    if (before && Number(before.updated_ms) > data.updated) throw Error("Older T3 snapshot");
    db.prepare("INSERT OR REPLACE INTO t3_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      ...key, data.created, data.updated, data.status, data.origin, Number(data.settled), data.runs.length);
    const runs = db.prepare("INSERT OR REPLACE INTO t3_runs VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const run of data.runs) runs.run(...key, run.id, run.requested, run.started, run.completed, run.status);
    db.prepare("DELETE FROM t3_pr_links WHERE instance=? AND thread_id=?").run(...key);
    const links = db.prepare("INSERT INTO t3_pr_links VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const link of data.pullRequests) {
      links.run(...key, link.repository, link.number, link.source, link.state, Number(link.owning));
    }
  });
}

export function saveRollout(path: string, data: RolloutEvidence) {
  write(path, (db) => {
    const key = [data.instance, data.session] as const;
    const previous = db.prepare("SELECT line_count FROM codex_rollouts WHERE instance=? AND session_id=?").get(...key);
    if (previous && Number(previous.line_count) > data.lines) throw Error("Shorter rollout snapshot");
    db.prepare("INSERT OR REPLACE INTO codex_rollouts VALUES (?, ?, ?, ?, ?)").run(
      ...key, data.lines, data.malformed, data.orphans);
    db.prepare("DELETE FROM codex_calls WHERE instance=? AND session_id=?").run(...key);
    const calls = db.prepare("INSERT INTO codex_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const call of data.calls) {
      calls.run(...key, call.id, call.line, call.tool, call.start, call.end, Number(call.async),
        call.asyncEnd, call.terminalCall, Number(call.ambiguous));
    }
  });
}

export function saveDelivery(path: string, pr: PullRequest, release?: ReleaseEvidence) {
  write(path, (db) => {
    const before = db.prepare("SELECT updated_at FROM github_prs WHERE repository=? AND pr_number=?")
      .get(pr.repository, pr.number);
    if (before && Number(before.updated_at) > pr.updated) throw Error("Older pull request snapshot");
    db.prepare("INSERT OR REPLACE INTO github_prs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      pr.repository, pr.number, pr.state, pr.opened, pr.merged, pr.mergeSha,
      pr.firstCommit?.at ?? null, pr.firstCommit?.sha ?? null, Number(pr.commitsComplete),
      pr.firstReview?.at ?? null, pr.firstReview?.id ?? null, Number(pr.reviewsComplete), pr.updated);
    if (!release) return;
    const key = [pr.repository, release.id, release.channel] as const;
    db.prepare("INSERT OR REPLACE INTO github_releases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      ...key, release.tag, release.source, Number(release.tagMatches), release.published, release.assetId);
    db.prepare("INSERT OR REPLACE INTO github_asset_checks VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      ...key, release.checked, release.assetId, release.http, release.bytes, Number(release.accessible));
    db.prepare("INSERT OR REPLACE INTO github_release_proofs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      pr.repository, pr.number, release.id, release.channel, release.checked, pr.mergeSha,
      release.ancestry, Number(release.shipped));
  });
}

export function deliveryReport(path: string, policy: SourcePolicy) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare(`
      WITH owners AS (
        SELECT repository, pr_number, count(*) AS owner_count, min(created_ms) AS thread_started_ms
        FROM t3_pr_links JOIN t3_threads USING (instance, thread_id)
        WHERE owning = 1 GROUP BY repository, pr_number
      ), candidates AS (
        SELECT proof.repository, proof.pr_number, proof.channel, release.published_at,
               proof.checked_at, proof.ancestry, proof.release_id, asset.asset_id,
               row_number() OVER (
                 PARTITION BY proof.repository, proof.pr_number, proof.channel
                 ORDER BY release.published_at, proof.checked_at, release.release_id
               ) AS ord
        FROM github_release_proofs proof
        JOIN github_releases release USING (repository, release_id, channel)
        JOIN github_asset_checks asset USING (repository, release_id, channel, checked_at)
        JOIN github_prs pr ON pr.repository = proof.repository AND pr.pr_number = proof.pr_number
        WHERE proof.shipped = 1 AND proof.merge_sha = pr.merge_sha
      )
      SELECT pr.repository, pr.pr_number, pr.state, pr.opened_at, pr.merged_at,
             pr.first_commit_at, pr.first_review_at, pr.commits_complete, pr.reviews_complete,
             owners.owner_count, owners.thread_started_ms,
             candidate.channel, candidate.published_at, candidate.checked_at,
             candidate.ancestry, candidate.release_id, candidate.asset_id
      FROM github_prs pr
      LEFT JOIN owners USING (repository, pr_number)
      LEFT JOIN candidates candidate ON candidate.repository = pr.repository
        AND candidate.pr_number = pr.pr_number AND candidate.ord = 1
      ORDER BY pr.repository, pr.pr_number, candidate.channel
    `).all();
    return rows.map(({ owner_count, thread_started_ms, opened_at, published_at, ...row }) => {
      const started = Number(thread_started_ms ?? 0);
      const opened = Number(opened_at);
      const published = Number(published_at ?? 0);
      const ownerCount = Number(owner_count ?? 0);
      const cycle = policy.thread_to_release(ownerCount, Math.floor(started / 1000), started % 1000, opened, published);
      return { ...row, opened_at, published_at, owner_count: ownerCount,
        thread_started_ms: ownerCount === 1 ? started : null,
        pr_to_release_seconds: secondsFromElapsed(policy.pr_to_release(opened, published)),
        thread_to_release_seconds: secondsFromElapsed(cycle) };
    });
  } finally {
    db.close();
  }
}
