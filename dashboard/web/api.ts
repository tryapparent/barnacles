import { useEffect, useState } from "react";

export const stages = [
  ["pre-commit", "Pre-commit", "commit"],
  ["pr-opened", "PR opened", "pr"],
  ["first-ci", "First CI", "ci"],
  ["merged", "Merged", "merge"],
  ["dispatched", "Dispatched", "dispatch"],
  ["published", "Published", "publish"],
  ["access-verified", "Access verified", "access"],
] as const;

export type Stage = (typeof stages)[number][0];
const milestoneLabels: Record<string, string> = {
  "thread-started": "Thread started", "first-commit": "First commit", "pr-opened": "PR opened",
  "first-ci": "First CI", merged: "Merged", dispatched: "Dispatched", published: "Published",
  "access-verified": "Access verified",
};

export type Milestone = { key: string; phase: Stage; observedAt: string | null; elapsedMillis: number | null;
  provenance?: { source: string; url: string | null } | null };
export type Vessel = { number: number; stage: Stage; lastObservedAt: string; detailPath: string; pullRequestUrl: string };
export type Delivery = Vessel & { title?: string | null; milestones: Milestone[] };
export type ProcessCapture = {
  startedAt: string; durationMicros: number | null; observedMicros: number; unfinished: number;
  spans: { id: number; parent: number; depth: number; name: string; start: number; end: number; elapsed: number }[];
};

export type Detail = Delivery & { asOf: string; snapshotAt: string };
export type Operation = { operation: string; measuredSpans: number; meanSeconds: number | null; totalSeconds: number | null;
  unmeasuredSpans: number; hasArea: boolean };
export type ChangeFile = ({ path: string } | { pathBytesBase64: string }) & { commits: number };
export type ChangeReview = { repository: string; scan: {
  revision: string; commitsScanned: number; hasMoreCommits: boolean; shallow: boolean; files: ChangeFile[] | null;
} | null };
export type ChangeList<T> = { $: "Nil" } | { $: "Con"; head: T; tail: ChangeList<T> };
export type ChangeNode = { $: "Count"; name: string; touches: number; directory: boolean; children: unknown };
type ChangeInput = { $: "Path"; path: string; touches: number; encoded: boolean };
type ChangePolicy = {
  tree(files: ChangeList<ChangeInput>): ChangeNode;
  initial_route(node: ChangeNode): ChangeList<ChangeNode>;
  sorted(node: ChangeNode): ChangeList<ChangeNode>;
  bands(nodes: ChangeList<ChangeNode>, total: number, used: number): ChangeList<{ node: ChangeNode; top: number; size: number }>;
  share(touches: number, total: number): number;
  search(node: ChangeNode, query: string): { count: number; rows: ChangeList<{ path: string; touches: number; route: ChangeList<ChangeNode> }> };
};
export const changePolicy = import.meta.glob<ChangePolicy>("./changed-code.bend", { eager: true, import: "default" })["./changed-code.bend"];
export function changeValues<T>(list: ChangeList<T>) {
  const values: T[] = [];
  for (let item = list; item.$ === "Con"; item = item.tail) values.push(item.head);
  return values;
}
export function changeTree(files: ChangeFile[]) {
  return changePolicy.tree(files.reduceRight<ChangeList<ChangeInput>>((tail, file) => ({
    $: "Con", tail, head: { $: "Path", touches: file.commits, encoded: "pathBytesBase64" in file,
      path: "path" in file ? file.path : file.pathBytesBase64 },
  }), { $: "Nil" }));
}
export type OperationTile = { label: string; totalSeconds: number; index: number; grouped: number; children: OperationTile[] };
export type Week = { startsAt: string; verified: number; attributed: number; meanCycleSeconds: number | null };
export type DeliveryChart = { from: string; days: DeliveryDay[] };
export type DeliveryDay = { startsAt: string; verified: number;
  stages: { phase: Stage; measured: number; meanSeconds: number | null }[] };
export type ComparisonWeek = { startsAt: string; attributedShipments: number; meanSeconds: number | null };
export type Review = {
  repository: string; surface: string; snapshotAt: string; window: { from: string; to: string };
  snapshotCoverage: { observedPullRequests: number; verifiedShipments: number; attributedShipments: number };
  cycleComparison: { deltaSeconds: number | null; direction: string; prior: ComparisonWeek; recent: ComparisonWeek };
  shipments: { verified: number; attributed: number; meanCycleSeconds?: number | null; weekly: Week[]; dailyChart?: DeliveryChart };
  operations: { window: string; clock: string; operation: string | null; clockOptions: string[];
    operationOptions: string[]; items: Operation[]; map?: OperationTile[]; mapKind?: "categories" };
  fleet: { from: string; to: string; items: Vessel[] };
  deliveries: { total: number; limit: number; offset: number; nextOffset: number | null; timeline?: { from: string; to: string }; items: Delivery[] };
};

const fields = ["from", "to", "clock", "operation"];
export const route = new URLSearchParams(location.search);

function filters(query: URLSearchParams) {
  return new URLSearchParams([...query].filter(([name]) => fields.includes(name)));
}

export function shippingPath(query = route) {
  const params = filters(query);
  params.set("limit", "10");
  return "/api/v1/shipping?" + params;
}

export function pagePath(changes: Record<string, string | number | null>, anchor = "") {
  const params = new URLSearchParams(route);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === "") params.delete(name);
    else params.set(name, String(value));
  }
  return "/?" + params + anchor;
}

export function detailPage(number: number, to: string) {
  return pagePath({ pr: number, to, offset: null }, `#delivery-pr-${number}`);
}

export async function fetchEvidence<T>(path: string, signal: AbortSignal, method = "GET"): Promise<T> {
  const response = await fetch(path, { method, signal, credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Error(data?.error?.message ?? "The evidence request failed. Try again.");
  }
  return await response.json() as T;
}

const utcDisplay = new Intl.DateTimeFormat(undefined,
  { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dayDisplay = new Intl.DateTimeFormat(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
export const utcLabel = (value: string) => utcDisplay.format(new Date(value)) + " UTC";
export const dayLabel = (value: string) => dayDisplay.format(new Date(value));
export const stageLabel = (key: string) => stages.find(([stage]) => key === stage)?.[1] ?? "Unknown stage";
export const milestoneLabel = (key: string) => milestoneLabels[key] ?? key;
export const countLabel = (value: number) => value.toLocaleString();

type DurationPolicy = {
  elapsed_label(milliseconds: number, negative: boolean, signed: boolean): string;
  process_label(microseconds: number): string;
};
const policy = import.meta.glob<DurationPolicy>("./duration.bend", { eager: true, import: "default" })["./duration.bend"];

export function durationMillis(milliseconds: number, signed = false) {
  return policy.elapsed_label(Math.trunc(Math.abs(milliseconds)), milliseconds < 0, signed);
}

export function duration(seconds: number | null, signed = false) {
  return seconds === null ? "Unknown" : durationMillis(seconds * 1000, signed);
}

export const processMillis = (microseconds: number) => policy.process_label(microseconds);

export type HistoryEvent = { $: "HistoryEvent"; index: number; lane: number; start: number;
  end: { $: "None" } | { $: "Some"; value: number }; label: string; source: string; state: string; relation: string; clipped: boolean };
export type HistoryEntry = { $: "HistoryEntry"; thread: { $: "HistoryThread"; id: string; sample: number;
  title: string; source: string; start: number; cutoff: number; rollout_count: number };
  end: number; count: number; signals: number };
export type HistoryLane = { index: number; name: string; events: HistoryEvent[] };
export type HistoryTrace = { entry: HistoryEntry; lanes: HistoryLane[];
  signals: { rule: string; id: string; seconds: number; median: number; peers: number; event: HistoryEvent["end"] }[] };

type SessionPolicy = {
  session_matches(entry: HistoryEntry, query: string): boolean;
  order_duration(events: ChangeList<HistoryEvent>): ChangeList<HistoryEvent>;
  order_events(events: ChangeList<HistoryEvent>): ChangeList<HistoryEvent>;
  session_events(events: ChangeList<HistoryEvent>, from: number, to: number, query: string, offset: number):
    { total: number; rows: ChangeList<HistoryEvent> };
  trace_elapsed(ms: number): string;
};

const sessionModules = import.meta.glob<SessionPolicy>("../../evidence/analysis/session-history.bend", { eager: true, import: "default" });
export const sessionPolicy = sessionModules["../../evidence/analysis/session-history.bend"];
export function sessionEventList(events: HistoryEvent[]) {
  return events.reduceRight<ChangeList<HistoryEvent>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
}

type Request<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };

export function useEvidence<T extends object>(path: string, refresh = false) {
  const [result, setResult] = useState<Request<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ state: "loading" });
    fetchEvidence<T>(path, controller.signal).then((data) => {
      if (!controller.signal.aborted) setResult({ state: "ready", data });
    }, (error: Error) => {
      if (!controller.signal.aborted) setResult({ state: "error", message: error.message });
    });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => {
    if (!refresh) return;
    let pending: AbortController | undefined;
    const timer = window.setInterval(() => {
      if (document.hidden || pending) return;
      const controller = pending = new AbortController();
      fetchEvidence<T>(path, controller.signal).then((data) => {
        if (controller.signal.aborted) return;
        setResult((prior) => prior.state === "ready" && "snapshotAt" in prior.data &&
          "snapshotAt" in data && prior.data.snapshotAt === data.snapshotAt ? prior : { state: "ready", data });
      }).catch(() => undefined).finally(() => { pending = undefined; });
    }, 30_000);
    return () => {
      window.clearInterval(timer);
      pending?.abort();
    };
  }, [path, refresh]);
  return { result, retry: () => setAttempt((count) => count + 1) };
}
