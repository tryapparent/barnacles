import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { actionsWaitCapturePlan, admissionPolicy, loadEvidence, sourcePolicy, type AdmissionPolicy, type SourcePolicy } from "../evidence/index.ts";
import { buildPolicies, buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { checkRepository, clock, collectAttempt, collectWindow, githubReader, positiveInt, type ClockPolicy } from "./github/attempt.ts";
import { pollGitHub } from "./github/delivery.ts";

async function main() {
  const [directory, repository, mode, ...args] = process.argv.slice(2);
  const windowMode = mode === "--window";
  const waitMode = mode === "--from-waits";
  const pollMode = mode === "--poll";
  if (!directory || !repository || !mode || args.length !== (windowMode ? 4 : waitMode ? 3 : pollMode ? 0 : 2)) {
    throw new Error([
      "Usage: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO RUN_ID ATTEMPT EXPECTED_SHA",
      "   or: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --window FROM TO MAX_PAGES MAX_ATTEMPTS",
      "   or: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --from-waits FROM TO MAX_ATTEMPTS",
      "   or: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --poll",
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
    const read = githubReader(repository);
    const database = join(resolve(directory), "evidence.sqlite");
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
