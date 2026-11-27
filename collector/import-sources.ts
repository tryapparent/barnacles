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
import { bendValues, kernelCapture, kernelInteger, row, str, token } from "./wire.ts";
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
  observe_peer(state: unknown, thread: string, id: string, clock: string, cohort: string, revision: string,
    start: number, end: number, eligible: boolean): unknown;
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
