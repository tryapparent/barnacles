import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourcePolicy, deliveryReport, rolloutCoverage, waitReport, watchOverlaps, loadEvidence, type SourcePolicy } from "../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { positiveInt } from "./github/attempt.ts";
import { pullRequest, releaseEvidence } from "./github/delivery.ts";
import { inspectRollout } from "./codex/rollout.ts";
import { str, token } from "./wire.ts";
import { t3Snapshot } from "./t3.ts";

async function main() {
  const [directory, command, first, second, third, fourth, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || !(
    ((command === "report" || command === "rollout-coverage") && !first) ||
    (command === "waits" && !third) ||
    (command === "watch-overlaps" && first && second && third && fourth) ||
    (command === "t3" && first && !second) ||
    (command === "rollout" && first && second && !fourth) ||
    (command === "github" && first && second && !fourth)
  )) throw Error("Usage: import-sources.ts JOB_DIRECTORY { t3 SNAPSHOT | rollout INSTANCE FILE [SOURCE_ID] | github OWNER/REPO PR [TAG] | report | rollout-coverage | waits [SESSION [CALL]] | watch-overlaps OWNER/REPO RUN SHA ATTEMPT }");

  const db = join(resolve(directory), "evidence.sqlite");
  if (command === "waits") {
    console.log(JSON.stringify(waitReport(db, first ? token(first) : null, second ? token(second) : null), null, 2));
    return;
  }
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    const output = await buildPolicy(scratch, sourcePolicy, "sources.mjs");
    const policy: SourcePolicy = await loadPolicy(output);
    if (command === "t3") {
      const info = statSync(first);
      if (!info.isFile() || info.size > 1024 * 1024) throw Error("Expected a bounded T3 metadata snapshot");
      const data = t3Snapshot(JSON.parse(readFileSync(first, "utf8")), policy);
      loadEvidence(db, { source: "t3", thread: data });
      console.log(`Imported T3 metadata with ${data.runs.length} runs and ${data.pullRequests.length} PR links`);
    } else if (command === "rollout") {
      const { receipt, data } = await inspectRollout(second, first, policy, third);
      if (!data) {
        loadEvidence(db, { source: "codex-rejected", receipt });
        throw Error(`Rollout admission failed (${receipt.status})`);
      }
      loadEvidence(db, { source: "codex", rollout: data });
      console.log(JSON.stringify({ ...receipt, calls: data.calls.length, markers: data.markers.length,
        orphans: data.orphans, quality: data.quality }));
    } else if (command === "github") {
      const pr = pullRequest(first, positiveInt(second), policy, undefined, true);
      loadEvidence(db, { source: "github-delivery", pullRequest: pr });
      const release = third ? releaseEvidence(pr, third, policy, undefined, undefined, true) : undefined;
      if (release) loadEvidence(db, { source: "github-delivery", pullRequest: pr, release });
      console.log(release ? `Imported pull request and release evidence (access: ${release.accessible ? "verified" : "unverified"})`
        : "Imported pull request metadata");
    } else if (command === "watch-overlaps") {
      const workflow = policy.watch_identity(str(first), str(second), str(third), str(fourth));
      if (workflow.$ !== "ExactWatch") throw Error("Expected an exact GitHub workflow identity");
      console.log(JSON.stringify(watchOverlaps(db, policy, workflow), null, 2));
    } else {
      console.log(JSON.stringify(command === "report" ? deliveryReport(db, policy) : rolloutCoverage(db), null, 2));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
