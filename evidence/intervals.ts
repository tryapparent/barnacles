export type IntervalIdentity =
  | { source: "github-actions"; repository: string; run: string; attempt: number; job: string; step?: number }
  | { source: "codex"; instance: string; session: string; call: string };

export type IntervalClock = "ci_queue" | "ci_execution" | "ci_step" | "tool_envelope" | "async_cell";

export type ObservedInterval<Identity extends IntervalIdentity = IntervalIdentity, Clock extends IntervalClock = IntervalClock> = {
  identity: Identity;
  clock: Clock;
  start: number | null;
  end: number | null;
};
