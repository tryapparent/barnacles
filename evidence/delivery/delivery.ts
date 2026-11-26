import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { requireAdmission, revision, snapshot, type AdmissionPolicy } from "../storage/actions.ts";
import { writeSources, type List, type Point } from "../storage/sources.ts";

type Elapsed = { $: "Duration"; seconds: number; subtract_ms: number } | { $: "Unknown" };
type Owners = { $: "Owners"; count: number; s: number; ms: number; title: string };
type Provenance = { $: "Observation" } | { $: "Legacy"; checks: List<number> };
type Proof = { $: "Proof"; channel: string; index: number; shipped: boolean; merge: string;
  published: number; checked: number; asset: string; release_asset: string; release_id: string;
  source: string; dispatch: number; provenance: Provenance };
type ReportRow = { $: "ReportRow"; index: number; pr: Elapsed; thread: Elapsed };

type DeliveryEndpoint = "thread_started" | "first_commit" | "pr_opened" | "first_ci" | "first_review" |
  "pr_merged" | "release_dispatched" | "published" | "access_checked";
type DeliveryStage = "thread_to_commit" | "commit_to_open" | "open_to_first_ci" | "first_ci_to_merge" |
  "merge_to_dispatch" | "dispatch_to_publication" | "open_to_merge" | "merge_to_publication" |
  "thread_to_publication" | "publication_to_access_check";
export type DeliveryClocks = { $: "DeliveryTimes" } & Record<DeliveryEndpoint, Point>;

export type DeliveryPolicy = {
  delivery_thread_link(ownerCount: number, linkCount: number, start: Point, opened: Point): string;
  proof_matches_merge(proofMerge: string, currentMerge: string): boolean;
  delivery_release_link(selected: boolean, hasProof: boolean, matchingMerge: boolean): string;
  delivery_endpoints(clocks: DeliveryClocks): { $: "Endpoints" } & Record<DeliveryEndpoint, string>;
  delivery_stages(clocks: DeliveryClocks, threadLink: string): { $: "Stages" } & Record<DeliveryStage, string>;
  delivery_thread_window(created: Point, windowStart: Point): string;
  empty_groups(): unknown;
  empty_owners(): Owners;
  observe_owner(owners: Owners, owning: boolean, seconds: number, millis: number, title: string): Owners;
  verified_thread_title(link: string, title: string): string;
  observe_release(groups: unknown, currentMerge: string, proof: Proof): unknown;
  report_rows(groups: unknown, opened: number, owners: Owners): List<ReportRow>;
};

export const deliveryPolicy = new URL("./report.bend", import.meta.url);

export type PullRequest = {
  repository: string; number: number; title?: string; opened: number; merged: number | null;
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

export function saveDelivery(path: string, pr: PullRequest, release: ReleaseEvidence | undefined, policy: AdmissionPolicy) {
  writeSources(path, (db) => {
    const before = db.prepare("SELECT updated_at FROM github_prs WHERE repository=? AND pr_number=?")
      .get(pr.repository, pr.number);
    requireAdmission(policy.pr_admission(snapshot(before?.updated_at as number | undefined), revision(pr.updated)));
    db.prepare("INSERT OR REPLACE INTO github_prs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      pr.repository, pr.number, pr.state, pr.opened, pr.merged, pr.mergeSha,
      pr.firstCommit?.at ?? null, pr.firstCommit?.sha ?? null, Number(pr.commitsComplete),
      pr.firstReview?.at ?? null, pr.firstReview?.id ?? null, Number(pr.reviewsComplete), pr.updated);
    if (pr.title) {
      db.prepare("INSERT OR REPLACE INTO github_pr_titles VALUES (?, ?, ?)").run(pr.repository, pr.number, pr.title);
    }
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

function point(ms: number): Point {
  return { $: "Time", s: Math.floor(ms / 1000), ms: ms % 1000 };
}

function deliveryCoverage(policy: DeliveryPolicy, clocks: DeliveryClocks, threadLink: string, releaseLink: string) {
  const { $: _endpointTag, ...endpoints } = policy.delivery_endpoints(clocks);
  const { $: _stageTag, ...stages } = policy.delivery_stages(clocks, threadLink);
  return {
    thread_link: threadLink,
    release_link: releaseLink,
    thread_clock_kind: "creation_to_milestone_elapsed",
    active_thread_work: "unknown",
    landed_ci_lineage: "unknown",
    rollout_delivery_lineage: "unknown",
    human_blocking: "unknown",
    critical_path: "unknown",
    endpoints,
    stages,
  };
}

export function deliveryReport(path: string, policy: DeliveryPolicy) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    return readDelivery(db, policy);
  } finally {
    db.close();
  }
}

export function readDelivery(db: DatabaseSync, policy: DeliveryPolicy, repository?: string) {
  const table = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
  const hasPrTitles = table("github_pr_titles");
  const hasThreadTitles = table("t3_thread_titles");
  const pullRequests = db.prepare(`
    SELECT repository, pr_number, state, opened_at, merged_at, merge_sha,
           first_commit_at, first_review_at, commits_complete, reviews_complete,
           ${hasPrTitles ? "title" : "NULL"} AS pr_title
    FROM github_prs
    ${hasPrTitles ? "LEFT JOIN github_pr_titles USING (repository, pr_number)" : ""}
    WHERE (? IS NULL OR repository = ?) ORDER BY repository, pr_number
  `).all(repository ?? null, repository ?? null);
  const current = table("github_release_observations") ? db.prepare(`
    SELECT channel, published_at, checked_at, ancestry, release_id, asset_id, shipped, merge_sha,
           source_sha, asset_id AS release_asset_id, dispatch_run, dispatched_at
    FROM github_release_observations WHERE repository = ? AND pr_number = ?
  `) : null;
  const legacy = table("github_release_proofs") ? {
    proofs: db.prepare(`
      SELECT proof.channel, release.published_at, proof.checked_at, proof.ancestry, proof.release_id,
             asset.asset_id, proof.shipped, proof.merge_sha, release.source_sha,
             release.asset_id AS release_asset_id,
             NULL AS dispatch_run, NULL AS dispatched_at
      FROM github_release_proofs proof
      JOIN github_releases release USING (repository, release_id, channel)
      JOIN github_asset_checks asset USING (repository, release_id, channel, checked_at)
      WHERE proof.repository = ? AND proof.pr_number = ?
    `),
    checks: db.prepare(`
      SELECT checked_at FROM github_asset_checks WHERE repository=? AND release_id=? AND channel=?
    `),
  } : null;
  const owners = db.prepare(`
    SELECT owning, created_ms, ${hasThreadTitles ? "title" : "NULL AS title"}
    FROM t3_pr_links JOIN t3_threads USING (instance, thread_id)
    ${hasThreadTitles ? "LEFT JOIN t3_thread_titles USING (instance, thread_id)" : ""}
    WHERE repository = ? AND pr_number = ?
  `);
  const ci = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='github_pr_ci'").get()
    ? db.prepare("SELECT run_id, started_at FROM github_pr_ci WHERE repository=? AND pr_number=?") : null;
  return pullRequests.flatMap(({ merge_sha, ...pr }) => {
    const key = [pr.repository, pr.pr_number] as const;
    const firstCI = ci?.get(...key);
    const candidates: Record<string, SQLOutputValue>[] = [];
    let groups = policy.empty_groups();
    const observe = (row: Record<string, SQLOutputValue>, provenance: Provenance) => {
      groups = policy.observe_release(groups, String(merge_sha ?? ""), {
        $: "Proof", index: candidates.push(row), channel: String(row.channel), shipped: row.shipped === 1,
        merge: String(row.merge_sha ?? ""), published: Number(row.published_at ?? 0), checked: Number(row.checked_at),
        asset: String(row.asset_id ?? "0"), release_asset: String(row.release_asset_id ?? "0"),
        release_id: String(row.release_id), source: String(row.source_sha ?? ""),
        dispatch: Number(row.dispatched_at ?? 0), provenance,
      });
    };
    for (const row of current?.all(...key) ?? []) observe(row, { $: "Observation" });
    if (legacy) for (const row of legacy.proofs.all(...key)) {
      let checks: List<number> = { $: "Nil" };
      for (const check of legacy.checks.all(pr.repository, row.release_id, row.channel)) {
        checks = { $: "Con", head: Number(check.checked_at), tail: checks };
      }
      observe(row, { $: "Legacy", checks });
    }
    let owner = policy.empty_owners();
    const links = owners.all(...key);
    for (const row of links) {
      const ms = Number(row.created_ms);
      owner = policy.observe_owner(owner, row.owning === 1, Math.floor(ms / 1000), ms % 1000, String(row.title ?? ""));
    }
    const rows = [];
    for (let row = policy.report_rows(groups, Number(pr.opened_at), owner); row.$ === "Con"; row = row.tail) {
      const release = candidates[row.head.index - 1];
      const opened = Number(pr.opened_at);
      const published = Number(release?.published_at ?? 0);
      const threadStart: Point = { $: "Time", s: owner.s, ms: owner.ms };
      const threadLink = policy.delivery_thread_link(owner.count, links.length, threadStart, point(opened * 1000));
      const releaseLink = policy.delivery_release_link(release !== undefined, candidates.length > 0,
        candidates.some((proof) => policy.proof_matches_merge(String(proof.merge_sha ?? ""), String(merge_sha ?? ""))));
      const coverage = deliveryCoverage(policy, {
        $: "DeliveryTimes",
        thread_started: threadStart,
        first_commit: point(Number(pr.first_commit_at ?? 0) * 1000),
        pr_opened: point(opened * 1000),
        first_ci: point(Number(firstCI?.started_at ?? 0) * 1000),
        first_review: point(Number(pr.first_review_at ?? 0) * 1000),
        pr_merged: point(Number(pr.merged_at ?? 0) * 1000),
        release_dispatched: point(Number(release?.dispatched_at ?? 0) * 1000),
        published: point(published * 1000),
        access_checked: point(Number(release?.checked_at ?? 0) * 1000),
      }, threadLink, releaseLink);
      rows.push({
        ...pr, thread_title: policy.verified_thread_title(threadLink, owner.title) || null,
        channel: release?.channel ?? null, published_at: release?.published_at ?? null,
        first_ci_at: firstCI?.started_at ?? null, first_ci_run: firstCI?.run_id ?? null,
        release_dispatched_at: release?.dispatched_at || null, release_run: release?.dispatch_run || null,
        checked_at: release?.checked_at ?? null, ancestry: release?.ancestry ?? null,
        release_id: release?.release_id ?? null, asset_id: release?.asset_id ?? null,
        coverage, owner_count: owner.count, thread_started_ms: owner.s ? owner.s * 1000 + owner.ms : null,
        pr_to_release_seconds: secondsFromElapsed(row.head.pr),
        thread_to_release_seconds: secondsFromElapsed(row.head.thread),
      });
    }
    return rows;
  });
}
