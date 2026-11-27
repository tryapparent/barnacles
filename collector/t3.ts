import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildPolicies, buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { admissionPolicy, backupAnalysisInput, joinedTargets, joinSession, loadEvidence, publishJoinedAnalysis, repository, sessionJoinPolicy, sourcePolicy, type AdmissionPolicy, type NativeBinding, type SessionJoinPolicy, type Point, type SourcePolicy, type ThreadEvidence } from "../evidence/index.ts";
import { array, bendList, boundedFile, millis, point, replayOutcomeDelays, row, sha, stockT3Origin, stockT3Rpc, str, timeParts, toMillis, token } from "./wire.ts";
import { positiveInt } from "./github/attempt.ts";
import { inspectRollout } from "./codex/rollout.ts";

type T3Policy = SourcePolicy & {
  github_link(host: string): boolean;
  t3_run_clocks(requested: Point, started: Point, completed: Point): { started: Point; completed: Point };
};

function t3Id(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9](?:[A-Za-z0-9:_-]|%[0-9A-Fa-f]{2})*$/.test(value)) {
    throw Error("Invalid T3 source identifier");
  }
  return value;
}

const watchPolicy = new URL("../evidence/analysis/pr-watch.bend", import.meta.url);

function projectionId(value: unknown): string {
  try {
    return t3Id(value);
  } catch {
    return "";
  }
}

function watchKey(value: unknown) {
  const key = row(value ?? {});
  const number = key.number;
  return { $: "PrWatchKey", host: str(key.host), repository: str(key.repository),
    number: typeof number === "number" && Number.isInteger(number) && number > 0 && number <= 0xffffffff ? number : 0,
    sha: str(key.headSha) };
}

function watchMessage(value: unknown) {
  const message = row(value);
  const source = row(row(message.notification ?? {}).source ?? {});
  return { $: "PrWatchMessage", id: projectionId(message.id), thread: projectionId(message.threadId),
    run: projectionId(message.runId), kind: str(source.kind), key: watchKey(source.pullRequest),
    watch_started: point(millis(row(source.pullRequest ?? {}).watchStartedAt)), created: point(millis(message.createdAt)) };
}

function watchRun(value: unknown) {
  const run = row(value);
  return { $: "PrWatchRun", id: projectionId(run.id), thread: projectionId(run.threadId),
    user_message: projectionId(run.userMessageId), status: str(run.status),
    started: point(millis(run.startedAt)), completed: point(millis(run.completedAt)) };
}

type Pickup = { $: "Pickup"; thread: string; message: string; run: string; host: string; repository: string;
  number: number; head_sha: string; watch_started: Point; notification_created: Point; run_started: Point; run_completed: Point };

async function replayPrWatch(input: unknown, scratch: string) {
  const capture = row(input);
  if (capture.version !== 1) throw Error("Expected PR-watch capture version 1");
  const expected = row(capture.expected);
  const projection = row(capture.projection);
  const thread = projectionId(row(projection.thread).id);
  const message = projectionId(expected.messageId);
  if (!thread || !message) throw Error("Expected PR-watch thread and message IDs");
  const { host, repository, number, sha } = watchKey(expected);
  const messages = bendList(array(projection.messages, 4096).map(watchMessage));
  const runs = bendList(array(projection.runs, 4096).map(watchRun));
  const policy = await loadPolicy<{
    pr_watch_pickup(thread: string, message: string, host: string, repository: string, number: number,
      sha: string, messageRows: typeof messages, runRows: typeof runs): { $: "None" } | { $: "Some"; value: Pickup };
  }>(await buildPolicy(scratch, watchPolicy, "pr-watch.mjs"));
  const result = policy.pr_watch_pickup(thread, message, host, repository, number, sha, messages, runs);
  if (result.$ === "None") return null;
  const { $, watch_started, notification_created, run_started, run_completed, ...identity } = result.value;
  return { ...identity, watch_started_ms: toMillis(watch_started), notification_created_ms: toMillis(notification_created),
    run_started_ms: toMillis(run_started), run_completed_ms: toMillis(run_completed) };
}

async function replayWatchFile(directory: string, file: string) {
  const contents = boundedFile(file, 4 * 1024 * 1024).toString("utf8");
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch {
    throw Error("Invalid PR-watch capture JSON");
  }
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    console.log(JSON.stringify(await replayPrWatch(input, scratch)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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

function readNativeRefs(path: string, thread: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
    return db.prepare(`
      SELECT driver,
             json_extract(payload_json, '$.nativeThreadRef.driver') AS native_driver,
             json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id,
             json_extract(payload_json, '$.nativeThreadRef.strength') AS strength
        FROM orchestration_v2_projection_provider_threads
       WHERE thread_id = ?
       LIMIT 65`).all(thread).map((ref) => ({
      $: "NativeRef" as const, driver: str(ref.driver), native_driver: str(ref.native_driver),
      native_id: str(ref.native_id), strength: str(ref.strength),
    }));
  } finally {
    db.close();
  }
}

export async function buildSourcePolicies(scratch: string) {
  const [sourceFile, admissionFile] = await buildPolicies(scratch, [[sourcePolicy, "sources.mjs"], [admissionPolicy, "admission.mjs"]]);
  return { policy: await loadPolicy<SourcePolicy>(sourceFile), admission: await loadPolicy<AdmissionPolicy>(admissionFile) };
}

function requireSeparateEvidence(t3Database: string, evidence: string) {
  const source = statSync(t3Database, { bigint: true });
  const target = statSync(evidence, { bigint: true, throwIfNoEntry: false });
  if (source.dev === target?.dev && source.ino === target.ino) throw Error("Use a separate evidence database");
}

async function importLinkedRollout(evidence: string, t3Database: string, t3Instance: string, threadId: string,
  codexInstance: string, rollout: string, policy: SourcePolicy, admission: AdmissionPolicy) {
  const thread = token(threadId);
  const instance = token(t3Instance);
  requireSeparateEvidence(t3Database, evidence);
  const refs = readNativeRefs(t3Database, thread);
  const { data, receipt } = await inspectRollout(rollout, codexInstance, policy);
  if (!data) throw Error(`Rollout admission failed (${receipt.status})`);
  if (!admission.t3_rollout_matches(bendList(refs), data.session)) {
    throw Error("Expected one strong T3 Codex binding matching the rollout, within the 64-row limit");
  }
  loadEvidence(evidence, { source: "t3-rollout", rollout: data, t3Instance: instance, thread }, admission);
  return { linked: true, calls: data.calls.length, reasoningEvents: data.markers.length,
    malformed: data.malformed, orphans: data.orphans };
}

export function linkedRolloutPoller(evidence: string, policy: SourcePolicy, admission: AdmissionPolicy) {
  const path = process.env.PLOW_T3_ROLLOUT_CONFIG;
  if (!path) return;
  const info = statSync(path);
  if (!info.isFile() || info.size > 16 * 1024) throw Error("Expected a small Plow T3 rollout configuration file");
  const config = row(JSON.parse(readFileSync(path, "utf8")));
  const { t3Database, rollout } = config;
  if (typeof t3Database !== "string" || !t3Database || typeof rollout !== "string" || !rollout) {
    throw Error("Expected T3 database and Codex rollout paths");
  }
  const t3Instance = token(config.t3Instance);
  const thread = token(config.threadId);
  const codexInstance = token(config.codexInstance);
  return {
    assertSeparate: () => {
      if (statSync(t3Database, { throwIfNoEntry: false })) requireSeparateEvidence(t3Database, evidence);
    },
    async capture() {
      try {
        return await importLinkedRollout(evidence, t3Database, t3Instance, thread, codexInstance, rollout, policy, admission);
      } catch {
        return { failed: true } as const;
      }
    },
  };
}

async function fetchNativeReferences(endpoint: string, bearer: string, threadId: string) {
  const result = await stockT3Rpc(stockT3Origin(endpoint), bearer, "orchestration.getThreadProjection",
    { threadId }, 8 * 1024 * 1024);
  return array(result.providerThreads, 64);
}

export async function importLiveSession(evidence: string, scratch: string, bindingPath: string, traces: string) {
  const binding = statSync(bindingPath);
  if (!binding.isFile() || binding.size > 1024 * 1024) throw Error("Expected a bounded T3 session binding");
  const traceSource = statSync(traces, { bigint: true });
  const destination = statSync(evidence, { bigint: true, throwIfNoEntry: false });
  if (!traceSource.isFile() || traceSource.dev === destination?.dev && traceSource.ino === destination?.ino) {
    throw Error("Expected a separate Codex trace database");
  }
  const receipt = row(JSON.parse(readFileSync(bindingPath, "utf8")));
  const threadId = t3Id(receipt.threadId);
  const requested = receipt.sessionId === undefined ? "" : token(receipt.sessionId);
  const endpoint = process.env.PLOW_T3_ORIGIN;
  const bearer = process.env.PLOW_T3_READ_TOKEN;
  if (Boolean(endpoint) !== Boolean(bearer)) throw Error("Set both PLOW_T3_ORIGIN and PLOW_T3_READ_TOKEN");
  const input = endpoint && bearer ? await fetchNativeReferences(endpoint, bearer, threadId) : array(receipt.references, 64);
  const refs: NativeBinding[] = input.map((item) => {
    const ref = row(item);
    const native = ref.nativeThreadRef === undefined || ref.nativeThreadRef === null ? {} : row(ref.nativeThreadRef);
    return { $: "NativeBinding", thread: t3Id(ref.appThreadId), reference: t3Id(ref.id), driver: str(ref.driver),
      native_driver: str(native.driver), native_id: str(native.nativeId), strength: str(native.strength) };
  });
  const ci = receipt.ci === undefined ? undefined : row(receipt.ci);
  const joinPolicy = await loadPolicy<SessionJoinPolicy>(await buildPolicy(scratch, sessionJoinPolicy, "session-join.mjs"));
  const selected = joinPolicy.choose_binding(threadId, requested, bendList(refs));
  if (selected.$ !== "Bound") throw Error(`Expected one strong T3 Codex binding (${selected.$})`);
  return joinSession(evidence, traces, {
    t3Instance: token(receipt.t3Instance), threadId, codexInstance: token(receipt.codexInstance),
    sessionId: token(selected.session_id), referenceId: selected.reference_id,
    ci: ci && { observationId: token(ci.observationId), kind: str(ci.kind), repository: repository(str(ci.repository), joinPolicy),
      runId: positiveInt(ci.runId), attempt: positiveInt(ci.attempt), sha: sha(ci.headSha) },
  }, joinPolicy, bendList);
}

async function main() {
  if (process.argv[2] === "--replay-pr-watch") {
    const [directory, file, ...extra] = process.argv.slice(3);
    if (!directory || !file || extra.length) throw Error("Usage: t3.ts --replay-pr-watch JOB_DIRECTORY CAPTURE_JSON");
    return replayWatchFile(directory, file);
  }
  const [directory, t3Database, t3Instance, threadId, codexInstance, rollout, ...extra] = process.argv.slice(2);
  const live = t3Database === "join-session";
  if (!directory || !t3Database || !t3Instance || !threadId || extra.length ||
      (live ? codexInstance !== undefined : !codexInstance || !rollout)) {
    throw Error("Usage: t3.ts JOB_DIRECTORY { T3_STATE_DB T3_INSTANCE THREAD_ID CODEX_INSTANCE ROLLOUT | join-session BINDING.json TRACE_DB }");
  }
  const evidence = join(resolve(directory), "evidence.sqlite");
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    if (live) {
      console.log(JSON.stringify(await importLiveSession(evidence, scratch, t3Instance, threadId)));
      return;
    }
    const { policy, admission } = await buildSourcePolicies(scratch);
    const result = await importLinkedRollout(evidence, t3Database, t3Instance, threadId, codexInstance, rollout, policy, admission);
    console.log(JSON.stringify(result));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readAnalysisImpact(receipts: string, scratch: string) {
  const file = join(receipts, "outcomes", "outcome-delays.json");
  return statSync(file, { throwIfNoEntry: false })
    ? async (window: { from: number; to: number }) => JSON.parse(await replayOutcomeDelays(file, scratch, window))
    : undefined;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "T3 rollout import failed");
    process.exitCode = 1;
  });
}


export async function refreshAnalysis() {
  const [root, input, traces, receipts, output] = process.argv.slice(2);
  const bearer = process.env.PLOW_T3_READ_TOKEN_FILE;
  if (bearer) process.env.PLOW_T3_READ_TOKEN = readFileSync(bearer, "utf8").trim();
  const scratch = mkdtempSync(join(root, "analysis-refresh-"));
  try {
    const path = join(scratch, "joined.sqlite");
    await backupAnalysisInput(input, path);
    const files = readdirSync(receipts).filter((name) => name.endsWith(".json")).sort();
    if (files.length > 50) throw Error("Too many join receipts");
    for (const file of files) await importLiveSession(path, scratch, join(receipts, file), traces);
    const codexInstance = process.env.PLOW_ANALYSIS_CODEX_INSTANCE;
    const t3Instance = process.env.PLOW_ANALYSIS_T3_INSTANCE;
    if (codexInstance && t3Instance && process.env.PLOW_T3_ORIGIN) {
      const targetPath = join(scratch, "target.json");
      for (const { thread } of await joinedTargets(path, scratch, t3Instance)) {
        writeFileSync(targetPath, JSON.stringify({ t3Instance, threadId: thread, codexInstance }), { mode: 0o600 });
        try { await importLiveSession(path, scratch, targetPath, traces); }
        catch (error) { if (!(error instanceof Error) || !/\((NoBinding|Ambiguous)\)$/.test(error.message)) throw error; }
      }
    }
    console.log(await publishJoinedAnalysis(path, output, scratch, Date.now(), readAnalysisImpact(receipts, scratch)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
