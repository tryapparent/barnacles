import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  admissionPolicy, analysisWindow, backupAnalysisInput, joinedTargets, joinSession, loadEvidence,
  projectPlowFeed, publishJoinedAnalysis, readT3Projections, repository, sessionJoinPolicy, type AdmissionPolicy,
  type AttemptIdentity, type SessionJoinPolicy, type SourcePolicy, type StoredT3Projection, type NativeBinding, type Point, type ThreadEvidence,
} from "../../evidence/index.ts";
import { buildPolicies, loadPolicy } from "../../tooling/bend.ts";
import { collectAttempt, type ClockPolicy, type GitHubReader } from "../github/attempt.ts";
import { array, bendList, boundedFile, millis, point, positiveInt, replayOutcomeDelays, row, stockT3Id, stockT3Origin, stockT3Rpc, str, timeParts, toMillis, token } from "../wire.ts";

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

async function prepareCiReceipt(scratch: string, exact: AttemptIdentity, kind: string) {
  const env = process.env;
  const directory = env.PLOW_ANALYSIS_RECEIPTS_DIR;
  const bearerFile = env.PLOW_T3_READ_TOKEN_FILE;
  if (!directory || !bearerFile || !env.PLOW_T3_ORIGIN) throw Error("Set the CI receipt directory and T3 read access");
  const observationId = token(env.CODEX_TOOL_CALL_ID);
  const threadId = t3Id(env.T3CODE_THREAD_ID);
  const sessionId = token(env.CODEX_THREAD_ID);
  const t3Instance = token(env.PLOW_ANALYSIS_T3_INSTANCE);
  const codexInstance = token(env.PLOW_ANALYSIS_CODEX_INSTANCE);
  const bearer = boundedFile(bearerFile, 8192).toString("utf8").trim();
  if (!/^[!-~]+$/.test(bearer)) throw Error("Invalid T3 read credential");
  const result = await stockT3Rpc(stockT3Origin(env.PLOW_T3_ORIGIN), bearer,
    "orchestration.getThreadProjection", { threadId }, 8 * 1024 * 1024);
  const policy = await loadPolicy<SessionJoinPolicy>((await buildPolicies(scratch, [[sessionJoinPolicy, "ci-binding.mjs"]]))[0]);
  const selected = policy.choose_binding(threadId, sessionId, bendList(nativeBindings(array(result.providerThreads, 64))));
  if (!policy.ci_kind(kind) || selected.$ !== "Bound") throw Error("CI observation has no exact native Codex binding");
  const references = [{ id: selected.reference_id, appThreadId: threadId, driver: "codex",
    nativeThreadRef: { driver: "codex", strength: "strong", nativeId: sessionId } }];
  const ci = { observationId, kind, repository: exact.repository,
    runId: exact.runId, attempt: exact.attempt, headSha: exact.sha };
  const payload = JSON.stringify({ t3Instance, threadId, codexInstance, sessionId, references, ci });
  const key = createHash("sha256").update(JSON.stringify([t3Instance, threadId, observationId])).digest("hex");
  return () => {
    const output = join(directory, key + ".json");
    const staging = join(directory, randomUUID() + ".next");
    writeFileSync(staging, payload, { mode: 0o600, flag: "wx" });
    try {
      linkSync(staging, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || boundedFile(output, 16384).toString("utf8") !== payload) throw error;
    } finally {
      rmSync(staging);
    }
  };
}

export async function captureCiAttempt(database: string, scratch: string, exact: AttemptIdentity, kind: string,
  policy: ClockPolicy, admission: AdmissionPolicy, read: GitHubReader) {
  const publish = await prepareCiReceipt(scratch, exact, kind);
  async function verifyWatchTarget() {
    const { id, run_attempt, head_sha } = row(await read(`repos/${exact.repository}/actions/runs/${exact.runId}`));
    if (!policy.attempt_matches(String(id), String(run_attempt), str(head_sha),
      String(exact.runId), String(exact.attempt), exact.sha)) throw Error("The latest GitHub attempt changed during the watch");
  }
  if (kind === "watch") {
    await verifyWatchTarget();
    execFileSync("gh", ["run", "watch", String(exact.runId), "--repo", exact.repository, "--interval", "30", "--compact"],
      { stdio: ["ignore", "inherit", "inherit"], timeout: 600_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  }
  const attempt = await collectAttempt(exact, policy, read);
  if (kind === "watch") await verifyWatchTarget();
  loadEvidence(database, { source: "github-actions", attempt }, admission);
  publish();
  console.log(`Captured exact CI ${kind} and ${attempt.jobs.length} jobs`);
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
  return { counts: { projections: captures.length, bound, ambiguous, withSpans },
    threads: new Set(captures.map(({ thread }) => thread.id)) };
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
    const capture = history ? await joinStored(path, traces, history, scratch, asOf, token(t3Instance), token(codexInstance)) : undefined;
    const { importLiveSession } = await import("../t3.ts");
    const files = readdirSync(receipts).filter((name) => name.endsWith(".json")).sort();
    let selectedReceipts = 0;
    let exactCiReceipts = 0;
    for (const file of files) {
      const receipt = join(receipts, file);
      if (capture) {
        const keys = row(JSON.parse(boundedFile(receipt, 1024 * 1024).toString("utf8")));
        if (keys.t3Instance !== t3Instance || !capture.threads.has(t3Id(keys.threadId))) continue;
      }
      if (++selectedReceipts > 50) throw Error("Too many current join receipts");
      const result = await importLiveSession(path, scratch, receipt, traces);
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
    const activity = history && process.env.PLOW_ANALYSIS_ACTIVITY_DIR;
    const candidate = activity ? join(activity, "timeline.next") : undefined;
    try {
      if (candidate) {
        const feed = await projectPlowFeed(path, scratch, asOf, t3Instance);
        writeFileSync(candidate, JSON.stringify(feed), { mode: 0o600 });
      }
      const result = await publishJoinedAnalysis(path, output, scratch, asOf, readAnalysisImpact(receipts, scratch),
        history ? t3Instance : undefined);
      if (activity && candidate) renameSync(candidate, join(activity, "timeline.json"));
      console.log(JSON.stringify({ ...result, t3: capture?.counts, exactCiReceipts }));
    } finally {
      if (candidate) rmSync(candidate, { force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
