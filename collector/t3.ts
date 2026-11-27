import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildPolicies, buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { admissionPolicy, joinSession, loadEvidence, repository, sessionJoinPolicy, sourcePolicy, type AdmissionPolicy, type NativeBinding, type SessionJoinPolicy, type Point, type SourcePolicy, type ThreadEvidence } from "../evidence/index.ts";
import { array, bendList, millis, point, row, sha, str, timeParts, toMillis, token } from "./wire.ts";
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

async function fetchNativeReferences(endpoint: string, bearer: string, threadId: string): Promise<unknown[]> {
  const origin = new URL(endpoint);
  const local = origin.hostname === "127.0.0.1" || origin.hostname === "[::1]" || origin.hostname === "localhost";
  if (!(origin.protocol === "https:" || local && origin.protocol === "http:") ||
      origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw Error("Expected an HTTPS T3 origin or a loopback HTTP origin");
  }
  const response = await fetch(new URL("/api/auth/websocket-ticket", origin), {
    method: "POST", headers: { Authorization: `Bearer ${bearer}` }, redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error(`T3 websocket ticket request failed (${response.status})`);
  const { ticket } = row(await response.json());
  if (typeof ticket !== "string" || !ticket || ticket.length > 4096) throw Error("Invalid T3 websocket ticket");
  const address = new URL("/ws", origin);
  address.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  address.searchParams.set("orchestrationProtocol", "2");
  address.searchParams.set("wsTicket", ticket);
  const socket = new WebSocket(address);
  try {
    return await new Promise<unknown[]>((fulfill, reject) => {
      function fail() { reject(Error("T3 thread projection could not be read")); }
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        _tag: "Request", id: "1", tag: "orchestration.getThreadProjection", payload: { threadId }, headers: [],
      })));
      socket.addEventListener("message", (message) => {
        try {
          if (typeof message.data !== "string" || message.data.length > 8 * 1024 * 1024) return fail();
          for (const item of [JSON.parse(message.data)].flat()) {
            const frame = row(item);
            if (frame._tag !== "Exit" || frame.requestId !== "1") continue;
            const result = row(frame.exit);
            if (result._tag !== "Success") return fail();
            fulfill(array(row(result.value).providerThreads, 64));
          }
        } catch {
          fail();
        }
      });
      AbortSignal.timeout(8000).addEventListener("abort", fail, { once: true });
    });
  } finally {
    socket.close();
  }
}

async function importLiveSession(evidence: string, scratch: string, bindingPath: string, traces: string) {
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

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "T3 rollout import failed");
    process.exitCode = 1;
  });
}
