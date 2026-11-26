import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEvidence } from "../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { collectAttempt, positiveInt, type ClockPolicy } from "./github/attempt.ts";

async function main() {
  const [directory, repository, run, number, sha, ...extra] = process.argv.slice(2);
  if (!directory || !repository || !run || !number || !sha || extra.length) {
    throw new Error("Usage: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO RUN_ID ATTEMPT EXPECTED_SHA");
  }
  const identity = { repository, runId: positiveInt(run), attempt: positiveInt(number), sha };
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    const source = await buildPolicy(scratch, new URL("./github/clocks.bend", import.meta.url), "clocks.mjs");
    const policy = await loadPolicy<ClockPolicy>(source);
    const evidence = collectAttempt(identity, policy);
    const database = join(resolve(directory), "evidence.sqlite");
    loadEvidence(database, { source: "github-actions", attempt: evidence });
    console.log(`Imported attempt ${evidence.attempt} with ${evidence.jobs.length} jobs into evidence.sqlite`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
