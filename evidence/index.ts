export { loadEvidence, type EvidenceBatch } from "./load.ts";
export { deliveryReport, type PullRequest, type ReleaseEvidence } from "./delivery.ts";
export { type ActionAttempt, type AttemptIdentity } from "./actions.ts";
export {
  sourcePolicy,
  type CommandMix, type List, type Milestone, type Point,
  type RolloutEvidence, type ShellCommand, type SourcePolicy, type ThreadEvidence, type ToolInvocation,
} from "./sources.ts";
export { writeSnapshot } from "./snapshot.ts";
export type { TraceProjection } from "./trace.ts";

export function repository(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[\w.-]+\/[\w.-]+$/.test(value) ||
      value.split("/").some((part) => part === "." || part === "..")) {
    throw Error("Expected owner/repository");
  }
  return value.toLowerCase();
}
