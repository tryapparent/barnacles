import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import type { NativeBinding } from "../load.ts";
import type { ThreadEvidence } from "../sources.ts";

export type T3Command = {
  $: "Command"; id: string; thread: string; run: string; provider_thread: string; provider_turn: string;
  native_item: string; status: string; exit_code: string; started: string; completed: string; updated: string;
};

export type T3HistoryCheckpoint = { frontier: number; revision: number; covered?: string; tip?: string };

export type PendingT3Command = { $: "Pending"; thread: string; id: string; status: string; checked: number };

export type StoredT3Projection = { thread: ThreadEvidence; references: NativeBinding[] };

export function readT3Projections(path: string, instance: string, from: number) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare(`SELECT payload FROM t3_history_projections WHERE instance=? AND revision>=?
      ORDER BY revision DESC,thread_id`).all(instance, from)
      .map(({ payload }) => JSON.parse(String(payload)) as StoredT3Projection);
  } finally {
    db.close();
  }
}

export function openT3History(path: string, instance: string,
  replay: (saved: number, incoming: number, previous: string, next: string) => { $: "Write" | "Ignore" | "Conflict" },
  stale?: (prior: number, at: number, saved: string, incoming: string) => boolean, projectionPath?: string) {
  closeSync(openSync(path, "a", 0o600));
  const db = new DatabaseSync(path);
  const projectionSchema = projectionPath ? "projection" : "main";
  try {
    if (projectionPath) {
      mkdirSync(dirname(projectionPath), { mode: 0o750, recursive: true });
      chmodSync(dirname(projectionPath), 0o750);
      chmodSync(dirname(path), 0o710);
      closeSync(openSync(projectionPath, "a", 0o640));
      chmodSync(projectionPath, 0o640);
      db.prepare("ATTACH DATABASE ? AS projection").run(projectionPath);
      db.exec("PRAGMA projection.synchronous=FULL");
    }
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS ${projectionSchema}.t3_history_projections (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (instance, thread_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS t3_history_progress (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, cursor TEXT NOT NULL,
        PRIMARY KEY (instance, thread_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS t3_history_backfill (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, frontier INTEGER NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY (instance, thread_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS t3_history_anchors (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, covered TEXT NOT NULL, tip TEXT NOT NULL,
        PRIMARY KEY (instance, thread_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS t3_history_checks (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, item_id TEXT NOT NULL, checked_ms INTEGER NOT NULL,
        PRIMARY KEY (instance, thread_id, item_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS t3_history_commands (
        instance TEXT NOT NULL, thread_id TEXT NOT NULL, item_id TEXT NOT NULL, snapshot_sequence INTEGER NOT NULL,
        run_id TEXT, provider_thread_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, native_item_id TEXT NOT NULL,
        status TEXT NOT NULL, exit_code INTEGER, t3_started_ms INTEGER, t3_completed_ms INTEGER, t3_updated_ms INTEGER,
        PRIMARY KEY (instance, thread_id, item_id)
      ) STRICT, WITHOUT ROWID;
    `);
    const projections = db.prepare(`SELECT thread_id,revision FROM ${projectionSchema}.t3_history_projections WHERE instance=?`);
    const writeProjection = db.prepare(`INSERT INTO ${projectionSchema}.t3_history_projections VALUES (?,?,?,?)
      ON CONFLICT(instance,thread_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload
      WHERE excluded.revision>=t3_history_projections.revision`);
    const cursor = db.prepare("SELECT cursor FROM t3_history_progress WHERE instance=? AND thread_id=?");
    const resume = db.prepare(`SELECT thread_id,cursor,frontier,revision,covered,tip FROM t3_history_progress
      LEFT JOIN t3_history_backfill USING (instance,thread_id)
      LEFT JOIN t3_history_anchors USING (instance,thread_id) WHERE instance=?`);
    const checkpoint = db.prepare(`INSERT INTO t3_history_backfill VALUES (?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET frontier=excluded.frontier,revision=excluded.revision`);
    const anchor = db.prepare(`INSERT INTO t3_history_anchors VALUES (?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET covered=excluded.covered,tip=excluded.tip`);
    const clearAnchor = db.prepare("DELETE FROM t3_history_anchors WHERE instance=? AND thread_id=?");
    const pending = db.prepare(`SELECT thread_id,item_id,status,checked_ms FROM t3_history_commands
      LEFT JOIN t3_history_checks USING (instance,thread_id,item_id)
      WHERE instance=? AND t3_completed_ms IS NULL`);
    const checked = db.prepare(`INSERT INTO t3_history_checks VALUES (?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET checked_ms=excluded.checked_ms`);
    const receipt = db.prepare(`UPDATE t3_history_commands SET status=?, exit_code=?, t3_completed_ms=?, t3_updated_ms=?
      WHERE instance=? AND thread_id=? AND item_id=?`);
    const clear = db.prepare("DELETE FROM t3_history_backfill WHERE instance=? AND thread_id=?");
    const progress = db.prepare("INSERT INTO t3_history_progress VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET cursor=excluded.cursor");
    const read = db.prepare(`SELECT snapshot_sequence, run_id, provider_thread_id, provider_turn_id, native_item_id,
      status, exit_code, t3_started_ms, t3_completed_ms, t3_updated_ms
      FROM t3_history_commands WHERE instance=? AND thread_id=? AND item_id=?`);
    read.setReturnArrays(true);
    const save = db.prepare(`INSERT INTO t3_history_commands VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET snapshot_sequence=excluded.snapshot_sequence, run_id=excluded.run_id,
      provider_thread_id=excluded.provider_thread_id, provider_turn_id=excluded.provider_turn_id,
      native_item_id=excluded.native_item_id, status=excluded.status, exit_code=excluded.exit_code,
      t3_started_ms=excluded.t3_started_ms, t3_completed_ms=excluded.t3_completed_ms, t3_updated_ms=excluded.t3_updated_ms`);
    const readCursor = (thread: string) => String(cursor.get(instance, thread)?.cursor ?? "");
    return {
      cursor: readCursor,
      projectionRevisions() {
        return new Map(projections.all(instance).map(row => [String(row.thread_id), Number(row.revision)]));
      },
      checkpoints() {
        return new Map(resume.all(instance).map(({ thread_id, cursor, frontier, revision, covered, tip }) =>
          [String(thread_id), { cursor: String(cursor), mark: frontier === null ? null : {
            frontier: Number(frontier), revision: Number(revision), covered: String(covered ?? ""), tip: String(tip ?? ""),
          } }] as const));
      },
      pending(): PendingT3Command[] {
        return pending.all(instance).map(({ thread_id, item_id, status, checked_ms }) =>
          ({ $: "Pending", thread: String(thread_id), id: String(item_id), status: String(status), checked: Number(checked_ms ?? 0) }));
      },
      reconcile(thread: string, id: string, at: number, item: T3Command | undefined,
        confirm: (saved: string, status: string, previous: number, clock: number) => boolean) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const key = [instance, thread, id] as const;
          const previous = read.get(...key) as unknown[] | undefined;
          if (item && previous && item.provider_thread === previous[2] && item.provider_turn === previous[3] &&
              item.native_item === previous[4] && confirm(String(previous[5]), item.status, Number(previous[9]), Number(item.updated))) {
            receipt.run(item.status, item.exit_code === "" ? null : Number(item.exit_code), Number(item.completed) || null,
              Number(item.updated), ...key);
          }
          checked.run(...key, at);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      commit(thread: string, expected: string, next: string, sequence: number, commands: T3Command[],
        mark?: T3HistoryCheckpoint | null, projection?: StoredT3Projection) {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (readCursor(thread) !== expected) throw Error("T3 history cursor changed during capture");
          for (const item of commands) {
            const key = [instance, thread, item.id] as const;
            const values = [item.run || null, item.provider_thread, item.provider_turn, item.native_item, item.status,
              item.exit_code === "" ? null : Number(item.exit_code), Number(item.started) || null,
              Number(item.completed) || null, Number(item.updated) || null];
            const previous = read.get(...key) as unknown[] | undefined;
            if (previous && stale?.(Number(previous[9]), Number(item.updated), String(previous[5]), item.status)) continue;
            const outcome = previous ? replay(Number(previous[0]), sequence, JSON.stringify(previous.slice(1)), JSON.stringify(values)).$ : "Write";
            if (outcome === "Conflict") throw Error("Conflicting T3 command at the same snapshot sequence");
            if (outcome === "Write") save.run(...key, sequence, ...values);
          }
          if (projection) writeProjection.run(instance, thread, projection.thread.updated, JSON.stringify(projection));
          progress.run(instance, thread, next);
          if (mark) {
            checkpoint.run(instance, thread, mark.frontier, mark.revision);
            anchor.run(instance, thread, mark.covered ?? "", mark.tip ?? "");
          }
          if (mark === null) {
            clear.run(instance, thread);
            clearAnchor.run(instance, thread);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
