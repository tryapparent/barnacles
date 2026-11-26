import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sourcePolicy, deliveryReport, loadEvidence, type SourcePolicy } from "../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { positiveInt } from "./github/attempt.ts";
import { pullRequest, releaseEvidence } from "./github/delivery.ts";
import { readRollout } from "./rollout.ts";
import { t3Snapshot } from "./t3.ts";

async function main() {
  const [directory, command, first, second, third, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || !(
    (command === "report" && !first) ||
    (command === "t3" && first && !second) ||
    (command === "rollout" && first && second && !third) ||
    (command === "github" && first && second)
  )) throw Error("Usage: import-sources.ts JOB_DIRECTORY { t3 SNAPSHOT | rollout INSTANCE FILE | github OWNER/REPO PR [TAG] | report }");

  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    const output = await buildPolicy(scratch, sourcePolicy, "sources.mjs");
    const policy: SourcePolicy = await loadPolicy(output);
    const db = join(resolve(directory), "evidence.sqlite");
    if (command === "t3") {
      const info = statSync(first);
      if (!info.isFile() || info.size > 1024 * 1024) throw Error("Expected a bounded T3 metadata snapshot");
      const data = t3Snapshot(JSON.parse(readFileSync(first, "utf8")), policy);
      loadEvidence(db, { source: "t3", thread: data });
      console.log(`Imported T3 metadata with ${data.runs.length} runs and ${data.pullRequests.length} PR links`);
    } else if (command === "rollout") {
      const data = await readRollout(second, first, policy);
      loadEvidence(db, { source: "codex", rollout: data });
      console.log(`Imported ${data.calls.length} tool calls, ${data.calls.filter((call) => call.asyncEnd !== null).length} linked async cells, and ${data.markers.length} reasoning markers`);
    } else if (command === "github") {
      const pr = pullRequest(first, positiveInt(second), policy, undefined, true);
      loadEvidence(db, { source: "github-delivery", pullRequest: pr });
      const release = third ? releaseEvidence(pr, third, policy, undefined, undefined, true) : undefined;
      if (release) loadEvidence(db, { source: "github-delivery", pullRequest: pr, release });
      console.log(release ? `Imported pull request and release evidence (access: ${release.accessible ? "verified" : "unverified"})`
        : "Imported pull request metadata");
    } else {
      console.log(JSON.stringify(deliveryReport(db, policy), null, 2));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
