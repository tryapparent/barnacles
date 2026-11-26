import { repository, type Point, type SourcePolicy, type ThreadEvidence } from "../evidence/index.ts";
import { array, millis, point, row, str, timeParts, toMillis, token } from "./wire.ts";
import { positiveInt } from "./github/attempt.ts";

type T3Policy = SourcePolicy & {
  github_link(host: string): boolean;
  t3_run_clocks(requested: Point, started: Point, completed: Point): { started: Point; completed: Point };
};

export function t3Snapshot(input: unknown, rules: SourcePolicy): ThreadEvidence {
  const policy = rules as T3Policy;
  const snapshot = row(input);
  const thread = row(snapshot.thread);
  const links = row(snapshot.links);
  if (links.nextCursor !== null) throw Error("Incomplete T3 pull request listing");
  const created = millis(thread.createdAt);
  const updated = millis(thread.updatedAt);
  if (!policy.interval_ms(...timeParts(created), ...timeParts(updated))) throw Error("Invalid T3 thread clock");
  const runs = array(snapshot.recentRuns, 50).map((value) => {
    const run = row(value);
    const requested = millis(run.requestedAt);
    const clocks = policy.t3_run_clocks(point(requested), point(millis(run.startedAt)), point(millis(run.completedAt)));
    return { id: token(run.runId), requested: requested || null, started: toMillis(clocks.started),
      completed: toMillis(clocks.completed), status: policy.thread_status(str(run.status)) };
  });
  const pullRequests = array(links.pullRequests, 100).map((value) => {
    const link = row(value);
    if (!policy.github_link(str(link.host))) throw Error("Only github.com T3 links are supported");
    const source = policy.link_source(str(link.source));
    return { repository: repository(link.repository), number: positiveInt(link.number),
      source, state: policy.link_state(str(link.state)), owning: policy.owns_pr(source) };
  });
  return { instance: token(snapshot.instance), id: token(thread.threadId), created, updated,
    status: policy.thread_status(str(thread.status)), origin: policy.origin(str(thread.createdBy), str(thread.creationSource)),
    settled: thread.settled === true, runs, pullRequests };
}
