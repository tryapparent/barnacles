import { closeSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { requireAdmission, revision, snapshot, type AdmissionPolicy } from "./actions.ts";

export type Point = { $: "Time"; s: number; ms: number };
export type List<T> = { $: "Nil" } | { $: "Con"; head: T; tail: List<T> };
export type ShellCommand = { $: "Command"; name: string; args: List<string> };
export type ToolInvocation = {
  $: "Invocation"; receiver: string; method: string; commands: List<ShellCommand>; printed: boolean;
  exact: List<ShellCommand>; handle: string; read_only: boolean;
};
export type CommandMix = { $: "NoMix" } | {
  $: "Mix"; file_count: number; git_count: number; build_count: number; push_count: number;
};
export type CallRecord = { $: "Ignored"; orphans: number } | {
  $: "Observed"; orphans: number; line: number; tool: string; command: string; categories: string; start: Point; finish: Point;
  result_line: number; target: string; launched: boolean; ambiguous: boolean;
};
type CellFact = { $: "NoCell" } | { $: "Launch" | "Terminal"; key: string };
type CellLink = { $: "Unlinked" } | { $: "Linked"; owner: string; call_id: string; end: Point };
export type WatchIdentity = { $: "NoWatch" } | {
  $: "ExactWatch"; repository: string; run_id: string; head_sha: string; attempt: string;
};
export type ProcessReceipt = { $: "MissingReceipt" } | { $: "InvalidReceipt" } |
  { $: "RunningReceipt"; seconds: number; handle: string } | { $: "ExitReceipt"; seconds: number; code: number };
export type ProcessInput = { $: "NoProcess" } | { $: "LaunchProcess"; category: string; watch: WatchIdentity } |
  { $: "PollProcess"; handle: string } | { $: "UnresolvedProcess"; status: string; handle: string; potential_io: boolean };
type ProcessSlot = { $: "Vacant" } | { $: "Conflict" } | {
  $: "Live"; owner: string; category: string; watch: WatchIdentity; line: number; end: Point;
};
type ProcessFact = {
  $: "ProcessFact"; status: string; owner: string; category: string; watch: WatchIdentity; receipt: ProcessReceipt;
};
type WaitCell = { $: "NotWait" } | { $: "WaitCell"; status: string; owner: string };
type Observer = { $: "Observer"; session: string; launch: string };
type WatchPoll = { $: "Poll"; index: number; observer: Observer; start: Point; end: Point };
type IndexedOverlap = { first: number; second: number; start: Point; end: Point };
type ProcessObservation = {
  call: string; resultCall: string | null; resultLine: number | null; handle: string | null;
  fact: ProcessFact; observer: WatchIdentity; start: number | null; end: number | null;
};

export type Milestone = { $: "Milestone"; id: string; at: number };

export type RolloutAdmission = {
  $: "Gate";
  phase: { $: "AwaitingMetadata" | "SingleSource" | "ForkSource" | "InvalidMetadata" | "UnprovenFork" | "ConflictingMetadata" };
  session: string; parent: string; boundary: number; inherited: number; unassigned: number; keep: boolean;
};

type RolloutQuality = {
  $: "Quality"; missing_start: number; missing_end: number; missing_async_end: number; ambiguous_calls: number;
  mix_candidates: number; mix_receipts: number; mixed_calls: number; mixed_without_receipt: number;
};

type RolloutClocks = { $: "Clocks"; first: Point; last: Point };

export type SourcePolicy = {
  repository_name(value: string): string;
  rollout_admission(): RolloutAdmission;
  rollout_file_status(available: boolean, regular: boolean, empty: boolean, oversized: boolean): string;
  rollout_line(state: RolloutAdmission, meta: boolean, id: string, parent: string, fork: string, shared: string,
    boundary: number, line: number, ordinalOk: boolean, decoded: boolean): RolloutAdmission;
  rollout_status(state: RolloutAdmission, lines: number, completeRead: boolean): string;
  rollout_admitted(status: string): boolean;
  rollout_call_quality(state: RolloutQuality, start: Point, finish: Point, launched: boolean, asyncEnd: Point,
    ambiguous: boolean, categories: string, candidate: CommandMix, received: boolean): RolloutQuality;
  rollout_clock(clocks: RolloutClocks, at: Point): RolloutClocks;
  rollout_pairing_gaps(malformed: number, oversized: number, cutoff: number, unassigned: number): number;
  reasoning(event: string, point: Point): boolean;
  model_wait_input(previous: string, envelope: string, kind: string, callId: string): string;
  tool(name: string, direct: List<ShellCommand>, wrapped: List<ToolInvocation>): unknown;
  command_mix(commands: List<ShellCommand>): CommandMix;
  keep_mix_receipt(seconds: number, exitCode: number, running: boolean, endSeen: boolean, ambiguous: boolean): boolean;
  start_call(state: unknown, line: number, tool: unknown, start: Point, target: string): unknown;
  finish_call(state: unknown, line: number, end: Point, yielded: string, completed: boolean): unknown;
  cell_fact(id: string, state: unknown): CellFact;
  add_cell_fact(pair: unknown, fact: CellFact): unknown;
  cell_link(pair: unknown, clean: boolean): CellLink;
  wait_cell(state: unknown, pair: unknown, clean: boolean): WaitCell;
  clean_rollout(malformed: number, orphans: number): boolean;
  process_input(name: string, exact: List<ShellCommand>, wrapped: List<ToolInvocation>, handle: string,
    readOnly: boolean, observed: unknown): ProcessInput;
  process_receipt(handle: string, hasHandle: boolean, code: number, hasExit: boolean, seconds: number): ProcessReceipt;
  process_key(input: ProcessInput, receipt: ProcessReceipt): string;
  process_taint(input: ProcessInput, receipt: ProcessReceipt): string;
  process_barrier(input: ProcessInput, receipt: ProcessReceipt, handle: string, ambiguous: boolean): boolean;
  observed_slot(slot: ProcessSlot, barrier: number): ProcessSlot;
  process_result(input: ProcessInput, slot: ProcessSlot, receipt: ProcessReceipt, owner: string, startLine: number,
    start: Point, line: number, end: Point, valid: boolean): { slot: ProcessSlot; fact: ProcessFact };
  process_observer(fact: ProcessFact): WatchIdentity;
  valid_process_result(clean: boolean, ambiguous: boolean, start: Point, end: Point): boolean;
  watch_identity(repository: string, run: string, sha: string, attempt: string): WatchIdentity;
  time_order(first: Point, last: Point): boolean;
  watch_overlaps(polls: List<WatchPoll>): List<IndexedOverlap>;
  call_record(state: unknown): CallRecord;
  pick_milestone(best: Milestone, next: Milestone): Milestone;
  pick_review(best: Milestone, next: Milestone, opened: number): Milestone;
  pr_ci_start(event: string, status: string, conclusion: string, attempt: number, matched: boolean,
    opened: number, started: number, merged: number): boolean;
  publishing_run(event: string, conclusion: string, created: number, published: number, updated: number,
    sourceMatches: boolean, runMatches: boolean): boolean;
  commit_complete(expected: number, observed: number): boolean;
  keep_commit(complete: boolean, milestone: Milestone): boolean;
  interval_ms(startSecond: number, startMs: number, endSecond: number, endMs: number): boolean;
  origin(creator: string, creationSource: string): string;
  owns_pr(source: string): boolean;
  thread_status(status: string): string;
  link_source(source: string): string;
  link_state(state: string): string;
  merged_at(opened: number, merged: number, confirmed: boolean): number;
  linux_main_source(tag: string): string;
  poll_pr_needed(updated: number, stored: number): boolean;
  poll_attempt_needed(updated: number, stored: number, status: string): boolean;
  poll_release_source(tag: string, published: number, draft: boolean): string;
  poll_release_recorded(shipped: boolean, stored: string, source: string): boolean;
  linux_main_asset(state: string, name: string): boolean;
  may_probe(assetCount: number, published: number, publicRelease: boolean, tagMatches: boolean): boolean;
  same_revision(merge: string, release: string): boolean;
  proves_ancestry(base: string, mergeBase: string, expected: string, status: string): boolean;
  asset_access(status: number, bytes: number, rangeMatches: boolean): boolean;
  shipping(merged: number, published: number, checked: number, ancestry: boolean, access: boolean): boolean;
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
  waitAttribution?: {
    waits: { call: string; cell: string | null; status: string; owner: string | null }[];
    observations: ProcessObservation[];
  };
  calls: { id: string; line: number; tool: string; command: string | null; start: number | null; end: number | null;
    async: boolean; asyncEnd: number | null; terminalCall: string | null; ambiguous: boolean; categories?: string;
    mix?: Extract<CommandMix, { $: "Mix" }> & { seconds: number } }[];
};

export const sourcePolicy = new URL("../sources.bend", import.meta.url);

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

export function saveThread(path: string, data: ThreadEvidence, policy: AdmissionPolicy) {
  writeSources(path, (db) => {
    const key = [data.instance, data.id] as const;
    const before = db.prepare("SELECT updated_ms FROM t3_threads WHERE instance=? AND thread_id=?").get(...key);
    requireAdmission(policy.thread_admission(snapshot(before?.updated_ms as number | undefined), revision(data.updated)));
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

export function saveRollout(path: string, data: RolloutEvidence, policy: AdmissionPolicy) {
  writeSources(path, (db) => {
    const key = [data.instance, data.session] as const;
    const previous = db.prepare("SELECT line_count FROM codex_rollouts WHERE instance=? AND session_id=?").get(...key);
    requireAdmission(policy.rollout_admission(snapshot(previous?.line_count as number | undefined), revision(data.lines)));
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
    db.prepare("DELETE FROM codex_wait_attribution WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_process_receipts WHERE instance=? AND session_id=?").run(...key);
    db.prepare("DELETE FROM codex_wait_coverage WHERE instance=? AND session_id=?").run(...key);
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
    if (data.waitAttribution) {
      db.prepare("INSERT INTO codex_wait_coverage VALUES (?, ?)").run(...key);
      const waits = db.prepare("INSERT INTO codex_wait_attribution VALUES (?, ?, ?, ?, ?, ?)");
      for (const wait of data.waitAttribution.waits) waits.run(...key, wait.call, wait.cell, wait.status, wait.owner);
      const observations = db.prepare("INSERT INTO codex_process_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const { call, resultCall, resultLine, handle, fact, observer, start, end } of data.waitAttribution.observations) {
        const { receipt, watch } = fact;
        observations.run(...key, call, resultCall, resultLine, handle,
          receipt.$ === "RunningReceipt" ? receipt.handle : null, fact.status, fact.owner || null, fact.category || null,
          receipt.$, "seconds" in receipt ? receipt.seconds : null, receipt.$ === "ExitReceipt" ? receipt.code : null,
          watch.$ === "ExactWatch" ? watch.repository : null, watch.$ === "ExactWatch" ? watch.run_id : null,
          watch.$ === "ExactWatch" ? watch.head_sha : null, watch.$ === "ExactWatch" ? watch.attempt : null,
          observer.$ === "ExactWatch" ? start : null, observer.$ === "ExactWatch" ? end : null);
      }
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

function waitSchema(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='codex_wait_coverage'").get();
}

export function waitReport(path: string, session: string | null, call: string | null) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!waitSchema(db)) return { coverage: [], waits: [] };
    const coverage = db.prepare(`
      SELECT rollout.instance, rollout.session_id, line_count, malformed_count, orphan_count
      FROM codex_wait_coverage JOIN codex_rollouts rollout USING (instance, session_id)
      WHERE (? IS NULL OR rollout.session_id=?) ORDER BY rollout.instance, rollout.session_id`).all(session, session);
    const waits = db.prepare(`
      SELECT wait.*, envelope.source_line, envelope.started_ms, envelope.ended_ms,
        process.process_status, process.process_handle, process.process_launch_call_id, process.process_category,
        process.result_call_id, process.receipt_source_line, process.receipt_kind, process.receipt_handle, process.receipt_seconds,
        process.exit_code, process.repository, process.run_id, process.head_sha, process.attempt,
        process.poll_started_ms, process.poll_result_ms
      FROM codex_wait_attribution wait JOIN codex_calls envelope USING (instance, session_id, call_id)
      LEFT JOIN codex_process_receipts process ON (process.instance, process.session_id, process.call_id)
        = (wait.instance, wait.session_id, wait.cell_launch_call_id)
      WHERE (? IS NULL OR wait.session_id=?) AND (? IS NULL OR wait.call_id=?)
      ORDER BY wait.instance, wait.session_id, envelope.source_line`).all(session, session, call, call);
    return { coverage, waits };
  } finally {
    db.close();
  }
}

export function watchOverlaps(path: string, policy: SourcePolicy, workflow: Extract<WatchIdentity, { $: "ExactWatch" }>) {
  const db = new DatabaseSync(path, { readOnly: true });
  const point = (ms: number): Point => ({ $: "Time", s: Math.floor(ms / 1000), ms: ms % 1000 });
  const millis = ({ s, ms }: Point) => s * 1000 + ms;
  try {
    const observations = waitSchema(db) ? db.prepare(`
      SELECT instance, session_id, call_id, result_call_id, process_launch_call_id, poll_started_ms, poll_result_ms
      FROM codex_process_receipts
      WHERE repository=? AND run_id=? AND head_sha=? AND attempt=? AND poll_started_ms IS NOT NULL
      ORDER BY poll_started_ms, instance, session_id, call_id`)
      .all(workflow.repository, workflow.run_id, workflow.head_sha, workflow.attempt) : [];
    const intervals = observations.reduceRight<List<WatchPoll>>((tail, row, index) => ({
      $: "Con", tail, head: {
        $: "Poll", index, start: point(Number(row.poll_started_ms)), end: point(Number(row.poll_result_ms)),
        observer: { $: "Observer", session: String(row.session_id), launch: String(row.process_launch_call_id) },
      },
    }), { $: "Nil" });
    const overlaps = [];
    for (let sequence = policy.watch_overlaps(intervals); sequence.$ === "Con"; sequence = sequence.tail) {
      const { first, second, start, end } = sequence.head;
      overlaps.push({ first: observations[first], second: observations[second], started_ms: millis(start), ended_ms: millis(end) });
    }
    return { workflow, observations: observations.length, overlaps };
  } finally {
    db.close();
  }
}

export const processTimingPolicy = new URL("../process-timing.bend", import.meta.url);

type KernelEvent =
  | { $: "ProcessRoot" | "ProcessExit"; at: number; pid: number }
  | { $: "ProcessFork"; at: number; parent: number; pid: number }
  | { $: "ProcessExec"; at: number; pid: number; image: string };

type KernelSpan = { id: number; parent: number; depth: number; name: string; start: number; end: number; elapsed: number };
type KernelTrace = { duration: number; extent: number; closed: boolean; spans: List<KernelSpan>; faults: number; pending: number };
type CaptureRef = { $: "CaptureRef"; key: string; at: number };

export type KernelPolicy = {
  trace(events: List<KernelEvent>): KernelTrace;
  admission(faults: number, events: number, extent: number, quiet: boolean): boolean;
  binding(expectedLine: number, expectedStart: number, line: number, start: number, ambiguous: boolean): boolean;
  same_target(instance: string, session: string, call: string, savedInstance: string, savedSession: string,
    savedCall: string): boolean;
  capture_visible(at: number, cutoff: number): boolean;
  visible_captures(captures: List<CaptureRef>): List<CaptureRef>;
  probe(parent: number, owner: number, major: number, minor: number, inode: number): string;
};

export type KernelCapture = {
  capture: string; instance: string; session: string; call: string; line: number; start: number;
  events: List<KernelEvent>; count: number; quiet: boolean;
};

export function saveKernelCapture(path: string, input: KernelCapture, policy: KernelPolicy) {
  const trace = policy.trace(input.events);
  if (!policy.admission(trace.faults, input.count, trace.extent, input.quiet)) throw Error("Invalid or oversized kernel event capture");
  const spans: KernelSpan[] = [];
  for (let row = trace.spans; row.$ === "Con"; row = row.tail) {
    const { id, parent, depth, name, start, end, elapsed } = row.head;
    spans.push({ id, parent, depth, name, start, end, elapsed });
  }
  writeSources(path, (db) => {
    const key = [input.instance, input.session, input.call] as const;
    const call = db.prepare("SELECT source_line, started_ms, ambiguous FROM codex_calls WHERE instance=? AND session_id=? AND call_id=?")
      .get(...key);
    if (!policy.binding(input.line, input.start, Number(call?.source_line), Number(call?.started_ms), call?.ambiguous !== 0)) {
      throw Error("Capture binding does not match an unambiguous imported rollout call");
    }
    db.prepare(`
      INSERT INTO codex_kernel_captures VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(capture) DO NOTHING
    `).run(input.capture, ...key, input.line, input.start, JSON.stringify({
      durationMicros: trace.closed ? trace.duration : null,
      observedMicros: trace.extent, unfinished: trace.pending, spans,
    }));
    const saved = db.prepare("SELECT instance, session_id, call_id, source_line, started_ms FROM codex_kernel_captures WHERE capture=?")
      .get(input.capture);
    if (!saved || !policy.same_target(...key, String(saved.instance), String(saved.session_id), String(saved.call_id)) ||
        !policy.binding(input.line, input.start, Number(saved.source_line), Number(saved.started_ms), false)) {
      throw Error("Capture is already bound to a different rollout call");
    }
  });
  return { spans: spans.length, elapsedMicros: trace.closed ? trace.duration : null, unfinished: trace.pending };
}
