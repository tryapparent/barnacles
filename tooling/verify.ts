import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBoundaries, loadVerification, suiteDirectories } from "./check-boundaries.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const parent = process.env.BARNACLES_TEST_DIRECTORY;
const job = mkdtempSync(parent ? join(parent, "verify-") : "/tmp/apparent-dev-barnacles-verify-");
try {
  const env = { ...process.env, BARNACLES_TEST_DIRECTORY: job };
  delete env.NODE_TEST_CONTEXT;
  const policy = await loadVerification(job);
  const directories = suiteDirectories(policy, process.argv.slice(2));
  if (!await checkBoundaries(policy)) {
    process.exitCode = 1;
  } else {
    const tests = directories.flatMap((owner) => {
      const directory = resolve(cwd, owner);
      return readdirSync(directory, { recursive: true }).filter((file) => policy.is_test(file))
        .map((file) => join(directory, file)).sort();
    });
    if (!tests.length) throw Error("No tests found for the selected scopes");
    execFileSync(process.execPath, ["--test", ...tests], { cwd, env, stdio: "inherit" });
  }
} catch (error) {
  const status = (error as { status?: number }).status;
  if (typeof status !== "number") console.error(error);
  process.exitCode = status ?? 1;
} finally {
  rmSync(job, { recursive: true, force: true });
}
