import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  admissionPolicy, deliveryPolicy, deliveryReport, harborSnapshotPublisher, loadEvidence, readPollMinutes, repository,
  processTimingPolicy, rolloutCoverage, saveKernelCapture, sourcePolicy, waitReport, watchOverlaps, type AdmissionPolicy, type DeliveryPolicy, type KernelPolicy, type List, type SourcePolicy,
} from "../evidence/index.ts";
import { buildPolicy, buildPolicies, loadPolicy } from "../tooling/bend.ts";
import { positiveInt, type ClockPolicy } from "./github/attempt.ts";
import { pollGitHub, pullRequest, releaseEvidence } from "./github/delivery.ts";
import { inspectRollout } from "./codex/rollout.ts";
import { bendValues, kernelCapture, kernelInteger, row, seconds, sha, str, token } from "./wire.ts";
import { t3Snapshot } from "./t3.ts";

async function poll(db: string, scratch: string, repo: string, snapshot: string, policy: SourcePolicy, admission: AdmissionPolicy, once: boolean) {
  const configured = process.env.BARNACLES_POLL_SETTINGS;
  if (!configured) throw Error("Set BARNACLES_POLL_SETTINGS to the shared polling settings file");
  const settings = resolve(configured);
  const publish = harborSnapshotPublisher(resolve(snapshot), repo, scratch);
  let minutes = readPollMinutes(settings);
  const clocks = await loadPolicy<ClockPolicy>(
    await buildPolicy(scratch, new URL("./github/clocks.bend", import.meta.url), "clocks.mjs"));
  let reportedSettingsError = false;
  for (;;) {
    try {
      const result = pollGitHub(db, repo, policy, clocks, admission);
      await publish(db);
      console.log(JSON.stringify(result));
      if (once && result.failed) throw Error("GitHub poll completed with missing records");
    } catch (error) {
      if (once) throw error;
      console.error(`GitHub poll failed: ${(error as Error).message}`);
    }
    if (once) return;
    const finished = performance.now();
    for (;;) {
      try {
        minutes = readPollMinutes(settings);
        reportedSettingsError = false;
      } catch (error) {
        if (!reportedSettingsError) console.error((error as Error).message);
        reportedSettingsError = true;
      }
      const remaining = finished + minutes * 60_000 - performance.now();
      if (remaining <= 0) break;
      await sleep(Math.min(5000, remaining));
    }
  }
}

async function main() {
  const [directory, command, first, second, third, fourth, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || !(
    ((command === "report" || command === "rollout-coverage") && !first) ||
    (command === "waits" && !third) ||
    (command === "bottlenecks" && first && !second) ||
    (command === "watch-overlaps" && first && second && third && fourth) ||
    (command === "process" && first && second && third && !fourth) ||
    (command === "process-probe" && first && second && !third) ||
    (command === "t3" && first && !second) ||
    (command === "rollout" && first && second && !fourth) ||
    (command === "github" && first && second && !fourth) ||
    (command === "poll-github" && first && second && (!third || third === "--once") && !fourth)
  )) throw Error("Usage: import-sources.ts JOB_DIRECTORY { t3 SNAPSHOT | rollout INSTANCE FILE [SOURCE_ID] | github OWNER/REPO PR [TAG] | poll-github OWNER/REPO HARBOR_SNAPSHOT [--once] | process BINDING EVENTS DIAGNOSTICS | process-probe PARENT_PID WORK_DIRECTORY | report | rollout-coverage | waits [SESSION [CALL]] | watch-overlaps OWNER/REPO RUN SHA ATTEMPT | bottlenecks FACTS.ndjson }");

  const db = join(resolve(directory), "evidence.sqlite");
  if (command === "waits") {
    console.log(JSON.stringify(waitReport(db, first ? token(first) : null, second ? token(second) : null), null, 2));
    return;
  }
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    if (command === "bottlenecks") {
      console.log(JSON.stringify(await replayBottlenecks(first, scratch), null, 2));
      return;
    }
    if (command === "process" || command === "process-probe") {
      const policy = await loadPolicy<KernelPolicy>(await buildPolicy(scratch, processTimingPolicy, "process-timing.mjs"));
      if (command === "process") {
        console.log(JSON.stringify(saveKernelCapture(db, kernelCapture(first, second, third), policy)));
      } else {
        const parent = kernelInteger(first);
        const uid = process.getuid?.();
        const directory = statSync(second, { bigint: true });
        if (uid === undefined || statSync(`/proc/${parent}`).uid !== uid || !directory.isDirectory()) {
          throw Error("Expected a Linux worker owned by the caller and an existing work directory");
        }
        const dev = directory.dev;
        const major = ((dev >> 8n) & 4095n) | ((dev >> 32n) & ~4095n);
        const minor = (dev & 255n) | ((dev >> 12n) & ~255n);
        process.stdout.write(policy.probe(parent, uid, Number(major), Number(minor), kernelInteger(Number(directory.ino))));
      }
      return;
    }
    if (command === "rollout-coverage") {
      console.log(JSON.stringify(rolloutCoverage(db), null, 2));
      return;
    }
    if (command === "report") {
      const file = await buildPolicy(scratch, deliveryPolicy, "delivery.mjs");
      console.log(JSON.stringify(deliveryReport(db, await loadPolicy<DeliveryPolicy>(file)), null, 2));
      return;
    }
    const [output, admissionFile] = await buildPolicies(scratch, [[sourcePolicy, "sources.mjs"], [admissionPolicy, "admission.mjs"]]);
    const admission = await loadPolicy<AdmissionPolicy>(admissionFile);
    const policy: SourcePolicy = await loadPolicy(output);
    if (command === "poll-github") {
      await poll(db, scratch, repository(first, policy), second, policy, admission, third === "--once");
    } else if (command === "t3") {
      const info = statSync(first);
      if (!info.isFile() || info.size > 1024 * 1024) throw Error("Expected a bounded T3 metadata snapshot");
      const data = t3Snapshot(JSON.parse(readFileSync(first, "utf8")), policy);
      loadEvidence(db, { source: "t3", thread: data }, admission);
      console.log(`Imported T3 metadata with ${data.runs.length} runs and ${data.pullRequests.length} PR links`);
    } else if (command === "rollout") {
      const { receipt, data } = await inspectRollout(second, first, policy, third);
      if (!data) {
        loadEvidence(db, { source: "codex-rejected", receipt }, admission);
        throw Error(`Rollout admission failed (${receipt.status})`);
      }
      loadEvidence(db, { source: "codex", rollout: data }, admission);
      console.log(JSON.stringify({ ...receipt, calls: data.calls.length, markers: data.markers.length,
        orphans: data.orphans, quality: data.quality }));
    } else if (command === "github") {
      const pr = pullRequest(first, positiveInt(second), policy, undefined, true);
      loadEvidence(db, { source: "github-delivery", pullRequest: pr }, admission);
      const release = third ? releaseEvidence(pr, third, policy, undefined, undefined, true) : undefined;
      if (release) loadEvidence(db, { source: "github-delivery", pullRequest: pr, release }, admission);
      console.log(release ? `Imported pull request and release evidence (access: ${release.accessible ? "verified" : "unverified"})`
        : "Imported pull request metadata");
    } else if (command === "watch-overlaps") {
      const workflow = policy.watch_identity(str(first), str(second), str(third), str(fourth));
      if (workflow.$ !== "ExactWatch") throw Error("Expected an exact GitHub workflow identity");
      console.log(JSON.stringify(watchOverlaps(db, policy, workflow), null, 2));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type ReplayPolicy = {
  start_replay(): unknown;
  observe_file(state: unknown, thread: string, id: string, path: string, at: number): unknown;
  observe_timing(state: unknown, id: string, clock: string, operation: string, start: number, end: number): unknown;
  observe_attempt(state: unknown, thread: string, id: string, key: string, start: number, end: number,
    failed: boolean, succeeded: boolean): unknown;
  observe_hosted_test_failure(state: unknown, thread: string, id: string, scope: string, lane: string, test: string,
    execution: string, conclusion: string, at: number): unknown;
  observe_hosted_test_fanout(state: unknown, thread: string, id: string, scope: string, lane: string, revision: string,
    failure: string, conclusion: string, at: number): unknown;
  observe_verification_poll(state: unknown, thread: string, id: string, turn: string, invocation: string,
    status: string, at: number): unknown;
  observe_package_build(state: unknown, thread: string, id: string, scope: string, tool: string, digest: string,
    assets: number, reportedMs: number, start: number, end: number): unknown;
  observe_peer(state: unknown, thread: string, id: string, clock: string, cohort: string, revision: string,
    start: number, end: number, eligible: boolean): unknown;
  observe_hosted_admission(state: unknown, thread: string, id: string, conclusion: string,
    assigned: boolean, steps: number, annotation: string): unknown;
  observe_pr_notice(state: unknown, thread: string, id: string, sourceThread: string, visibility: string,
    status: string, truncated: boolean, linkedPr: number, message: string): unknown;
  observe_pr_watch_wake(state: unknown, thread: string, id: string, watchId: string, number: number, message: string,
    registered: number, parked: number, notified: number, priorOrdinal: number, nextOrdinal: number,
    noticeStamp: string, requestedStamp: string): unknown;
  observe_forge_response(state: unknown, thread: string, id: string, operation: string, status: number,
    failed: boolean, identified: boolean): unknown;
  observe_actions_rate_limit(state: unknown, thread: string, id: string, operation: string, status: number,
    line: string, failed: boolean): unknown;
  observe_job_rerun(state: unknown, thread: string, id: string, job: string, line: string, failed: boolean): unknown;
  observe_local_admission(state: unknown, thread: string, id: string, waitMs: number, boundMs: number,
    allocated: number, capacity: number): unknown;
  observe_hosted_apt(state: unknown, thread: string, id: string, conclusion: string, exitCode: number,
    httpStatus: number, archive: string, summary: string): unknown;
  observe_apt_mirror_probe(state: unknown, thread: string, id: string, step: string, conclusion: string,
    exitCode: number, mirrorA: string, mirrorB: string, line: string, started: number, ended: number): unknown;
  observe_vm_result(state: unknown, thread: string, id: string, stage: string, failureType: string, exitCode: number,
    driverExit: number, scenarioStarted: boolean, command: string, line: string, required: string, elapsedMs: number): unknown;
  observe_workflow_gate(state: unknown, thread: string, id: string, job: string, prerequisite: string,
    attemptStarted: number, earliestJobStarted: number, previousCompleted: number, gateCompleted: number,
    dependentStarted: number): unknown;
  observe_native_model_fetch(state: unknown, thread: string, id: string, step: string, conclusion: string,
    exitCode: number, status: number, revision: string, line: string, origin: string, started: number, ended: number): unknown;
  observe_toolchain_fetch(state: unknown, thread: string, id: string, step: string, conclusion: string,
    exitCode: number, status: number, asset: string, line: string, origin: string, started: number, ended: number): unknown;
  observe_local_admission_timeout(state: unknown, thread: string, id: string, exitCode: number, line: string): unknown;
  observe_socket_preflight(state: unknown, thread: string, id: string, required: number, limit: number,
    line: string, origin: string): unknown;
  observe_capture_access(state: unknown, thread: string, id: string, operation: string, line: string,
    failed: boolean): unknown;
  observe_hosted_publish(state: unknown, thread: string, id: string, publisher: string, conclusion: string,
    exitCode: number, status: number, line: string): unknown;
  observe_benchmark_marker(state: unknown, thread: string, id: string, lane: string, conclusion: string,
    exitCode: number, sameBuild: boolean, line: string, started: number, ended: number): unknown;
  observe_benchmark_pressure(state: unknown, thread: string, id: string, lane: string, source: string, conclusion: string,
    exitCode: number, sameBuild: boolean, qualified: boolean, scorePresent: boolean, pressureRejected: boolean,
    started: number, ended: number): unknown;
  observe_benchmark_admission(state: unknown, thread: string, id: string, lane: string, conclusion: string,
    exitCode: number, line: string, origin: string, started: number, ended: number): unknown;
  observe_hosted_deploy(state: unknown, thread: string, id: string, service: string, conclusion: string,
    exitCode: number, line: string, phaseLine: string, accepted: boolean): unknown;
  observe_connect_deployment(state: unknown, thread: string, id: string, conclusion: string, exitCode: number,
    revision: string, receiptRevision: string, phase: string, line: string, origin: string, previousVersion: string,
    comparedVersion: string, started: number, ended: number): unknown;
  observe_job_result(state: unknown, thread: string, id: string, conclusion: string): unknown;
  observe_diagnostic(state: unknown, thread: string, id: string, line: string, failed: boolean): unknown;
  replay_files(state: unknown): List<Record<string, unknown>>;
  replay_costs(state: unknown): List<Record<string, unknown>>;
  replay_findings(state: unknown): List<Record<string, unknown>>;
};

function clockSecond(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw Error("Expected an unsigned Unix second");
  }
  return value;
}

function factText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Error("Expected a bounded fact label");
  }
  return value;
}

function bendBool(value: unknown): boolean {
  if (typeof value !== "boolean") throw Error("Expected a boolean fact");
  return value;
}

async function replayBottlenecks(file: string, scratch: string) {
  const info = statSync(file);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw Error("Expected a bounded bottleneck fact stream");
  const compiled = await buildPolicy(scratch, new URL("../evidence/analysis/bottleneck.bend", import.meta.url), "bottleneck.mjs");
  const policy = await loadPolicy<ReplayPolicy>(compiled);
  let state = policy.start_replay();
  let lineNumber = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    lineNumber++;
    try {
      if (line.length > 4096) throw Error("Oversized fact");
      const value = row(JSON.parse(line));
      const id = token(value.id);
      if (value.kind === "file") {
        state = policy.observe_file(state, token(value.thread), id, factText(value.path), clockSecond(value.at));
      } else if (value.kind === "timing") {
        state = policy.observe_timing(state, id, token(value.clock), factText(value.operation),
          clockSecond(value.start), clockSecond(value.end));
      } else if (value.kind === "attempt") {
        state = policy.observe_attempt(state, token(value.thread), id, factText(value.key),
          clockSecond(value.start), clockSecond(value.end), bendBool(value.failed), bendBool(value.succeeded));
      } else if (value.kind === "hosted-test-failure") {
        state = policy.observe_hosted_test_failure(state, token(value.thread), id, token(value.scope), token(value.lane),
          token(value.test), token(value.execution), token(value.conclusion), clockSecond(value.at));
      } else if (value.kind === "hosted-test-fanout") {
        state = policy.observe_hosted_test_fanout(state, token(value.thread), id, token(value.scope), token(value.lane),
          sha(value.revision), token(value.failure), token(value.conclusion), clockSecond(value.at));
      } else if (value.kind === "local-verification-poll") {
        state = policy.observe_verification_poll(state, token(value.thread), id, token(value.turn), token(value.invocation),
          token(value.state), clockSecond(value.at));
      } else if (value.kind === "package-build-result") {
        state = policy.observe_package_build(state, token(value.thread), id, token(value.scope), token(value.tool),
          token(value.digest), clockSecond(value.assets), clockSecond(value.reportedMs), clockSecond(value.start),
          clockSecond(value.end));
      } else if (value.kind === "hosted-admission") {
        state = policy.observe_hosted_admission(state, token(value.thread), id, token(value.conclusion),
          bendBool(value.assigned), clockSecond(value.steps), factText(value.annotation));
      } else if (value.kind === "t3-pr-notice") {
        state = policy.observe_pr_notice(state, token(value.thread), id, token(value.sourceThread),
          token(value.visibility), token(value.status), bendBool(value.truncated), clockSecond(value.linkedPr),
          factText(value.message));
      } else if (value.kind === "t3-pr-watch-wake") {
        const noticeStamp = factText(value.noticeStamp);
        state = policy.observe_pr_watch_wake(state, token(value.thread), id, token(value.watchId),
          clockSecond(value.number), factText(value.message), clockSecond(value.registeredAt), clockSecond(value.parkedAt),
          seconds(noticeStamp), clockSecond(value.priorOrdinal), clockSecond(value.nextOrdinal),
          noticeStamp, factText(value.requestedStamp));
      } else if (value.kind === "forge-response") {
        state = policy.observe_forge_response(state, token(value.thread), id, token(value.operation),
          clockSecond(value.status), bendBool(value.failed), bendBool(value.identified));
      } else if (value.kind === "actions-rate-limit") {
        state = policy.observe_actions_rate_limit(state, token(value.thread), id, token(value.operation),
          clockSecond(value.status), factText(value.line), bendBool(value.failed));
      } else if (value.kind === "job-rerun-response") {
        state = policy.observe_job_rerun(state, token(value.thread), id, token(value.job),
          factText(value.line), bendBool(value.failed));
      } else if (value.kind === "local-build-admission") {
        state = policy.observe_local_admission(state, token(value.thread), id, clockSecond(value.waitMs),
          clockSecond(value.boundMs), clockSecond(value.allocated), clockSecond(value.capacity));
      } else if (value.kind === "hosted-apt-result") {
        state = policy.observe_hosted_apt(state, token(value.thread), id, token(value.conclusion),
          clockSecond(value.exitCode), clockSecond(value.httpStatus), factText(value.archive), factText(value.summary));
      } else if (value.kind === "apt-mirror-probe") {
        state = policy.observe_apt_mirror_probe(state, token(value.thread), id, factText(value.step), token(value.conclusion),
          clockSecond(value.exitCode), factText(value.mirrorA), factText(value.mirrorB), factText(value.line),
          clockSecond(value.started), clockSecond(value.ended));
      } else if (value.kind === "vm-driver-result") {
        state = policy.observe_vm_result(state, token(value.thread), id, token(value.stage), token(value.failureType),
          clockSecond(value.exitCode), clockSecond(value.driverExit), bendBool(value.scenarioStarted), token(value.command),
          factText(value.line), token(value.required), clockSecond(value.elapsedMs));
      } else if (value.kind === "workflow-status-gate") {
        state = policy.observe_workflow_gate(state, token(value.thread), id, value.workflow == null ? "" : token(value.workflow),
          token(value.dependentJob),
          token(value.prerequisite), clockSecond(value.attemptStarted), clockSecond(value.earliestJobStarted),
          clockSecond(value.previousCompleted), clockSecond(value.gateCompleted), clockSecond(value.dependentStarted));
      } else if (value.kind === "pre-push-timing-fixture") {
        state = policy.observe_pre_push_timing_fixture(state, token(value.thread), id, token(value.operation),
          token(value.setting), factText(value.fixture), factText(value.actual), factText(value.expected),
          factText(value.line), bendBool(value.failed), clockSecond(value.suiteElapsedMs));
      } else if (value.kind === "main-verification-reuse") {
        state = policy.observe_main_reuse_refusal(state, token(value.thread), id, token(value.event),
          factText(value.step), token(value.conclusion), factText(value.line));
      } else if (value.kind === "hermes-validator-cache-copy") {
        state = policy.observe_hermes_cache_merge(state, token(value.thread), id, factText(value.step),
          token(value.conclusion), clockSecond(value.exitCode), token(value.code), token(value.syscall),
          factText(value.origin), bendBool(value.restored));
      } else if (value.kind === "local-verification-boundary") {
        state = policy.observe_local_verify_boundary(state, token(value.thread), id, token(value.operation),
          token(value.boundary), factText(value.line), factText(value.terminal), bendBool(value.failed));
      } else if (value.kind === "exact-pr-check-observer") {
        state = policy.observe_exact_pr_check_wait(state, token(value.thread), id, factText(value.repository),
          clockSecond(value.pr), sha(value.revision), factText(value.beforeRepository), clockSecond(value.beforePr),
          sha(value.beforeRevision), factText(value.afterRepository), clockSecond(value.afterPr), sha(value.afterRevision),
          clockSecond(value.exitCode), clockSecond(value.timeoutSeconds), clockSecond(value.elapsedMs));
      } else if (value.kind === "hosted-client-approval-fixture") {
        state = policy.observe_hosted_approval_fixture(state, token(value.thread), id, factText(value.step),
          token(value.conclusion), factText(value.test), factText(value.line), factText(value.origin));
      } else if (value.kind === "hosted-apt-job-deadline") {
        state = policy.observe_apt_job_deadline(state, token(value.thread), id, factText(value.step), token(value.package),
          token(value.jobConclusion), token(value.stepConclusion), clockSecond(value.deadlineSeconds),
          clockSecond(value.attemptStarted), clockSecond(value.jobStarted), clockSecond(value.jobEnded),
          clockSecond(value.started), clockSecond(value.ended));
      } else if (value.kind === "native-model-fetch-result") {
        state = policy.observe_native_model_fetch(state, token(value.thread), id, factText(value.step), token(value.conclusion),
          clockSecond(value.exitCode), clockSecond(value.status), sha(value.revision), factText(value.line), factText(value.origin),
          clockSecond(value.started), clockSecond(value.ended));
      } else if (value.kind === "toolchain-fetch-result") {
        state = policy.observe_toolchain_fetch(state, token(value.thread), id, factText(value.step), token(value.conclusion),
          clockSecond(value.exitCode), clockSecond(value.status), factText(value.asset), factText(value.line),
          factText(value.origin), clockSecond(value.started), clockSecond(value.ended));
      } else if (value.kind === "local-admission-timeout") {
        state = policy.observe_local_admission_timeout(state, token(value.thread), id, clockSecond(value.exitCode),
          factText(value.line));
      } else if (value.kind === "socket-preflight") {
        state = policy.observe_socket_preflight(state, token(value.thread), id, clockSecond(value.required),
          clockSecond(value.limit), factText(value.line), factText(value.origin));
      } else if (value.kind === "capture-access-result") {
        state = policy.observe_capture_access(state, token(value.thread), id, token(value.operation), factText(value.line),
          bendBool(value.failed));
      } else if (value.kind === "hosted-publish-result") {
        state = policy.observe_hosted_publish(state, token(value.thread), id, token(value.publisher),
          token(value.conclusion), clockSecond(value.exitCode), clockSecond(value.status), factText(value.line));
      } else if (value.kind === "benchmark-marker") {
        state = policy.observe_benchmark_marker(state, token(value.thread), id, token(value.lane),
          token(value.conclusion), clockSecond(value.exitCode), bendBool(value.sameBuild), factText(value.line),
          clockSecond(value.started), clockSecond(value.ended));
      } else if (value.kind === "benchmark-pressure") {
        state = policy.observe_benchmark_pressure(state, token(value.thread), id, token(value.lane), token(value.source),
          token(value.conclusion), clockSecond(value.exitCode), bendBool(value.sameBuild), bendBool(value.qualified),
          bendBool(value.scorePresent), bendBool(value.pressureRejected), clockSecond(value.started), clockSecond(value.ended));
      } else if (value.kind === "benchmark-admission") {
        state = policy.observe_benchmark_admission(state, token(value.thread), id, token(value.lane), token(value.conclusion),
          clockSecond(value.exitCode), factText(value.line), factText(value.origin), clockSecond(value.started),
          clockSecond(value.ended));
      } else if (value.kind === "hosted-deploy-result") {
        state = policy.observe_hosted_deploy(state, token(value.thread), id, token(value.service),
          token(value.conclusion), clockSecond(value.exitCode), factText(value.line), factText(value.phaseLine), bendBool(value.accepted));
      } else if (value.kind === "connect-deployment-receipt") {
        state = policy.observe_connect_deployment(state, token(value.thread), id, token(value.conclusion),
          clockSecond(value.exitCode), sha(value.revision), sha(value.receiptRevision), token(value.phase),
          factText(value.line), factText(value.origin), value.previousVersion == null ? "" : token(value.previousVersion),
          value.comparedVersion == null ? "" : token(value.comparedVersion), clockSecond(value.started), clockSecond(value.ended));
      } else if (value.kind === "job-result") {
        state = policy.observe_job_result(state, token(value.thread), id, token(value.conclusion));
      } else if (value.kind === "diagnostic") {
        state = policy.observe_diagnostic(state, token(value.thread), id, factText(value.line), bendBool(value.failed));
      } else if (value.kind === "peer") {
        state = policy.observe_peer(state, token(value.thread), id, token(value.clock), factText(value.cohort),
          token(value.revision), clockSecond(value.start), clockSecond(value.end), bendBool(value.eligible));
      } else {
        throw Error("Unknown bottleneck fact kind");
      }
    } catch (error) {
      throw Error(`Invalid bottleneck fact at line ${lineNumber}`, { cause: error });
    }
  }
  return { version: 1, files: Array.from(bendValues(policy.replay_files(state))),
    costs: Array.from(bendValues(policy.replay_costs(state))),
    findings: Array.from(bendValues(policy.replay_findings(state))) };
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
