import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openT3History, sourcePolicy, type List, type StoredT3Projection, type PendingT3Command, type T3Command, type T3HistoryCheckpoint } from "../../evidence/index.ts";
import { buildPolicies, loadPolicy } from "../../tooling/bend.ts";
import { stockProjection, watchPolicy, type ProjectionCodec, type WatchCodec } from "./projection.ts";
import { array, bendList, bendValues, boundedFile, boundedResponse, millis, requireStockT3Id, row,
  SourceReadError, stockT3Id, stockT3Origin, stockT3Rpc, str, token } from "../wire.ts";

async function compileHistory(directory: string, withProjection: boolean) {
  const scratch = mkdtempSync(join(directory, "build-"));
  try {
    const entries: [URL, string][] = [[new URL("./history.bend", import.meta.url), "t3-history.mjs"]];
    if (withProjection) entries.push([sourcePolicy, "sources.mjs"], [watchPolicy, "pr-watch.mjs"]);
    const [history, projection, watch] = await buildPolicies(scratch, entries);
    return { policy: await loadPolicy<HistoryPolicy>(history),
      projection: projection ? await loadPolicy<ProjectionCodec>(projection) : undefined,
      watch: watch ? await loadPolicy<WatchCodec>(watch) : undefined };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function stockT3HistoryReader(endpoint: string, credential: string) {
  const origin = stockT3Origin(endpoint);
  const secret = boundedFile(credential, 8192).toString("utf8").trim();
  if (!/^[!-~]+$/.test(secret)) throw Error("Expected a T3 read bearer");
  const headers = { authorization: `Bearer ${secret}`, "x-t3-orchestration-protocol": "2" };
  async function get(url: URL, limit: number, timeout: number) {
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceReadError(response.status);
    }
    return row(await boundedResponse(response, limit).json());
  }

  async function page(thread: string, cursor: string) {
    const url = new URL(`/api/orchestration/threads/${encodeURIComponent(thread)}`, origin);
    url.pathname += cursor ? "/history" : "/bounded";
    if (cursor) {
      url.searchParams.set("cursor", cursor);
      url.searchParams.set("view", "activity");
    } else {
      url.searchParams.set("dedupeBodies", "1");
    }
    return get(url, 8 * 1024 * 1024, 5000);
  }

  return { page, async item(threadId: string, itemId: string) {
    const result = await stockT3Rpc(origin, secret, "orchestration.getTurnItem", { threadId, itemId }, 8 * 1024 * 1024);
    return result.item === null ? undefined : row(result.item);
  }, async inventory() {
    const bytes = 64 * 1024 * 1024;
    const [active, archived] = await Promise.all([
      get(new URL("/api/orchestration/shell", origin), bytes, 15000),
      stockT3Rpc(origin, secret, "orchestration.getArchivedShellSnapshot", {}, bytes, 15000),
    ]);
    const threads = (snapshot: ObjectRow) => array(snapshot.threads, 50_000).map(input => {
      const item = row(input);
      const updated = millis(item.updatedAt) || millis(item.createdAt);
      return { $: "Target" as const, id: requireStockT3Id(item.id), updated };
    });
    return [...threads(active), ...threads(archived)];
  } };
}

export type HistoryCodec = {
  observe(thread: string, kind: string, driver: string, strength: string, item: T3Command):
    { $: "Invalid" | "Skip" } | { $: "Keep"; command: T3Command };
  local_row(thread: string, owner: string, visibility: string): boolean;
  page_valid(previous: string, next: string, more: boolean): boolean;
  earliest(saved: number, at: number): number;
  observe_anchor(expected: string, id: string, seen: boolean): boolean;
  next_cursor(cursor: string, overlap: boolean): string;
  tip(previous: string, id: string, previousOrder: number, order: number): string;
};

export function historyPage(policy: HistoryCodec, thread: string, page: ReturnType<typeof row>, cursor: string, covered = "") {
  const next = cursor ? page.nextCursor : page.historyCursor;
  const sequence = page.snapshotSequence;
  if (!(next === null || typeof next === "string" && next.length <= 4096) ||
      typeof page.hasMoreHistory !== "boolean" || !policy.page_valid(cursor, next ?? "", page.hasMoreHistory) ||
      typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 || sequence > 0xffffffff) {
    throw Error("Invalid stock T3 page coordinates");
  }
  let items: unknown[];
  let headRevision = 0;
  if (cursor) {
    items = array(page.items, 4096).map(row)
      .filter(item => policy.local_row(thread, str(item.sourceThreadId), str(item.visibility)))
      .map(item => item.item);
  } else {
    const projection = row(page.projection);
    const sourceThread = row(projection.thread);
    if (sourceThread.id !== thread) throw Error("T3 snapshot belongs to another thread");
    headRevision = millis(sourceThread.updatedAt);
    items = array(projection.turnItems, 4096);
  }
  const commands: T3Command[] = [];
  let oldest = 0;
  let overlap = false;
  let tip = "";
  let tipOrder = 0;
  for (const input of items) {
    const item = row(input);
    oldest = policy.earliest(oldest, millis(item.startedAt) || millis(item.completedAt) || millis(item.updatedAt));
    if (policy.local_row(thread, stockT3Id(item.threadId), "local")) {
      const id = stockT3Id(item.id);
      overlap = policy.observe_anchor(covered, id, overlap);
      const order = typeof item.ordinal === "number" && Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 ? item.ordinal : 0;
      tip = policy.tip(tip, id, tipOrder, order);
      if (tip === id) tipOrder = Math.max(tipOrder, order);
    }
    const command = commandItem(policy, thread, item);
    if (command) commands.push(command);
  }
  return { sequence, next: policy.next_cursor(next ?? "", overlap), oldest, commands, tip, headRevision };
}

function commandItem(policy: HistoryCodec, thread: string, item: ReturnType<typeof row>) {
  const ref = row(item.nativeItemRef ?? {});
  const result = policy.observe(thread, str(item.type), str(ref.driver), str(ref.strength), {
    $: "Command", id: stockT3Id(item.id), thread: stockT3Id(item.threadId), run: stockT3Id(item.runId),
    provider_thread: stockT3Id(item.providerThreadId), provider_turn: stockT3Id(item.providerTurnId),
    native_item: stockT3Id(ref.nativeId), status: str(item.status),
    exit_code: Number.isSafeInteger(item.exitCode) ? String(item.exitCode) : "",
    started: String(millis(item.startedAt)), completed: String(millis(item.completedAt)), updated: String(millis(item.updatedAt)),
  });
  if (result.$ === "Invalid") throw Error("Invalid native Codex command in T3 history");
  if (result.$ === "Keep") return result.command;
}

function t3HistoryTargets(env = process.env) {
  switch (env.PLOW_T3_HISTORY_SCOPE ?? "allowlist") {
    case "all": return null;
    case "allowlist": {
      const ids = [...new Set(array(JSON.parse(boundedFile(env.PLOW_T3_HISTORY_TARGETS_FILE ?? "", 20_000)
        .toString("utf8")), 32).map(requireStockT3Id))];
      if (!ids.length) throw Error("Configure at least one T3 history thread");
      return ids;
    }
    default: throw Error("Invalid T3 history scope");
  }
}

type Target = { $: "Target"; id: string; updated: number };
type Task = { $: "Task"; id: string; cursor: string; priority: number; revision: number; keep: boolean };
export type HistoryPolicy = HistoryCodec & {
  begin_scan(saved: string, head: string): string;
  replay: Parameters<typeof openT3History>[2];
  inventory(input: List<Target>): List<Target>;
  recent(input: List<Target>): List<Target>;
  plan(target: Target, cursor: string, known: boolean, revision: number, frontier: number, refresh: boolean):
    { $: "Some"; value: Task } | { $: "None" };
  batch(input: List<Task>): List<Task>;
  projection_due(updated: number, saved: number, now: number, metadataObserved: boolean): boolean;
  older_frontier(previous: number, oldest: number): number;
  stale_item: NonNullable<Parameters<typeof openT3History>[3]>;
  reconcile_batch(input: List<PendingT3Command>): List<PendingT3Command>;
  confirm_exit(prior: string, status: string, previous: number, updated: number): boolean;
  advance_checkpoint(keep: boolean, saved: string, covered: string, revision: number, tip: string,
    priority: number, oldest: number, head: number, next: string):
    { $: "None" } | { $: "Some"; value: T3HistoryCheckpoint };
  pacing(previous: number, elapsed: number, failed: boolean): { workers: number; pause: number };
};

export async function pollT3History([job, instance, flag, ...extra]: string[]) {
  if (!job || !instance || flag && flag !== "--once" || extra.length) throw Error("Invalid T3 history invocation");
  const targets = t3HistoryTargets();
  const source = stockT3HistoryReader(process.env.PLOW_T3_HISTORY_ORIGIN ?? "",
    process.env.PLOW_T3_HISTORY_READ_TOKEN_FILE ?? "/run/secrets/t3_history_read");
  const path = process.env.PLOW_T3_PROJECTION_FILE;
  const { policy, projection: codec, watch } = await compileHistory(process.env.TMPDIR ?? resolve(job), Boolean(path));
  const store = openT3History(join(resolve(job), "evidence.sqlite"), token(instance), policy.replay, policy.stale_item, path);
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  const wait = (ms: number) => sleep(ms, undefined, { signal: stop.signal }).catch(() => {});
  let projectionFailed = 0;
  const read = async (id: string, cursor: string, covered = "") => {
    try {
      const input = await source.page(id, cursor);
      const result = historyPage(policy, id, input, cursor, covered);
      let projection: StoredT3Projection | undefined;
      if (!cursor && codec && watch) {
        try { projection = stockProjection(instance, id, input.projection, codec, policy.local_row, watch); }
        catch { projectionFailed++; }
      }
      return { ...result, projection };
    } catch (error) {
      if (cursor && error instanceof SourceReadError && error.status === 400) store.commit(id, cursor, "", 0, [], null);
      throw error;
    }
  };
  const ready = () => {
    if (process.env.PLOW_T3_HISTORY_READY_FILE) writeFileSync(process.env.PLOW_T3_HISTORY_READY_FILE, "");
  };
  let pace = policy.pacing(0, 0, false);
  try {
    do {
      const deadline = performance.now() + 900_000;
      projectionFailed = 0;
      const coverage = { headPages: 0, olderPages: 0, complete: 0, failed: 0 };
      if (targets) {
        for (const id of targets) {
          if (stop.signal.aborted) break;
          try {
            const saved = store.cursor(id);
            const head = await read(id, "");
            const cursor = policy.begin_scan(saved, head.next);
            store.commit(id, saved, cursor, head.sequence, head.commands, undefined, head.projection);
            coverage.headPages++;
            ready();
            if (cursor && !stop.signal.aborted) {
              const older = await read(id, cursor);
              store.commit(id, cursor, older.next, older.sequence, older.commands);
              coverage.olderPages++;
            }
            if (!store.cursor(id)) coverage.complete++;
          } catch { coverage.failed++; }
        }
      } else {
        let inventory: List<Target> = { $: "Nil" };
        try {
          inventory = policy.inventory(bendList(await source.inventory()));
          ready();
        } catch {
          console.error("T3 thread discovery failed");
          coverage.failed++;
          pace = policy.pacing(pace.pause, 0, true);
        }
        const all = [...bendValues(inventory)];
        const refresh = new Set(flag ? [] : [...bendValues(policy.recent(inventory))].map(item => item.id));
        if (!flag && codec) {
          const saved = store.projectionRevisions();
          const now = Date.now();
          for (const { id, updated } of all) {
            const projection = saved.get(id);
            if (policy.projection_due(updated, projection?.revision ?? 0, now, projection?.metadataObserved ?? false)) refresh.add(id);
          }
        }
        const deferred = new Set<string>();
        const checkpoints = store.checkpoints();
        console.log(JSON.stringify({ discovered: all.length }));
        if (!flag && coverage.failed === 0) {
          for (const { thread, id } of bendValues(policy.reconcile_batch(bendList(store.pending())))) {
            if (stop.signal.aborted) break;
            let command;
            const began = performance.now();
            let failed = false;
            try {
              const item = await source.item(thread, id);
              if (item && item.id === id) command = commandItem(policy, thread, item);
            } catch {
              failed = true;
            }
            store.reconcile(thread, id, Date.now(), command, policy.confirm_exit);
            pace = policy.pacing(pace.pause, Math.floor(performance.now() - began), failed);
            if (failed) break;
            await wait(pace.pause);
          }
        }
        let used = 0;
        const running = () => !stop.signal.aborted && performance.now() < deadline && (!flag || used < 32);
        while (running()) {
          const tasks: Task[] = [];
          for (const target of all) {
            if (deferred.has(target.id)) continue;
            const saved = checkpoints.get(target.id);
            const task = policy.plan(target, saved?.cursor ?? "", !!saved?.mark,
              saved?.mark?.revision ?? 0, saved?.mark?.frontier ?? 0, refresh.has(target.id));
            if (task.$ === "Some") tasks.push(task.value);
          }
          const batch = [...bendValues(policy.batch(bendList(tasks)))];
          if (!batch.length) break;
          for (let start = 0; start < batch.length && running();) {
            const wave = batch.slice(start, start + Math.min(pace.workers, flag ? 32 - used : pace.workers));
            start += wave.length;
            used += wave.length;
            const began = performance.now();
            const results = await Promise.all(wave.map(async ({ id, cursor, priority, revision, keep }) => {
              const previous = checkpoints.get(id);
              const saved = previous?.cursor ?? "";
              const covered = previous?.mark?.covered ?? "";
              refresh.delete(id);
              try {
                const page = await read(id, cursor, keep ? "" : covered);
                const next = keep ? saved : page.next;
                const tip = cursor ? previous?.mark?.tip ?? "" : page.tip;
                const checkpoint = policy.advance_checkpoint(keep, saved, covered, keep ? previous?.mark?.revision ?? 0 : revision,
                  tip, priority, page.oldest, page.headRevision, next);
                const mark = checkpoint.$ === "Some" ? checkpoint.value : undefined;
                store.commit(id, saved, next, page.sequence, page.commands, mark, page.projection);
                if (mark) checkpoints.set(id, { cursor: next, mark });
                if (cursor) coverage.olderPages++;
                else coverage.headPages++;
                if (!next) coverage.complete++;
                return true;
              } catch {
                deferred.add(id);
                coverage.failed++;
                return false;
              }
            }));
            pace = policy.pacing(pace.pause, Math.floor(performance.now() - began), results.includes(false));
            if (running()) await wait(pace.pause);
          }
          console.log(JSON.stringify({ backfill: used, ...coverage }));
        }
      }
      console.log(JSON.stringify({ ...coverage, projectionFailed }));
      if (flag) {
        if (coverage.failed) process.exitCode = 1;
        return;
      }
      await wait(targets ? 900_000 : Math.max(0, deadline - performance.now()));
    } while (!stop.signal.aborted);
  } finally {
    store.close();
  }
}
