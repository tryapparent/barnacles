import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { saveAttempt } from "../evidence/actions.ts";
import { buildClocks } from "./build.ts";
import { collectAttempt, positiveInt } from "./github/attempt.ts";

async function main() {
  const [directory, repository, run, number, sha, ...extra] = process.argv.slice(2);
  if (!directory || !repository || !run || !number || !sha || extra.length) {
    throw new Error("Usage: node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO RUN_ID ATTEMPT EXPECTED_SHA");
  }
  const identity = { repository, runId: positiveInt(run), attempt: positiveInt(number), sha };
  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    const source = await buildClocks(scratch);
    const policy = (await import(pathToFileURL(source).href)).default;
    const evidence = collectAttempt(identity, policy);
    const database = join(resolve(directory), "evidence.sqlite");
    closeSync(openSync(database, "a", 0o600));
    saveAttempt(database, evidence);
    console.log(`Imported attempt ${evidence.attempt} with ${evidence.jobs.length} jobs into evidence.sqlite`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
