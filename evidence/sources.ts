import { closeSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type Elapsed = { $: "Duration"; seconds: number; subtract_ms: number } | { $: "Unknown" };

export type Point = { $: "Time"; s: number; ms: number };
export type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
export type ShellCommand = { $: "Command"; name: string; args: List<string> };
export type ToolInvocation = { $: "Invocation"; receiver: string; method: string; commands: List<ShellCommand> };
export type CommandMix = { $: "NoMix" } | {
  $: "Mix"; file_count: number; git_count: number; build_count: number; push_count: number;
};
type CallRecord = { $: "Ignored"; orphans: number } | {
  $: "Observed"; orphans: number; line: number; tool: string; command: string; categories: string; start: Point; finish: Point;
  launched: boolean; ambiguous: boolean;
};
type CellFact = { $: "NoCell" } | { $: "Launch" | "Terminal"; key: string };
type CellLink = { $: "Unlinked" } | { $: "Linked"; owner: string; call_id: string; end: Point };
export type Milestone = { $: "Milestone"; id: string; at: number };
type Owners = { $: "Owners"; count: number; s: number; ms: number };
export type ReleaseOrder = { $: "Release"; published: number; checked: number; id: string; dispatch: number; index: number };

export type RolloutAdmission = {
  $: "Gate"; status: string; session: string; parent: string; boundary: number; inherited: number;
  unassigned: number; keep: boolean;
};

type RolloutQuality = {
  $: "Quality"; missing_start: number; missing_end: number; missing_async_end: number; ambiguous_calls: number;
  mix_candidates: number; mix_receipts: number; mixed_calls: number; mixed_without_receipt: number;
};

type RolloutClocks = { $: "Clocks"; first: Point; last: Point };

type DeliveryEndpoint = "thread_started" | "first_commit" | "pr_opened" | "first_ci" | "first_review" |
  "pr_merged" | "release_dispatched" | "published" | "access_checked";
type DeliveryStage = "thread_to_commit" | "commit_to_open" | "open_to_first_ci" | "first_ci_to_merge" |
  "merge_to_dispatch" | "dispatch_to_publication" | "open_to_merge" | "merge_to_publication" |
  "thread_to_publication" | "publication_to_access_check";
export type DeliveryClocks = { $: "DeliveryTimes" } & Record<DeliveryEndpoint, Point>;

export type SourcePolicy = {
  rollout_file_status(available: boolean, regular: boolean, empty: boolean, oversized: boolean): string;
  rollout_line(state: RolloutAdmission, meta: boolean, id: string, parent: string, fork: string, shared: string,
    boundary: number, line: number, ordinalOk: boolean, decoded: boolean): RolloutAdmission;
  rollout_status(state: RolloutAdmission, lines: number, completeRead: boolean): string;
  rollout_admitted(status: string): boolean;
  rollout_call_quality(state: RolloutQuality, start: Point, finish: Point, launched: boolean, asyncEnd: Point,
    ambiguous: boolean, categories: string, candidate: CommandMix, received: boolean): RolloutQuality;
  rollout_clock(clocks: RolloutClocks, at: Point): RolloutClocks;
  rollout_pairing_gaps(malformed: number, oversized: number, cutoff: number, unassigned: number): number;
  delivery_thread_link(ownerCount: number, linkCount: number, start: Point, opened: Point): string;
  proof_matches_merge(proofMerge: string, currentMerge: string): boolean;
  delivery_release_link(selected: boolean, hasProof: boolean, matchingMerge: boolean): string;
  delivery_endpoints(clocks: DeliveryClocks): { $: "Endpoints" } & Record<DeliveryEndpoint, string>;
  delivery_stages(clocks: DeliveryClocks, threadLink: string): { $: "Stages" } & Record<DeliveryStage, string>;
  delivery_thread_window(created: Point, windowStart: Point): string;
  reasoning(event: string, point: Point): boolean;
  model_wait_input(previous: string, envelope: string, kind: string, callId: string): string;
  tool(name: string, direct: List<ShellCommand>, wrapped: List<ToolInvocation>): unknown;
  command_mix(commands: List<ShellCommand>): CommandMix;
  keep_mix_receipt(seconds: number, exitCode: number, running: boolean, endSeen: boolean, ambiguous: boolean): boolean;
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
  release_eligible(shipped: boolean, proofMerge: string, currentMerge: string, published: number,
    checked: number, observedAsset: string, releaseAsset: string, observations: number): boolean;
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

export type ThreadEvidence = {
  instance: string; id: string; created: number; updated: number; status: string; origin: string;
  settled: boolean;
  runs: { id: string; requested: number | null; started: number | null; completed: number | null; status: string }[];
  pullRequests: { repository: string; number: number; source: string; state: string; owning: boolean }[];
};

export type RolloutImport = {
  instance: string; sourceKey: string; status: string; session: string | null;
  parent: string | null; historyStartOrdinal: number | null; fileBytes: number | null; readBytes: number; lines: number; inherited: number; unassigned: number;
  malformed: number; oversized: number; cutoffLines: number; cutoffBytes: number;
};

export type RolloutEvidence = {
  receipt?: RolloutImport;
  quality?: RolloutQuality & { first: number | null; last: number | null };
  instance: string; session: string; lines: number; malformed: number; orphans: number;
  markers: { line: number; at: number; resultCall?: string }[];
  calls: { id: string; line: number; tool: string; command: string | null; start: number | null; end: number | null;
    async: boolean; asyncEnd: number | null; terminalCall: string | null; ambiguous: boolean; categories?: string;
    mix?: Extract<CommandMix, { $: "Mix" }> & { seconds: number } }[];
};

export const sourcePolicy = new URL("./sources.bend", import.meta.url);

const schema = readFileSync(new URL("./sources.sql", import.meta.url), "utf8");

export function writeSources(path: string, action: (db: DatabaseSync) => void) {
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
  writeSources(path, (db) => {
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

function writeRolloutReceipt(db: DatabaseSync, receipt: RolloutImport) {
  db.prepare("INSERT OR REPLACE INTO codex_rollout_imports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    receipt.instance, receipt.sourceKey, receipt.status, receipt.session, receipt.parent, receipt.historyStartOrdinal,
    receipt.fileBytes, receipt.readBytes,
    receipt.lines, receipt.inherited, receipt.unassigned, receipt.malformed, receipt.oversized,
    receipt.cutoffLines, receipt.cutoffBytes);
}

export function saveRejectedRollout(path: string, receipt: RolloutImport) {
  writeSources(path, (db) => writeRolloutReceipt(db, receipt));
}

export function saveRollout(path: string, data: RolloutEvidence) {
  writeSources(path, (db) => {
    const key = [data.instance, data.session] as const;
    const previous = db.prepare("SELECT line_count FROM codex_rollouts WHERE instance=? AND session_id=?").get(...key);
    if (previous && Number(previous.line_count) > data.lines) throw Error("Shorter rollout snapshot");
    db.prepare(`INSERT INTO codex_rollouts VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instance, session_id) DO UPDATE SET line_count=excluded.line_count,
      malformed_count=excluded.malformed_count, orphan_count=excluded.orphan_count`).run(
      ...key, data.lines, data.malformed, data.orphans);
    db.prepare("DELETE FROM codex_rollout_quality WHERE instance=? AND session_id=?").run(...key);
    if (data.receipt && data.quality) {
      writeRolloutReceipt(db, data.receipt);
      const quality = data.quality;
      db.prepare("INSERT INTO codex_rollout_quality VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        ...key, data.receipt.sourceKey, quality.first, quality.last, quality.missing_start, quality.missing_end,
        quality.missing_async_end, quality.ambiguous_calls, quality.mix_candidates, quality.mix_receipts,
        quality.mixed_calls, quality.mixed_without_receipt);
    }
    db.prepare("DELETE FROM codex_commands WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_categories WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_command_mixes WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_calls WHERE instance=? AND session_id=?").run(...key);
    const calls = db.prepare("INSERT INTO codex_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const commands = db.prepare("INSERT INTO codex_commands VALUES (?, ?, ?, ?)");
    const categories = db.prepare("INSERT INTO codex_categories VALUES (?, ?, ?, ?)");
    const mixes = db.prepare("INSERT INTO codex_command_mixes VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const call of data.calls) {
      calls.run(...key, call.id, call.line, call.tool, call.start, call.end, Number(call.async),
        call.asyncEnd, call.terminalCall, Number(call.ambiguous));
      if (call.command) commands.run(...key, call.id, call.command);
      if (call.categories) categories.run(...key, call.id, call.categories);
      if (call.mix) mixes.run(...key, call.id, call.mix.file_count, call.mix.git_count,
        call.mix.build_count, call.mix.push_count, call.mix.seconds);
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

export function rolloutCoverage(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?");
    return {
      imports: table.get("codex_rollout_imports")
        ? db.prepare("SELECT * FROM codex_rollout_imports ORDER BY instance, source_key").all() : null,
      sessions: table.get("codex_rollout_quality")
        ? db.prepare(`SELECT quality.*, rollout.orphan_count FROM codex_rollout_quality quality
            JOIN codex_rollouts rollout USING (instance, session_id) ORDER BY instance, session_id`).all() : null,
    };
  } finally {
    db.close();
  }
}
