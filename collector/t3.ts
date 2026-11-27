import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildPolicies, loadPolicy } from "../tooling/bend.ts";
import { admissionPolicy, loadEvidence, repository, sourcePolicy, type AdmissionPolicy, type Point, type SourcePolicy, type ThreadEvidence } from "../evidence/index.ts";
import { array, bendList, millis, point, row, str, timeParts, toMillis, token } from "./wire.ts";
import { positiveInt } from "./github/attempt.ts";
import { inspectRollout } from "./codex/rollout.ts";

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
    return { repository: repository(link.repository, policy), number: positiveInt(link.number),
      source, state: policy.link_state(str(link.state)), owning: policy.owns_pr(source) };
  });
  return { instance: token(snapshot.instance), id: token(thread.threadId), created, updated,
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

async function main() {
  const [directory, t3Database, t3Instance, threadId, codexInstance, rollout, ...extra] = process.argv.slice(2);
  if (!directory || !t3Database || !t3Instance || !threadId || !codexInstance || !rollout || extra.length) {
    throw Error("Usage: t3.ts JOB_DIRECTORY T3_STATE_DB T3_INSTANCE THREAD_ID CODEX_INSTANCE ROLLOUT");
  }
  const evidence = join(resolve(directory), "evidence.sqlite");
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    const { policy, admission } = await buildSourcePolicies(scratch);
    console.log(JSON.stringify(await importLinkedRollout(evidence, t3Database, t3Instance, threadId,
      codexInstance, rollout, policy, admission)));
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
