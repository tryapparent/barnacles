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
export type Delivery = Vessel & { milestones: Milestone[] };
export type Detail = Delivery & { asOf: string; snapshotAt: string };
export type Operation = { operation: string; measuredSpans: number; meanSeconds: number | null; totalSeconds: number | null;
  unmeasuredSpans: number; hasArea: boolean };
export type Week = { startsAt: string; verified: number; attributed: number; meanCycleSeconds: number | null };
export type ComparisonWeek = { startsAt: string; attributedShipments: number; meanSeconds: number | null };
export type Review = {
  repository: string; surface: string; snapshotAt: string; window: { from: string; to: string };
  snapshotCoverage: { observedPullRequests: number; verifiedShipments: number; attributedShipments: number };
  cycleComparison: { deltaSeconds: number | null; direction: string; prior: ComparisonWeek; recent: ComparisonWeek };
  shipments: { verified: number; attributed: number; weekly: Week[] };
  operations: { clock: string; operation: string | null; clockOptions: string[]; operationOptions: string[]; items: Operation[] };
  fleet: { from: string; to: string; items: Vessel[] };
  deliveries: { total: number; limit: number; offset: number; nextOffset: number | null; maxMeasuredMillis: number; items: Delivery[] };
};

const fields = ["from", "to", "clock", "operation", "limit", "offset"];
export const route = new URLSearchParams(location.search);

function filters(query: URLSearchParams) {
  return new URLSearchParams([...query].filter(([name]) => fields.includes(name)));
}

export function shippingPath(query = route) {
  return "/api/v1/shipping?" + filters(query);
}

export function deliveryPage(review: Review, offset: number) {
  const query = new URLSearchParams(route);
  query.set("from", review.window.from);
  query.set("to", review.window.to);
  query.set("offset", String(offset));
  return shippingPath(query);
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
  return pagePath({ pr: number, to }, "#pr-detail");
}

export async function fetchEvidence<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: "same-origin", headers: { Accept: "application/json" } });
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

export function wholeMinutes(milliseconds: number) {
  return milliseconds < 30_000 ? "<1 m" : countLabel(Math.round(milliseconds / 60_000)) + " m";
}

export function duration(seconds: number | null) {
  if (seconds === null) return "Unknown";
  const value = Math.abs(seconds);
  const format = (number: number, unit: string) => number.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " " + unit;
  if (value >= 86400) return format(value / 86400, "d");
  if (value >= 3600) return format(value / 3600, "h");
  if (value >= 60) return format(value / 60, "m");
  return format(value, "s");
}
