import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suites = {
  hooks: [".githooks", "tooling/tests"],
  collector: ["collector"],
  evidence: ["evidence"],
  dashboard: ["dashboard"],
};
const requested = process.argv.slice(2);
const scopes = requested.length ? requested : Object.keys(suites);
if (scopes.some((scope) => !Object.hasOwn(suites, scope))) {
  throw Error("Usage: npm run verify -- [hooks] [collector] [evidence] [dashboard]");
}
const cwd = fileURLToPath(new URL("../", import.meta.url));
const parent = process.env.BARNACLES_TEST_DIRECTORY;
const job = mkdtempSync(parent ? join(parent, "verify-") : "/tmp/apparent-dev-barnacles-verify-");
try {
  const env = { ...process.env, BARNACLES_TEST_DIRECTORY: job };
  delete env.NODE_TEST_CONTEXT;
  execFileSync(process.execPath, ["tooling/check-boundaries.ts"], { cwd, env, stdio: "inherit" });
  const tests = scopes.flatMap((scope) => suites[scope as keyof typeof suites]).flatMap((owner) => {
    const directory = resolve(cwd, owner);
    return readdirSync(directory, { recursive: true }).filter((file) => file.endsWith(".test.ts"))
      .map((file) => join(directory, file)).sort();
  });
  if (!tests.length) throw Error("No tests found for the selected scopes");
  execFileSync(process.execPath, ["--test", ...tests], { cwd, env, stdio: "inherit" });
} catch (error) {
  const status = (error as { status?: number }).status;
  if (typeof status !== "number") console.error(error);
  process.exitCode = status ?? 1;
} finally {
  rmSync(job, { recursive: true, force: true });
}
