import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { admissionPolicy, saveAttempt, saveAttempts, type ActionAttempt, type AdmissionPolicy } from "./actions.ts";
import { saveDelivery, type PullRequest, type ReleaseEvidence } from "../delivery/delivery.ts";
import { saveRejectedRollout, saveRollout, saveThread, writeSources, type List, type RolloutEvidence, type RolloutImport, type ThreadEvidence } from "./sources.ts";

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
  | { source: "t3-rollout"; rollout: RolloutEvidence; t3Instance: string; thread: string }
  | { source: "codex-rejected"; receipt: RolloutImport }
  | { source: "git-change-scan"; repository: string; report: ChangedCodeReport; inventory?: ChangedCodeFile[] }
  | { source: "t3"; thread: ThreadEvidence };

function saveChangedCode(database: string, repository: string, report: ChangedCodeReport, inventory?: ChangedCodeFile[]) {
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
    db.prepare("INSERT OR REPLACE INTO git_change_inventory VALUES (?, ?)").run(repository,
      inventory === undefined ? null : JSON.stringify(inventory));
  });
}

export function loadEvidence(database: string, batch: EvidenceBatch, policy: AdmissionPolicy) {
  switch (batch.source) {
    case "github-actions-window": return saveAttempts(database, batch.attempts, policy);
    case "codex-rejected": return saveRejectedRollout(database, batch.receipt);
    case "github-actions": return saveAttempt(database, batch.attempt, policy);
    case "github-delivery": return saveDelivery(database, batch.pullRequest, batch.release, policy);
    case "codex": return saveRollout(database, batch.rollout, policy);
    case "t3-rollout": {
      saveRollout(database, batch.rollout, policy);
      return writeSources(database, (db) => {
        db.prepare(`INSERT INTO t3_codex_links VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(batch.t3Instance, batch.thread, batch.rollout.instance, batch.rollout.session);
      });
    }
    case "git-change-scan": return saveChangedCode(database, batch.repository, batch.report, batch.inventory);
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
      table.get("github_pr_titles")
        ? `SELECT pr_number, merge_sha, updated_at, title FROM github_prs
           LEFT JOIN github_pr_titles USING (repository, pr_number) WHERE repository=?`
        : "SELECT pr_number, merge_sha, updated_at FROM github_prs WHERE repository=?",
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


type CodexSpan = {
  $: "NativeSpan"; trace_id: string; span_id: string; parent_id: string; operation: string;
  start_ns: string; end_ns: string; conversation: string; turn: string; call: string; status: number;
};

type CodexSpanEvent = {
  $: "NativeEvent"; event: string; at_ns: string; conversation: string; turn: string; call: string;
  duration_ms: string; success: string;
};

export type CodexOtelPolicy = {
  observe_span(trace: string, span: string, parent: string, operation: string, start: string, end: string,
    conversation: string, turn: string, call: string, status: number):
    { $: "UnrecognizedSpan" | "InvalidSpan" } | { $: "ObservedSpan"; fact: CodexSpan };
  observe_event(event: string, at: string, conversation: string, turn: string, call: string,
    duration: string, success: string):
    { $: "UnrecognizedEvent" | "InvalidEvent" } | { $: "ObservedEvent"; fact: CodexSpanEvent };
  admit_replay(saved: string, received: string): boolean;
};

export type CodexOtelFact = { span: CodexSpan; events: CodexSpanEvent[] };
export const codexOtelPolicy = new URL("./codex-otel.bend", import.meta.url);
export class CodexOtelConflict extends Error {}

export function saveCodexOtel(path: string, instance: string, facts: CodexOtelFact[], policy: CodexOtelPolicy) {
  writeSources(path, (db) => {
    const read = db.prepare("SELECT fingerprint FROM codex_otel_spans WHERE instance=? AND trace_id=? AND span_id=?");
    const insertSpan = db.prepare("INSERT INTO codex_otel_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEvent = db.prepare("INSERT INTO codex_otel_span_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const fact of facts) {
      const { span, events } = fact;
      const identity = [instance, span.trace_id, span.span_id] as const;
      const fingerprint = createHash("sha256").update(JSON.stringify(fact)).digest("hex");
      const previous = read.get(...identity);
      if (previous) {
        if (!policy.admit_replay(String(previous.fingerprint), fingerprint)) throw new CodexOtelConflict();
        continue;
      }
      insertSpan.run(...identity, span.parent_id || null, span.operation, span.start_ns, span.end_ns, span.status,
        span.conversation || null, span.turn || null, span.call || null, fingerprint);
      events.forEach((event, index) => insertEvent.run(...identity, index, event.event, event.at_ns, event.conversation || null,
        event.turn || null, event.call || null, event.duration_ms ? Number(event.duration_ms) : null,
        event.success ? Number(event.success === "true") : null));
    }
  });
}

export const sessionJoinPolicy = new URL("./session-join.bend", import.meta.url);

type JoinState = { $: "Linked" | "Missing" | "Conflict" };

export type NativeBinding = {
  $: "NativeBinding"; thread: string; reference: string; driver: string; native_driver: string; native_id: string; strength: string;
};

export type SessionJoinPolicy = {
  repository_name(value: string): string;
  choose_binding(thread: string, requested: string, refs: List<NativeBinding>):
    { $: "NoBinding" | "Ambiguous" } | { $: "Bound"; session_id: string; reference_id: string };
  exact_join(expected: string, captured: string): JoinState;
  ci_kind(kind: string): boolean;
  span_decision(session: string, observations: List<string>): JoinState;
};

export type SessionJoinInput = {
  t3Instance: string; threadId: string; codexInstance: string; sessionId: string; referenceId: string;
  ci?: { observationId: string; kind: string; repository: string; runId: number; attempt: number; sha: string };
};

export function joinSession(path: string, traces: string, input: SessionJoinInput,
  policy: SessionJoinPolicy, asList: (values: string[]) => List<string>) {
  const source = new DatabaseSync(traces, { readOnly: true });
  const { t3Instance, threadId, codexInstance, sessionId, referenceId, ci } = input;
  const threadKey = [t3Instance, threadId] as const;
  const sessionKey = [codexInstance, sessionId] as const;
  let acceptedSpans = 0;
  let conflictingSpans = 0;
  let ciStatus: "Linked" | "Missing" | "Conflict" | "Absent" = "Absent";
  try {
    source.exec("PRAGMA busy_timeout = 5000; BEGIN");
    const spans = source.prepare(`
      SELECT * FROM codex_otel_spans WHERE instance=?1 AND (conversation_id=?2 OR (trace_id, span_id) IN (
        SELECT trace_id, span_id FROM codex_otel_span_events WHERE instance=?1 AND conversation_id=?2))
      LIMIT 4097`).all(...sessionKey);
    if (spans.length > 4096) throw Error("Too many spans for one session join");
    const sourceEvents = source.prepare(
      "SELECT * FROM codex_otel_span_events WHERE instance=? AND trace_id=? AND span_id=? ORDER BY event_index");
    writeSources(path, (db) => {
      if (!db.prepare("SELECT 1 FROM t3_threads WHERE instance=? AND thread_id=?").get(...threadKey)) {
        throw Error("Import the T3 thread before joining a session");
      }
      const currentOwner = db.prepare("SELECT t3_instance, thread_id FROM t3_live_codex_links WHERE codex_instance=? AND session_id=?")
        .get(...sessionKey);
      const owner = currentOwner ? JSON.stringify([currentOwner.t3_instance, currentOwner.thread_id]) : "";
      if (policy.exact_join(JSON.stringify(threadKey), owner).$ === "Conflict") {
        throw Error("Codex session already bound to a different T3 thread");
      }
      db.prepare("INSERT INTO t3_live_codex_links VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(...sessionKey, ...threadKey, referenceId);
      const savedSpan = db.prepare("SELECT fingerprint FROM codex_otel_spans WHERE instance=? AND trace_id=? AND span_id=?");
      const insertSpan = db.prepare("INSERT INTO codex_otel_spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const insertEvent = db.prepare("INSERT INTO codex_otel_span_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const linkSpan = db.prepare("INSERT INTO t3_live_codex_span_links VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING");
      for (const span of spans) {
        const key = [span.instance, span.trace_id, span.span_id] as const;
        const events = sourceEvents.all(...key);
        const observations = [span, ...events].map((entry) => String(entry.conversation_id ?? ""));
        const decision = policy.span_decision(sessionId, asList(observations));
        if (decision.$ !== "Linked") {
          conflictingSpans += Number(decision.$ === "Conflict");
          continue;
        }
        const saved = savedSpan.get(...key);
        const replay = policy.exact_join(String(span.fingerprint), String(saved?.fingerprint ?? ""));
        if (replay.$ === "Conflict") throw Error("Conflicting Codex span replay");
        if (replay.$ === "Missing") {
          insertSpan.run(...key, span.parent_span_id, span.operation, span.start_ns, span.end_ns, span.status_code,
            span.conversation_id, span.turn_id, span.call_id, span.fingerprint);
          for (const event of events) {
            insertEvent.run(...key, event.event_index, event.event, event.observed_ns, event.conversation_id, event.turn_id,
              event.call_id, event.reported_duration_ms, event.success);
          }
        }
        linkSpan.run(...key, sessionId);
        acceptedSpans++;
      }
      if (!ci) return;
      if (!policy.ci_kind(ci.kind)) throw Error("Expected a CI query or watch observation");
      const key = [...threadKey, ci.observationId] as const;
      const identity = [ci.kind, ci.repository, ci.runId, ci.attempt, ci.sha] as const;
      const recorded = db.prepare(`
        SELECT kind, repository, run_id, attempt, head_sha FROM t3_ci_observations
        WHERE t3_instance=? AND thread_id=? AND observation_id=?`).get(...key);
      const replay = policy.exact_join(JSON.stringify(identity), recorded
        ? JSON.stringify([recorded.kind, recorded.repository, recorded.run_id, recorded.attempt, recorded.head_sha]) : "");
      if (replay.$ === "Conflict") throw Error("Conflicting CI observation replay");
      if (replay.$ === "Missing") db.prepare("INSERT INTO t3_ci_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(...key, ...identity);
      const attempts = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='action_attempts'").get();
      const captured = attempts ? db.prepare("SELECT head_sha FROM action_attempts WHERE repository=? AND run_id=? AND attempt=?")
        .get(ci.repository, ci.runId, ci.attempt) : undefined;
      ciStatus = policy.exact_join(ci.sha, String(captured?.head_sha ?? "")).$;
      if (ciStatus === "Linked") db.prepare("INSERT INTO t3_ci_links VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(...key);
      else db.prepare("DELETE FROM t3_ci_links WHERE t3_instance=? AND thread_id=? AND observation_id=?").run(...key);
    });
  } finally {
    source.close();
  }
  return { acceptedSpans, conflictingSpans, ci: ciStatus };
}
