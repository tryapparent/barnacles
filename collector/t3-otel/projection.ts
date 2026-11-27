import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  admissionPolicy, analysisWindow, backupAnalysisInput, joinedTargets, joinSession, loadEvidence,
  publishJoinedAnalysis, readT3Projections, repository, sessionJoinPolicy, type AdmissionPolicy,
  type SessionJoinPolicy, type SourcePolicy, type StoredT3Projection, type NativeBinding, type Point, type ThreadEvidence,
} from "../../evidence/index.ts";
import { buildPolicies, loadPolicy } from "../../tooling/bend.ts";
import { array, bendList, millis, point, positiveInt, replayOutcomeDelays, row, stockT3Id, str, timeParts, toMillis, token } from "../wire.ts";

export type ProjectionCodec = SourcePolicy & {
  github_link(host: string): boolean;
  t3_run_clocks(requested: Point, started: Point, completed: Point): { started: Point; completed: Point };
};
type LocalRow = (thread: string, owner: string, visibility: string) => boolean;

export function t3Id(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9](?:[A-Za-z0-9:_-]|%[0-9A-Fa-f]{2})*$/.test(value)) {
    throw Error("Invalid T3 source identifier");
  }
  return value;
}

export function t3Snapshot(input: unknown, rules: SourcePolicy, runLimit = 50): ThreadEvidence {
  const policy = rules as ProjectionCodec;
  const snapshot = row(input);
  const thread = row(snapshot.thread);
  const links = row(snapshot.links);
  if (links.nextCursor !== null) throw Error("Incomplete T3 pull request listing");
  const created = millis(thread.createdAt);
  const updated = millis(thread.updatedAt);
  if (!policy.interval_ms(...timeParts(created), ...timeParts(updated))) throw Error("Invalid T3 thread clock");
  const runs = array(snapshot.recentRuns, runLimit).map((value) => {
    const run = row(value);
    const requested = millis(run.requestedAt);
    const clocks = policy.t3_run_clocks(point(requested), point(millis(run.startedAt)), point(millis(run.completedAt)));
    return { id: t3Id(run.runId), requested: requested || null, started: toMillis(clocks.started),
      completed: toMillis(clocks.completed), status: policy.thread_status(str(run.status)) };
  });
  const pullRequests = array(links.pullRequests, 100).map((value) => {
    const link = row(value);
    if (!policy.github_link(str(link.host))) throw Error("Only github.com T3 links are supported");
    const source = policy.link_source(str(link.source));
    return { repository: repository(link.repository, policy), number: positiveInt(link.number),
      source, state: policy.link_state(str(link.state)), owning: policy.owns_pr(source) };
  });
  return { instance: token(snapshot.instance), id: t3Id(thread.threadId), created, updated,
    title: policy.source_title(str(thread.title)),
    status: policy.thread_status(str(thread.status)), origin: policy.origin(str(thread.createdBy), str(thread.creationSource)),
    settled: thread.settled === true, runs, pullRequests };
}

export function nativeBindings(input: unknown[]): NativeBinding[] {
  return input.map((item) => {
    const ref = row(item);
    const native = row(ref.nativeThreadRef ?? {});
    return { $: "NativeBinding", thread: stockT3Id(ref.appThreadId), reference: stockT3Id(ref.id), driver: str(ref.driver),
      native_driver: str(native.driver), native_id: stockT3Id(native.nativeId), strength: str(native.strength) };
  });
}

export function stockProjection(instance: string, id: string, input: unknown, policy: ProjectionCodec, local: LocalRow): StoredT3Projection {
  const projection = row(input);
  const thread = row(projection.thread);
  if (thread.id !== id) throw Error("T3 projection belongs to another thread");
  const recentRuns = array(projection.runs, 4096).map(row)
    .filter(run => local(id, str(run.threadId), "local"))
    .map(run => ({ runId: run.id, requestedAt: run.requestedAt, startedAt: run.startedAt,
      completedAt: run.completedAt, status: run.status }));
  const pullRequests = array(thread.pullRequests, 100).map(row)
    .filter(link => policy.github_link(str(link.host)))
    .map(link => ({ host: link.host, repository: link.repository, number: link.number,
      source: link.source, state: row(link.snapshot ?? {}).state }));
  return {
    thread: t3Snapshot({ instance, thread: { threadId: id, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      createdBy: thread.createdBy, creationSource: thread.creationSource, settled: millis(thread.settledAt) > 0 },
      recentRuns, links: { nextCursor: null, pullRequests } }, policy, 4096),
    references: nativeBindings(array(projection.providerThreads, 64)),
  };
}

async function joinStored(path: string, traces: string, history: string, scratch: string, asOf: number,
  t3Instance: string, codexInstance: string) {
  const [admissionFile, joinFile] = await buildPolicies(scratch, [
    [admissionPolicy, "admission.mjs"], [sessionJoinPolicy, "session-join.mjs"],
  ]);
  const admission = await loadPolicy<AdmissionPolicy>(admissionFile);
  const policy = await loadPolicy<SessionJoinPolicy>(joinFile);
  const window = await analysisWindow(scratch, asOf, "7d");
  const captures = readT3Projections(history, t3Instance, window.from);
  let bound = 0;
  let withSpans = 0;
  let ambiguous = 0;
  for (const { thread, references } of captures) {
    loadEvidence(path, { source: "t3", thread }, admission);
    const selected = policy.choose_binding(thread.id, "", bendList(references));
    if (selected.$ !== "Bound") {
      ambiguous += Number(selected.$ === "Ambiguous");
      continue;
    }
    const result = joinSession(path, traces, { t3Instance, threadId: thread.id, codexInstance,
      sessionId: token(selected.session_id), referenceId: selected.reference_id }, policy, bendList);
    bound++;
    withSpans += Number(result.acceptedSpans > 0);
  }
  return { projections: captures.length, bound, ambiguous, withSpans };
}

function readAnalysisImpact(receipts: string, scratch: string) {
  const file = join(receipts, "outcomes", "outcome-delays.json");
  return statSync(file, { throwIfNoEntry: false })
    ? async (window: { from: number; to: number }) => JSON.parse(await replayOutcomeDelays(file, scratch, window))
    : undefined;
}

export async function refreshAnalysis() {
  const [root, input, traces, receipts, output] = process.argv.slice(2);
  const bearer = process.env.PLOW_T3_READ_TOKEN_FILE;
  if (bearer) process.env.PLOW_T3_READ_TOKEN = readFileSync(bearer, "utf8").trim();
  const scratch = mkdtempSync(join(root, "analysis-refresh-"));
  try {
    const path = join(scratch, "joined.sqlite");
    const asOf = Date.now();
    await backupAnalysisInput(input, path);
    const history = process.env.PLOW_ANALYSIS_T3_HISTORY_DB;
    const codexInstance = process.env.PLOW_ANALYSIS_CODEX_INSTANCE;
    const t3Instance = process.env.PLOW_ANALYSIS_T3_INSTANCE;
    const capture = history && await joinStored(path, traces, history, scratch, asOf, token(t3Instance), token(codexInstance));
    const { importLiveSession } = await import("../t3.ts");
    const files = readdirSync(receipts).filter((name) => name.endsWith(".json")).sort();
    if (files.length > 50) throw Error("Too many join receipts");
    let exactCiReceipts = 0;
    for (const file of files) {
      const result = await importLiveSession(path, scratch, join(receipts, file), traces);
      exactCiReceipts += Number(result.ci === "Linked");
    }
    if (!history && codexInstance && t3Instance && process.env.PLOW_T3_ORIGIN) {
      const targetPath = join(scratch, "target.json");
      for (const { thread } of await joinedTargets(path, scratch, t3Instance)) {
        writeFileSync(targetPath, JSON.stringify({ t3Instance, threadId: thread, codexInstance }), { mode: 0o600 });
        try { await importLiveSession(path, scratch, targetPath, traces); }
        catch (error) { if (!(error instanceof Error) || !/\((NoBinding|Ambiguous)\)$/.test(error.message)) throw error; }
      }
    }
    const result = await publishJoinedAnalysis(path, output, scratch, asOf, readAnalysisImpact(receipts, scratch),
      history ? t3Instance : undefined);
    console.log(JSON.stringify({ ...result, t3: capture || undefined, exactCiReceipts }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
