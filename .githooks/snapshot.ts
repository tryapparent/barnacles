import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hookCompilerDirectory, withHookPolicy } from "../tooling/bend.ts";
import { git, gitFields, gitText, list, rulesFile, values, type HookRules } from "./check-bend-paths.ts";

function snapshot(rules: HookRules, commit: string, destination: string) {
  if (!rules.valid_object_id(commit)) throw Error("Expected a Git commit ID and snapshot destination");
  for (const entry of gitFields("ls-tree", "-rz", "--full-tree", commit)) {
    const separator = entry.indexOf("\t");
    const [mode, type, blob] = entry.slice(0, separator).split(" ");
    const path = entry.slice(separator + 1);
    const permissions = rules.snapshot_mode(mode, type, path);
    if (!permissions) throw Error(`Cannot build a verification snapshot for ${JSON.stringify(path)}`);
    const file = resolve(destination, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, git("cat-file", "blob", blob), { flag: "wx", mode: permissions });
  }
}

function optionalGit(...args: string[]) {
  try {
    return gitText(...args);
  } catch {
    return "";
  }
}

function verifySnapshot(rules: HookRules, head: string, scopes: string[], bundle: string) {
  const scratch = mkdtempSync("/tmp/apparent-dev-barnacles-push-");
  try {
    const source = join(scratch, "source");
    mkdirSync(source);
    snapshot(rules, head, source);
    const env = { ...process.env, BARNACLES_TEST_DIRECTORY: scratch, BARNACLES_BEND_BUNDLE: bundle };
    for (const name of gitText("rev-parse", "--local-env-vars").split("\n")) delete env[name];
    delete env.NODE_TEST_CONTEXT;
    const options = { cwd: source, env, stdio: "inherit" as const };
    execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], options);
    console.error(`pre-push: checking ${scopes.join(" ")} tests at ${head}`);
    execFileSync("npm", ["run", "verify", "--", ...scopes], options);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function push(rules: HookRules, remote: string) {
  const main = optionalGit("rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/main^{commit}`);
  const bundle = hookCompilerDirectory();
  for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
    const [, localOid, remoteRef, remoteOid] = line.split(" ");
    const route = rules.push_base(localOid, remoteRef, remoteOid);
    if (route === "skip") continue;
    const head = gitText("rev-parse", "--verify", `${localOid}^{commit}`);
    const target = route === "main" ? main : route === "remote" ? remoteOid : "";
    const base = target && optionalGit("merge-base", head, target);
    if (!base) throw Error("Cannot identify the integration base. Fetch the remote main branch and retry.");
    if (!existsSync("node_modules/web-tree-sitter")) throw Error("Install Node 22.18+ and run npm ci --ignore-scripts.");
    for (const check of ["tooling/check-directory-width.ts", ".githooks/check-comments.ts", ".githooks/check-bend-paths.ts"]) {
      execFileSync(process.execPath, [check, base, head], { stdio: "inherit" });
    }
    const changed = gitFields("diff", "--name-only", "--no-renames", "-z", base, head, "--");
    const scopes = values(rules.push_scopes(list(changed)));
    if (scopes.length) verifySnapshot(rules, head, scopes, bundle);
  }
}

const [mode, argument] = process.argv.slice(2);
await withHookPolicy<HookRules>(rulesFile, (rules) => {
  if (mode === "--push" && argument) push(rules, argument);
  else if (mode && argument) snapshot(rules, mode, argument);
  else throw Error("Expected a Git commit ID and snapshot destination");
}).catch((error: Error & { status?: number }) => {
  if (typeof error.status !== "number") console.error(`pre-push: ${error.message}`);
  process.exitCode = error.status ?? 1;
});
