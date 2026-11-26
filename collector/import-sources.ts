import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  admissionPolicy, deliveryPolicy, deliveryReport, harborSnapshotPublisher, loadEvidence, readPollMinutes, repository,
  rolloutCoverage, sourcePolicy, waitReport, watchOverlaps, type AdmissionPolicy, type DeliveryPolicy, type SourcePolicy,
} from "../evidence/index.ts";
import { buildPolicy, buildPolicies, loadPolicy } from "../tooling/bend.ts";
import { positiveInt, type ClockPolicy } from "./github/attempt.ts";
import { pollGitHub, pullRequest, releaseEvidence } from "./github/delivery.ts";
import { inspectRollout } from "./codex/rollout.ts";
import { str, token } from "./wire.ts";
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
    (command === "watch-overlaps" && first && second && third && fourth) ||
    (command === "t3" && first && !second) ||
    (command === "rollout" && first && second && !fourth) ||
    (command === "github" && first && second && !fourth) ||
    (command === "poll-github" && first && second && (!third || third === "--once") && !fourth)
  )) throw Error("Usage: import-sources.ts JOB_DIRECTORY { t3 SNAPSHOT | rollout INSTANCE FILE [SOURCE_ID] | github OWNER/REPO PR [TAG] | poll-github OWNER/REPO HARBOR_SNAPSHOT [--once] | report | rollout-coverage | waits [SESSION [CALL]] | watch-overlaps OWNER/REPO RUN SHA ATTEMPT }");

  const db = join(resolve(directory), "evidence.sqlite");
  if (command === "waits") {
    console.log(JSON.stringify(waitReport(db, first ? token(first) : null, second ? token(second) : null), null, 2));
    return;
  }
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
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

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
