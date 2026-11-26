import { closeSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

type Elapsed = { $: "Duration"; seconds: number; subtract_ms: number } | { $: "Unknown" };

export type Point = { $: "Time"; s: number; ms: number };
export type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
export type ShellCommand = { $: "Command"; name: string; args: List<string> };
export type ToolInvocation = { $: "Invocation"; receiver: string; method: string; commands: List<ShellCommand> };
type CallRecord = { $: "Ignored"; orphans: number } | {
  $: "Observed"; orphans: number; line: number; tool: string; command: string; categories: string; start: Point; finish: Point;
  launched: boolean; ambiguous: boolean;
};
type CellFact = { $: "NoCell" } | { $: "Launch" | "Terminal"; key: string };
type CellLink = { $: "Unlinked" } | { $: "Linked"; owner: string; call_id: string; end: Point };
export type Milestone = { $: "Milestone"; id: string; at: number };
type Owners = { $: "Owners"; count: number; s: number; ms: number };
export type ReleaseOrder = { $: "Release"; published: number; checked: number; id: string; index: number };

export type SourcePolicy = {
  reasoning(event: string, point: Point): boolean;
  model_wait_input(previous: string, envelope: string, kind: string, callId: string): string;
  tool(name: string, direct: List<ShellCommand>, wrapped: List<ToolInvocation>): unknown;
  start_call(state: unknown, line: number, tool: unknown, start: Point, target: string): unknown;
  finish_call(state: unknown, end: Point, yielded: string, completed: boolean): unknown;
  cell_fact(id: string, state: unknown): CellFact;
  add_cell_fact(pair: unknown, fact: CellFact): unknown;
  cell_link(pair: unknown, malformed: number): CellLink;
  call_record(state: unknown): CallRecord;
  pick_milestone(best: Milestone, next: Milestone): Milestone;
  pick_review(best: Milestone, next: Milestone, opened: number): Milestone;
  pr_ci_start(event: string, status: string, conclusion: string, attempt: number, matched: boolean,
    opened: number, started: number, merged: number): boolean;
  publishing_run(event: string, conclusion: string, created: number, published: number, updated: number,
    sourceMatches: boolean, runMatches: boolean): boolean;
  commit_complete(expected: number, observed: number): boolean;
  keep_commit(complete: boolean, milestone: Milestone): boolean;
  pick_release(best: ReleaseOrder, next: ReleaseOrder, eligible: boolean): ReleaseOrder;
  count_owner(state: Owners, owning: boolean, s: number, ms: number): Owners;
  release_eligible(shipped: boolean, proofMerge: string, currentMerge: string): boolean;
  interval_ms(startSecond: number, startMs: number, endSecond: number, endMs: number): boolean;
  origin(creator: string, creationSource: string): string;
  owns_pr(source: string): boolean;
  thread_status(status: string): string;
  link_source(source: string): string;
  link_state(state: string): string;
  merged_at(opened: number, merged: number, confirmed: boolean): number;
  linux_main_source(tag: string): string;
  linux_main_asset(state: string, name: string): boolean;
  may_probe(assetCount: number, published: number, publicRelease: boolean, tagMatches: boolean): boolean;
  same_revision(merge: string, release: string): boolean;
  proves_ancestry(base: string, mergeBase: string, expected: string, status: string): boolean;
  asset_access(status: number, bytes: number, rangeMatches: boolean): boolean;
  shipping(merged: number, published: number, checked: number, ancestry: boolean, access: boolean): boolean;
  pr_to_release(opened: number, published: number): Elapsed;
  thread_to_release(threadCount: number, startedSecond: number, startedMs: number,
    opened: number, published: number): Elapsed;
};

function secondsFromElapsed(value: Elapsed): number | null {
  return value.$ === "Duration" ? (value.seconds * 1000 - value.subtract_ms) / 1000 : null;
}

export type ThreadEvidence = {
  instance: string; id: string; created: number; updated: number; status: string; origin: string;
  settled: boolean;
  runs: { id: string; requested: number | null; started: number | null; completed: number | null; status: string }[];
  pullRequests: { repository: string; number: number; source: string; state: string; owning: boolean }[];
};

export type RolloutEvidence = {
  instance: string; session: string; lines: number; malformed: number; orphans: number;
  markers: { line: number; at: number; resultCall?: string }[];
  calls: { id: string; line: number; tool: string; command: string | null; start: number | null; end: number | null;
    async: boolean; asyncEnd: number | null; terminalCall: string | null; ambiguous: boolean; categories?: string }[];
};

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
    db.prepare(`INSERT INTO codex_rollouts VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instance, session_id) DO UPDATE SET line_count=excluded.line_count,
      malformed_count=excluded.malformed_count, orphan_count=excluded.orphan_count`).run(
      ...key, data.lines, data.malformed, data.orphans);
    db.prepare("DELETE FROM codex_commands WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_categories WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_calls WHERE instance=? AND session_id=?").run(...key);
    const calls = db.prepare("INSERT INTO codex_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const commands = db.prepare("INSERT INTO codex_commands VALUES (?, ?, ?, ?)");
    const categories = db.prepare("INSERT INTO codex_categories VALUES (?, ?, ?, ?)");
    for (const call of data.calls) {
      calls.run(...key, call.id, call.line, call.tool, call.start, call.end, Number(call.async),
        call.asyncEnd, call.terminalCall, Number(call.ambiguous));
      if (call.command) commands.run(...key, call.id, call.command);
      if (call.categories) categories.run(...key, call.id, call.categories);
    }
    db.prepare("DELETE FROM codex_reasoning_inputs WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_reasoning WHERE instance=? AND session_id=?").run(...key);
    const markers = db.prepare("INSERT INTO codex_reasoning VALUES (?, ?, ?, ?)");
    const inputs = db.prepare("INSERT INTO codex_reasoning_inputs VALUES (?, ?, ?, ?)");
    for (const marker of data.markers) {
      markers.run(...key, marker.line, marker.at);
      if (marker.resultCall) inputs.run(...key, marker.line, marker.resultCall);
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
    if (pr.firstCI) {
      db.prepare("INSERT OR REPLACE INTO github_pr_ci VALUES (?, ?, ?, ?)")
        .run(pr.repository, pr.number, pr.firstCI.id, pr.firstCI.at);
    }
    if (!release) return;
    const key = [pr.repository, release.id, release.channel] as const;
    db.prepare("INSERT OR REPLACE INTO github_releases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      ...key, release.tag, release.source, Number(release.tagMatches), release.published, release.assetId);
    if (release.dispatch) {
      db.prepare("INSERT OR REPLACE INTO github_release_dispatch VALUES (?, ?, ?, ?, ?)")
        .run(...key, release.dispatch.id, release.dispatch.at);
    }
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
    const pullRequests = db.prepare(`
      SELECT repository, pr_number, state, opened_at, merged_at, merge_sha,
             first_commit_at, first_review_at, commits_complete, reviews_complete
      FROM github_prs ORDER BY repository, pr_number
    `).all();
    const candidates = db.prepare(`
      SELECT proof.channel, release.published_at, proof.checked_at, proof.ancestry, proof.release_id,
             asset.asset_id, proof.shipped, proof.merge_sha
      FROM github_release_proofs proof
      JOIN github_releases release USING (repository, release_id, channel)
      JOIN github_asset_checks asset USING (repository, release_id, channel, checked_at)
      WHERE proof.repository = ? AND proof.pr_number = ? ORDER BY proof.channel
    `);
    const owners = db.prepare(`
      SELECT owning, created_ms FROM t3_pr_links JOIN t3_threads USING (instance, thread_id)
      WHERE repository = ? AND pr_number = ?
    `);
    const ci = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='github_pr_ci'").get()
      ? db.prepare("SELECT run_id, started_at FROM github_pr_ci WHERE repository=? AND pr_number=?") : null;
    const dispatch = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='github_release_dispatch'").get()
      ? db.prepare("SELECT run_id, created_at FROM github_release_dispatch WHERE repository=? AND release_id=? AND channel=?") : null;
    const none: ReleaseOrder = { $: "Release", published: 0xffffffff, checked: 0xffffffff, id: "", index: 0 };
    return pullRequests.flatMap(({ merge_sha, ...pr }) => {
      const key = [pr.repository, pr.pr_number] as const;
      const firstCI = ci?.get(...key);
      const groups = Map.groupBy(candidates.all(...key), (release) => release.channel);
      const selected = [];
      for (const releases of groups.values()) {
        const first = releases.reduce((best, candidate, index) => policy.pick_release(best, {
          $: "Release", published: Number(candidate.published_at ?? 0), checked: Number(candidate.checked_at),
          id: String(candidate.release_id).padStart(16, "0"), index: index + 1,
        }, policy.release_eligible(candidate.shipped === 1, String(candidate.merge_sha ?? ""), String(merge_sha ?? ""))), none);
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
        const run = release && dispatch?.get(pr.repository, release.release_id, release.channel);
        return {
          ...pr, channel: release?.channel ?? null, published_at: release?.published_at ?? null,
          first_ci_at: firstCI?.started_at ?? null, first_ci_run: firstCI?.run_id ?? null,
          release_dispatched_at: run?.created_at ?? null, release_run: run?.run_id ?? null,
          checked_at: release?.checked_at ?? null, ancestry: release?.ancestry ?? null,
          release_id: release?.release_id ?? null, asset_id: release?.asset_id ?? null,
          owner_count: owner.count, thread_started_ms: owner.s ? owner.s * 1000 + owner.ms : null,
          pr_to_release_seconds: secondsFromElapsed(policy.pr_to_release(opened, published)),
          thread_to_release_seconds: secondsFromElapsed(cycle),
        };
      });
    });
  } finally {
    db.close();
  }
}
