import { DatabaseSync } from "node:sqlite";
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { rows } from "../projection/timing.ts";
import type { List } from "../storage/sources.ts";

type Optional<T> = { $: "None" } | { $: "Some"; value: T };
type HistoryEvent = { $: "HistoryEvent"; index: number; lane: number; start: number; end: Optional<number>;
  label: string; source: string; state: string; relation: string; clipped: boolean };
type HistorySignal = { $: "HistorySignal"; rule: string; thread: string; id: string; seconds: number; median: number; peers: number; event: Optional<number> };
type HistoryThread = { $: "HistoryThread"; id: string; sample: number; title: string; source: string;
  start: number; cutoff: number; rollout_count: number };
type HistoryEntry = { $: "HistoryEntry"; thread: HistoryThread; end: number; count: number; signals: number };
type HistoryLane = { $: "HistoryLane"; index: number; name: string; events: List<HistoryEvent> };
type HistoryProjection = { entry: HistoryEntry; lanes: List<HistoryLane>; signals: List<HistorySignal> };
type HistoryPolicy = {
  session_window_valid(start: number, cutoff: number, snapshot: number): boolean;
  project_session(thread: HistoryThread, events: List<HistoryEvent>, signals: List<HistorySignal>): HistoryProjection;
  order_sessions(entries: List<HistoryEntry>): List<HistoryEntry>;
};

const t3Source = /t3-thread:\/\/v2\/[a-f0-9-]{36}\/(?:[a-f0-9-]{36}|[a-z]+:[a-z]+:[a-f0-9]{64})(?=\)|$)/;
const githubSource = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:actions\/(?:runs|jobs)\/\d+(?:\/(?:attempts|job)\/\d+)?|pull\/\d+(?:#pullrequestreview-\d+)?|commit\/[a-f0-9]{40})$/;
const invalidStudy = () => Error("Invalid session study export. Use the frozen waterfall JSON and its matching replay.");
const studyRows = (value: unknown, limit: number): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) throw invalidStudy();
  return value;
};
const studyRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidStudy();
  return value as Record<string, unknown>;
};
const studyString = (value: unknown, limit: number): string => {
  if (typeof value !== "string" || value.length > limit) throw invalidStudy();
  return value;
};
const studyNumber = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalidStudy();
  return value;
};
const historyList = <T>(values: T[]): List<T> =>
  values.reduceRight<List<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

function studyMillis(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidStudy();
  return studyNumber(Math.round(value));
}

function studyEvent(raw: unknown, index: number): HistoryEvent {
  const [lane, start, end, label, source, state, relation, clipped] = studyRows(raw, 8);
  if (typeof clipped !== "boolean") throw invalidStudy();
  const ref = studyString(source, 512);
  const rolloutLine = /[.]jsonl(?:[.]zst)?:([1-9]\d*)$/.exec(ref);
  return { $: "HistoryEvent", index, lane: studyNumber(lane), start: studyMillis(start),
    end: end === null ? { $: "None" } : { $: "Some", value: studyMillis(end) },
    label: studyString(label, 512), source: githubSource.test(ref) || /^T3 position \d+$/.test(ref) ? ref : (rolloutLine ? "Rollout line " + rolloutLine[1] : ""),
    state: studyString(state, 128), relation: studyString(relation, 32), clipped };
}

function studySignal(raw: unknown): HistorySignal {
  const { thread, id, rule, seconds, median, peers } = studyRecord(raw);
  return { $: "HistorySignal", rule: studyString(rule, 128), thread: studyString(thread, 128),
    id: studyString(id, 256), seconds: studyNumber(seconds), median: studyNumber(median), peers: studyNumber(peers), event: { $: "None" } };
}

export async function writeSessionStudy(directory: string, capture: string, replay?: string) {
  const loadStudy = (path: string) => {
    const file = statSync(path);
    if (!file.isFile() || file.size > 64 * 1024 * 1024) throw invalidStudy();
    return studyRecord(JSON.parse(readFileSync(path, "utf8")));
  };
  const data = loadStudy(capture);
  const cutoff = studyNumber(data.cutoff, 8.64e15);
  const signals = historyList(replay ? studyRows(loadStudy(replay).findings, 20000).map(studySignal) : []);
  const staging = mkdtempSync(join(directory, ".session-study-"));
  try {
    const module = await buildPolicy(staging, new URL("./session-history.bend", import.meta.url), "session-study.mjs");
    const policy = await loadPolicy<HistoryPolicy>(module);
    const file = join(staging, "session-study.sqlite");
    closeSync(openSync(file, "wx", 0o600));
    const db = new DatabaseSync(file);
    try {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE study(cutoff INTEGER NOT NULL, replay INTEGER NOT NULL);
        CREATE TABLE histories(id TEXT PRIMARY KEY, sample INTEGER UNIQUE NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE sessions(rank INTEGER PRIMARY KEY, entry TEXT NOT NULL);`);
      db.prepare("INSERT INTO study VALUES (?, ?)").run(cutoff, Number(replay !== undefined));
      const storeHistory = db.prepare("INSERT INTO histories VALUES (?, ?, ?)");
      const storeEntry = db.prepare("INSERT INTO sessions VALUES (?, ?)");
      const entries = studyRows(data.threads, 1000).map((raw) => {
        const item = studyRecord(raw);
        const source = t3Source.exec(studyString(item.link, 1024));
        if (!source) throw invalidStudy();
        const thread: HistoryThread = { $: "HistoryThread", id: createHash("sha256").update(source[0]).digest("hex"), source: source[0],
          sample: studyNumber(item.i), title: studyString(item.title, 512), start: studyNumber(item.start, cutoff),
          cutoff: studyNumber(item.cutoff, cutoff), rollout_count: studyNumber(item.rollouts) };
        if (!policy.session_window_valid(thread.start, thread.cutoff, cutoff)) throw invalidStudy();
        const history = policy.project_session(thread, historyList(studyRows(item.events, 40000).map(studyEvent)), signals);
        storeHistory.run(thread.id, thread.sample, JSON.stringify({
          entry: history.entry,
          lanes: rows(history.lanes).map((lane) => ({ ...lane, events: rows(lane.events) })),
          signals: rows(history.signals),
        }));
        return history.entry;
      });
      rows(policy.order_sessions(historyList(entries))).forEach((entry, rank) => storeEntry.run(rank, JSON.stringify(entry)));
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    renameSync(file, join(directory, "session-study.sqlite"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function readSessionStudy(directory: string, session?: string) {
  const file = join(directory, "session-study.sqlite");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    if (!statSync(file, { throwIfNoEntry: false })) return { study: null, sessions: [], trace: null };
    throw error;
  }
  try {
    const metadata = db.prepare("SELECT * FROM study").get();
    if (!metadata) throw invalidStudy();
    const study = { cutoff: Number(metadata.cutoff), replay: metadata.replay === 1 };
    if (session !== undefined) {
      const row = db.prepare("SELECT payload FROM histories WHERE id=?").get(session);
      return { study, trace: row ? JSON.parse(String(row.payload)) : null };
    }
    const sessions = db.prepare("SELECT entry FROM sessions ORDER BY rank").all().map((row) => JSON.parse(String(row.entry)));
    return { study, sessions };
  } finally {
    db.close();
  }
}

type PlowRun = { $: "Run"; requested: number; started: number; completed: number; status: string };
type PlowThread = { $: "Thread"; created: number; updated: number; runs: List<PlowRun> };
type PlowSpan = { a: number; b: number; name: string };
type PlowTrace = { start: number; end: number; work: List<PlowSpan>; wait: List<PlowSpan>; errors: List<number> };
type PlowPolicy = { project_feed(threads: List<PlowThread>): { observed: number; traces: List<PlowTrace> } };

export async function projectPlowFeed(path: string, scratch: string) {
  const module = await buildPolicy(scratch, new URL("./plow-feed.bend", import.meta.url), "plow-feed.mjs");
  const policy = await loadPolicy<PlowPolicy>(module);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN");
    const threads = db.prepare("SELECT instance, thread_id, created_ms, updated_ms FROM t3_threads ORDER BY instance, thread_id").all();
    const runs = db.prepare(`SELECT requested_ms, started_ms, completed_ms, status FROM t3_runs
      WHERE instance=? AND thread_id=? ORDER BY run_id`);
    const projected = policy.project_feed(historyList(threads.map(thread => ({
      $: "Thread", created: Number(thread.created_ms), updated: Number(thread.updated_ms),
      runs: historyList(runs.all(thread.instance, thread.thread_id).map(run => ({
        $: "Run", requested: Number(run.requested_ms), started: Number(run.started_ms),
        completed: Number(run.completed_ms), status: String(run.status),
      }))),
    }))));
    const spans = (list: List<PlowSpan>) => rows(list).map(({ a, b, name }) => [a / 1000, b / 1000, name]);
    return { observed: projected.observed, traces: rows(projected.traces).map(trace => ({
      startUtcMs: trace.start, end: trace.end / 1000,
      work: spans(trace.work), wait: spans(trace.wait), errors: rows(trace.errors).map(at => at / 1000),
    })) };
  } finally {
    db.close();
  }
}
