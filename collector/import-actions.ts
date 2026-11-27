import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  actionsWaitCapturePlan, admissionPolicy, loadEvidence, openHistory, sourcePolicy,
  type AdmissionPolicy, type AttemptIdentity, type HistoryFact, type HistoryProgress, type List, type SourcePolicy,
} from "../evidence/index.ts";
import { buildPolicies, buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { checkRepository, clock, collectAttempt, collectWindow, fullSha, githubReader, positiveInt, wireCount, type ClockPolicy } from "./github/attempt.ts";
import { pollGitHub } from "./github/delivery.ts";
import {
  array, bendList, bendValues, boundedFile, boundedResponse, millis, row, SourceReadError, str, type ObjectRow, timeParts, token,
} from "./wire.ts";

async function mcpReply(response: Response, id: number) {
  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) return row(await response.json());
  if (!response.body) throw Error("Missing MCP reply stream");
  const events = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const chunk = await events.read();
      if (chunk.done) throw Error("Missing MCP response");
      pending += chunk.value;
      const frames = pending.split(/\r?\n\r?\n|\r\r/);
      pending = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) {
          const reply = row(JSON.parse(data));
          if (reply.id === id) return reply;
        }
      }
    }
  } finally {
    await events.cancel().catch(() => {});
  }
}

function t3HistoryReader(env = process.env) {
  let endpoint: URL;
  let secret: string;
  try {
    endpoint = new URL(env.PLOW_T3_HISTORY_MCP_URL ?? "");
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
    if ((!loopback || endpoint.protocol !== "http:") && endpoint.protocol !== "https:") throw Error();
    if (endpoint.username || endpoint.password || endpoint.hash) throw Error();
    secret = boundedFile(env.PLOW_T3_HISTORY_CREDENTIAL_FILE ?? "", 8192).toString("utf8").trim();
    if (!secret) throw Error();
  } catch {
    throw new SourceReadError(401);
  }

  const deadline = performance.now() + 45_000;
  const offered = "2025-06-18";
  let protocol = "";
  let session = "";
  let id = 0;
  async function post(method: string, params: unknown, notification = false) {
    const time = Math.floor(deadline - performance.now());
    if (time <= 0 || id >= 11) throw new SourceReadError(0, false, false, true);
    const requestId = notification ? undefined : ++id;
    const headers = new Headers({
      "content-type": "application/json", accept: "application/json, text/event-stream",
      authorization: `Bearer ${secret}`,
    });
    if (protocol) headers.set("mcp-protocol-version", protocol);
    if (session) headers.set("mcp-session-id", session);
    const response = await fetch(endpoint, { method: "POST", headers, redirect: "error",
      signal: AbortSignal.timeout(Math.min(time, 10_000)),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceReadError(response.status, response.status === 403 && response.headers.has("retry-after"),
        !!session && response.status === 404);
    }
    if (notification) {
      await response.body?.cancel();
      return {};
    }
    const reply = await mcpReply(boundedResponse(response, 512 * 1024), requestId!);
    if (reply.id !== requestId || reply.jsonrpc !== "2.0" || reply.error) throw Error("Invalid or failed T3 RPC response");
    if (method === "initialize") session = response.headers.get("mcp-session-id") ?? "";
    return row(reply.result);
  }

  return async (name: "t3_environment_read" | "t3_project_read" | "t3_thread_read", args: ObjectRow) => {
    if (!protocol) {
      const initialized = await post("initialize", {
        protocolVersion: offered, capabilities: {}, clientInfo: { name: "plow-history", version: "1" },
      });
      if (initialized.protocolVersion !== offered && initialized.protocolVersion !== "2025-03-26") {
        throw Error("Unsupported T3 MCP protocol version");
      }
      protocol = initialized.protocolVersion;
      await post("notifications/initialized", {}, true);
    }
    const result = await post("tools/call", { name, arguments: args });
    if (result.isError === true) throw Error("T3 did not return coverage for the requested target");
    return row(result.structuredContent);
  };
}

type Scope = { $: "Scope"; environment: string; project: string; repository: string };
type Page = { $: "Page"; next: number; total: number; revision: string; more: boolean; settled: boolean };
type Item = {
  $: "Item"; position: number; id: string; owner: string; visibility: string; kind: string;
  status: string; seconds: number; millis: number;
};
type HistoricalPolicy = {
  valid_limit(value: number): boolean;
  canonical_repository(value: string): string;
  target_count(value: number): boolean;
  pending(status: string): boolean;
  prefer(generation: number, current: number): boolean;
  thread_matches(thread: string, project: string, expectedThread: string, expectedProject: string): boolean;
  same(expected: Scope, actual: Scope): boolean;
  activity(previous: HistoryProgress, page: Page, thread: string, items: List<Item>):
    { $: "Invalid" } | { $: "Accepted"; progress: HistoryProgress; facts: List<HistoryFact> };
  exact_status(status: string): string;
  HTTP_status(status: number, limited: boolean, expired: boolean, budget: boolean): string;
  stop_reads(status: string, sessionExpired: boolean): boolean;
};

function historyTargets(input: unknown, repository: string, clockPolicy: ClockPolicy, admission: AdmissionPolicy,
  policy: HistoricalPolicy) {
  const manifest = row(input);
  if (manifest.source === "github-actions") {
    const targets = array(manifest.attempts, 50).map((value) => {
      const identity = row(value);
      return { repository, runId: positiveInt(identity.runId), attempt: positiveInt(identity.attempt),
        sha: fullSha(identity.sha) } satisfies AttemptIdentity;
    });
    let read: ReturnType<typeof githubReader>;
    return {
      source: manifest.source, targets,
      key: (target: unknown) => JSON.stringify(target),
      async capture(target: unknown, previous: HistoryProgress) {
        if (!process.env.PLOW_GITHUB_AUTH) throw new SourceReadError(401);
        read ??= githubReader(repository, process.env, fetch, { requests: 32, milliseconds: 60_000 });
        const attempt = await collectAttempt(target as AttemptIdentity, clockPolicy, read);
        const status = policy.exact_status(attempt.status);
        return { progress: { ...previous, status },
          change: policy.pending(status) ? undefined : { attempt, admission }, advanced: false };
      },
    };
  }
  if (manifest.source !== "t3-activity") throw Error("Expected a historical manifest source");
  const environment = token(manifest.environment);
  const project = token(manifest.project);
  const targets = array(manifest.threads, 50).map(token);
  let call: ReturnType<typeof t3HistoryReader>;
  let verified = false;
  return {
    source: manifest.source, targets,
    key: (thread: unknown) => JSON.stringify({ environment, project, thread }),
    async capture(target: unknown, previous: HistoryProgress) {
      const thread = target as string;
      call ??= t3HistoryReader();
      if (!verified) {
        const identity = await call("t3_environment_read", { environmentId: environment });
        const binding = await call("t3_project_read", { environmentId: environment, projectId: project });
        if (!policy.same({ $: "Scope", environment, project, repository: `github.com/${repository}` },
          { $: "Scope", environment: str(identity.environmentId), project: str(binding.id),
            repository: str(row(binding.repositoryIdentity ?? {}).canonicalKey) })) throw new SourceReadError(403);
        verified = true;
      }

      const result = await call("t3_thread_read", {
        environmentId: environment, threadId: thread, view: "activity", afterPosition: previous.position - 1,
        limit: 25, maxCharsPerItem: 1, runLimit: 1,
      });
      const identity = row(result.thread);
      if (!policy.thread_matches(str(identity.threadId), str(identity.projectId), thread, project)) throw new SourceReadError(403);
      const revision = millis(identity.updatedAt);
      if (typeof result.hasMore !== "boolean") throw Error("Missing T3 pagination state");
      const page: Page = {
        $: "Page", revision: revision ? String(revision) : "", total: wireCount(identity.itemCount),
        next: result.nextPosition === null ? previous.position
          : result.nextPosition === -1 ? 0 : wireCount(wireCount(result.nextPosition) + 1),
        more: result.hasMore, settled: identity.settled === true && identity.activeRunId === null,
      };
      const items = array(result.items, 25).map((value): Item => {
        const item = row(value);
        const [seconds, milliseconds] = timeParts(millis(item.updatedAt));
        return { $: "Item", position: wireCount(wireCount(item.position) + 1), id: token(item.itemId),
          owner: str(item.sourceThreadId), visibility: str(item.visibility), kind: str(item.type),
          status: str(item.status), seconds, millis: milliseconds };
      });
      const resultPage = policy.activity(previous, page, thread, bendList(items));
      if (resultPage.$ === "Invalid") throw Error("Partial or changed T3 history page");
      return { progress: resultPage.progress,
        change: { environment, thread, facts: bendValues(resultPage.facts) }, advanced: true };
    },
  };
}

async function backfill(database: string, manifestPath: string, maxUnits: number, repository: string,
  scratch: string, clockPolicy: ClockPolicy, admission: AdmissionPolicy) {
  const policy = await loadPolicy<HistoricalPolicy>(
    await buildPolicy(scratch, new URL("./history.bend", import.meta.url), "history.mjs"));
  if (!policy.valid_limit(wireCount(maxUnits))) throw Error("Expected a historical work limit of 1–8");
  const scopedRepository = policy.canonical_repository(repository);
  if (!scopedRepository) throw Error("Expected a canonical GitHub repository");
  const plan = historyTargets(JSON.parse(boundedFile(manifestPath, 32 * 1024).toString("utf8")),
    scopedRepository, clockPolicy, admission, policy);
  const targets = new Map(plan.targets.map((target) => [plan.key(target), target] as const));
  if (!policy.target_count(targets.size)) throw Error("Expected at least one historical target");
  const store = openHistory(database, plan.source, scopedRepository, [...targets.keys()]);
  const deferred = new Set<string>();
  let readUnits = 0;
  try {
    while (readUnits < maxUnits) {
      let selected: ({ key: string } & ReturnType<typeof store.read>) | undefined;
      for (const key of targets.keys()) {
        if (deferred.has(key)) continue;
        const state = store.read(key);
        if (policy.pending(state.progress.status) && (!selected || policy.prefer(state.generation, selected.generation))) {
          selected = { key, ...state };
        }
      }
      if (!selected) break;
      const { key, generation, progress } = selected;
      readUnits++;
      try {
        const page = await plan.capture(targets.get(key), progress);
        if (!store.commit(key, generation, page.progress, page.change) || !page.advanced) deferred.add(key);
      } catch (error) {
        if ((error as { code?: string; errcode?: number }).code === "ERR_SQLITE_ERROR" &&
            ![1555, 2067].includes((error as { errcode: number }).errcode)) throw error;
        const failure = error instanceof SourceReadError ? error : null;
        const status = failure ? policy.HTTP_status(failure.status, failure.limited, failure.expired, failure.budget) : "partial";
        store.commit(key, generation, { ...progress, status });
        deferred.add(key);
        if (policy.stop_reads(status, failure?.expired ?? false)) break;
      }
    }
    const coverage: Record<string, number> = {};
    for (const key of targets.keys()) {
      const status = store.read(key).progress.status;
      coverage[status] = (coverage[status] ?? 0) + 1;
    }
    console.log(JSON.stringify({ source: plan.source, units: readUnits, coverage }));
    if (Object.keys(coverage).some(policy.pending)) process.exitCode = 2;
  } finally {
    store.close();
  }
}

async function main() {
  const [directory, repository, mode, ...args] = process.argv.slice(2);
  const windowMode = mode === "--window";
  const waitMode = mode === "--from-waits";
  const pollMode = mode === "--poll";
  const backfillMode = mode === "--backfill";
  if (!directory || !repository || !mode || args.length !== (windowMode ? 4 : waitMode ? 3 : pollMode ? 0 : 2)) {
    throw new Error([
      "Usage: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO RUN_ID ATTEMPT EXPECTED_SHA",
      "   or: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --window FROM TO MAX_PAGES MAX_ATTEMPTS",
      "   or: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --from-waits FROM TO MAX_ATTEMPTS",
      "   or: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --poll",
      "   or: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --backfill MANIFEST MAX_UNITS",
    ].join("\n"));
  }
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    const [source, admissionFile] = await buildPolicies(scratch, [
      [new URL("./github/clocks.bend", import.meta.url), "clocks.mjs"],
      [admissionPolicy, "admission.mjs"],
    ]);
    const admission = await loadPolicy<AdmissionPolicy>(admissionFile);
    const policy = await loadPolicy<ClockPolicy>(source);
    checkRepository(repository, policy);
    const database = join(resolve(directory), "evidence.sqlite");
    if (backfillMode) return await backfill(database, args[0], positiveInt(args[1]), repository, scratch, policy, admission);
    const read = githubReader(repository);
    if (pollMode) {
      const sources = await loadPolicy<SourcePolicy>(await buildPolicy(scratch, sourcePolicy, "sources.mjs"));
      const result = await pollGitHub(database, repository, sources, policy, admission, read);
      console.log(JSON.stringify(result));
      if (result.failed) throw Error("Poll completed with missing records");
      return;
    }
    if (waitMode) {
      const start = clock(args[0]);
      const end = clock(args[1]);
      const limit = positiveInt(args[2]);
      if (!policy.window_valid(start, end, 1, limit)) {
        throw new Error("Expected an ordered UTC seconds window and 1–20 attempts");
      }
      const plan = await actionsWaitCapturePlan(database, scratch, repository, { start: start * 1000, end: end * 1000 }, limit);
      const attempts = [];
      for (const identity of plan.attempts) attempts.push(await collectAttempt(identity, policy, read));
      if (attempts.length) loadEvidence(database, { source: "github-actions-window", attempts }, admission);
      console.log(JSON.stringify({ sourceAvailable: plan.sourceAvailable, missingBeforeCapture: plan.missing, captured: attempts.length }));
      return;
    }
    const { attempts, coverage } = windowMode
      ? await collectWindow(repository, args[0], args[1], positiveInt(args[2]), positiveInt(args[3]), policy, read)
      : { attempts: [await collectAttempt({
        repository, runId: positiveInt(mode), attempt: positiveInt(args[0]), sha: args[1],
      }, policy, read)], coverage: null };
    loadEvidence(database, { source: "github-actions-window", attempts }, admission);
    console.log(coverage ? JSON.stringify(coverage)
      : `Imported attempt ${attempts[0].attempt} with ${attempts[0].jobs.length} jobs into evidence.sqlite`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
