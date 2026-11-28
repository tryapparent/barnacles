import { checked, decodeRun, list, mismatch } from "./attempts.ts";
import type { Evidence, Projected, Progress, Read, Run } from "./attempts.ts";
import { clock, count, id, iso, object, rows, seconds, text } from "./http.ts";

export function startPage() {
  return { page: 1, seen: [] as string[], signature: "", total: 0, lastPage: false };
}
export type PageCursor = ReturnType<typeof startPage>;
export type Cursor = PageCursor & {
  lo: number; hi: number; scanUpper: number; floor: number; watermark: number; due: number; failures: number; blocked: string;
  done: boolean; gap: string; queue: Run[]; success: number; newest: number; oldest: number;
};

export function cursor(): Cursor {
  return { ...startPage(), lo: 0, hi: 0, scanUpper: 0, floor: 0, watermark: 0, due: 0, failures: 0, blocked: "",
    done: false, gap: "", queue: [], success: 0, newest: 0, oldest: 0 };
}

export function begin(current: Cursor, progress: Progress, floor: number, now: number, history: boolean, lookback: number) {
  const hi = progress.new_upper(now);
  const limit = history ? floor : progress.live_floor(floor, current.watermark, hi, lookback);
  return { ...current, ...startPage(), ...progress.window(limit, hi), scanUpper: hi, floor: limit, done: false, gap: "" };
}

export async function pullPage(read: Read, repo: string, current: Cursor, history: boolean,
    evidence: Evidence, progress: Progress) {
  const query = history ? "pulls?state=all&sort=created&direction=asc" : "pulls?state=all&sort=updated&direction=desc";
  const readPage = async (page: number) => {
    const reply = await read(repo, query + "&per_page=100&page=" + page);
    const data = rows(reply.data);
    if ((reply.next && (reply.next !== page + 1 || data.length !== 100)) ||
        (reply.last && reply.last < page) || !progress.unique(list(data.map(row => id(row.number))))) mismatch();
    return { ...reply, data };
  };
  const signature = (data: ReturnType<typeof rows>) => history ? id(data[0]?.number)
    : data.map(row => id(row.number) + ":" + clock(row.updated_at)).join(",");
  let page = current.page;
  if (history && !current.signature) {
    const first = await readPage(1);
    if (first.next && !first.last) mismatch();
    page = first.last || 1;
  }
  if (current.signature) {
    const previous = await readPage(progress.pull_next(!history, page));
    if (current.signature !== signature(previous.data)) mismatch();
  }
  const reply = await readPage(page);
  if (history && page > 1 && reply.data.length === 0) mismatch();
  const projected: Projected[] = [];
  let newest = 0;
  let oldest = 0;
  let lastUpdated = 0;
  for (const row of reply.data) {
    const at = seconds(row.updated_at);
    if (lastUpdated && !history && at > lastUpdated) mismatch();
    lastUpdated = at;
    const base = object(object(row.base).repo);
    const record = checked(evidence.pull(repo, text(base.full_name).toLowerCase(), id(row.number), text(row.state),
      text(object(row.head).sha), text(row.merge_commit_sha), clock(row.created_at), clock(row.merged_at), clock(row.updated_at)));
    if (history || progress.in_live(at, current.floor, current.hi)) {
      projected.push(record);
      const source = history ? seconds(row.created_at) : at;
      oldest = progress.clock_min(oldest, source);
      newest = progress.clock_max(newest, source);
    }
  }
  const decision = progress.pull_page(page, history, Boolean(reply.next), lastUpdated, current.floor).$;
  return { page, decision, signature: signature(reply.data), projected, oldest, newest };
}

export async function runPage(read: Read, repo: string, current: Cursor, evidence: Evidence, progress: Progress) {
  const get = async (page: number) => {
    const query = new URLSearchParams({ created: iso(current.lo) + ".." + iso(current.hi), per_page: "100", page: String(page) });
    const reply = await read(repo, "actions/runs?" + query);
    const data = object(reply.data);
    return { ...reply, runs: rows(data.workflow_runs).map(decodeRun), total: count(data.total_count) };
  };
  const { page } = current;
  if (current.signature) {
    const previous = await get(page - 1);
    if (previous.total !== current.total || previous.runs.map(run => run.run).join(",") !== current.signature) mismatch();
  }
  const reply = await get(page);
  const { runs, total } = reply;
  const decision = progress.run_page(total, current.total, page, runs.length, Boolean(reply.next), current.lo, current.hi).$;
  if (decision === "Invalid" || (reply.next && reply.next !== page + 1)) mismatch();
  if (decision === "Split" || decision === "Capped") return { decision, total, runs: [], ids: [], signature: "" };
  const ids = runs.map(run => run.run);
  if (!progress.unique(list([...current.seen, ...ids])) ||
      runs.some(run => !evidence.valid_run(run.run, run.attempt, run.head, run.created, current.lo, current.hi))) mismatch();
  return { decision, total, runs, ids, signature: ids.join(",") };
}
