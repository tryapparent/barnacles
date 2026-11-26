import type { SourcePolicy, ThreadEvidence } from "../evidence/sources.ts";
import { array, millis, repository, row, str, timeParts, token } from "./wire.ts";
import { positiveInt } from "./github/attempt.ts";

export function t3Snapshot(input: unknown, policy: SourcePolicy): ThreadEvidence {
  const snapshot = row(input);
  const thread = row(snapshot.thread);
  const links = row(snapshot.links);
  if (!("nextCursor" in links) || links.nextCursor !== null) throw Error("Incomplete T3 pull request listing");
  const created = millis(thread.createdAt);
  const updated = millis(thread.updatedAt);
  if (!policy.interval_ms(...timeParts(created), ...timeParts(updated))) throw Error("Invalid T3 thread clock");
  const runs = array(snapshot.recentRuns, 50).map((value) => {
    const run = row(value);
    const requested = millis(run.requestedAt);
    const started = millis(run.startedAt);
    const completed = millis(run.completedAt);
    const validStart = policy.interval_ms(...timeParts(requested), ...timeParts(started));
    const validEnd = validStart && policy.interval_ms(...timeParts(started), ...timeParts(completed));
    return { id: token(run.runId), requested: requested || null, started: validStart ? started : null,
      completed: validEnd ? completed : null, status: policy.thread_status(str(run.status)) };
  });
  const pullRequests = array(links.pullRequests, 100).map((value) => {
    const link = row(value);
    if (link.host !== "github.com") throw Error("Only github.com T3 links are supported");
    const source = policy.link_source(str(link.source));
    return { repository: repository(link.repository), number: positiveInt(link.number),
      source, state: policy.link_state(str(link.state)), owning: policy.owns_pr(source) };
  });
  return { instance: token(snapshot.instance), id: token(thread.threadId), created, updated,
    status: policy.thread_status(str(thread.status)), origin: policy.origin(str(thread.createdBy), str(thread.creationSource)),
    settled: thread.settled === true, runs, pullRequests };
}
