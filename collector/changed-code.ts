import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { List } from "../evidence/sources.ts";
import { buildPolicy } from "./build.ts";

type PathCount = { $: "ChangedPath"; path: string; commits: number };
type Policy = {
  empty_counts(): unknown;
  count_commit(counts: unknown, paths: List<string>, shallowBoundary: boolean): unknown;
  top_paths(counts: unknown): List<PathCount>;
};

function* decodeLog(output: string) {
  const fields = output.split("\0");
  let index = 0;
  while (index < fields.length - 1) {
    if (fields[index++] !== "") throw Error("Expected a Git commit separator");
    const commit = fields[index++];
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw Error("Expected a Git commit ID");
    const paths: string[] = [];
    while (fields[index]) {
      const field = fields[index++];
      if (paths.length === 0 && !field.startsWith("\n")) throw Error("Expected a Git path separator");
      paths.push(paths.length === 0 ? field.slice(1) : field);
    }
    yield { commit, paths };
  }
  if (fields[index] !== "") throw Error("Expected a terminated Git log");
}

function encodePath(path: string) {
  const bytes = Buffer.from(path, "latin1");
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded).equals(bytes) ? { path: decoded } : { pathBytesBase64: bytes.toString("base64") };
}

async function main() {
  const [directory, repository, revision = "HEAD", limit = "1000", ...extra] = process.argv.slice(2);
  const maxCommits = Number(limit);
  if (!directory || !repository || extra.length || !/^\d{1,5}$/.test(limit) || maxCommits < 1 || maxCommits > 10_000) {
    throw Error("Usage: changed-code.ts JOB_DIRECTORY REPOSITORY [REVISION [MAX_COMMITS (1–10000)]]");
  }

  const git = (...args: string[]) => execFileSync("git", ["--no-replace-objects", ...args], {
    cwd: repository,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: "" },
    encoding: "latin1",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tip = git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`).trim();
  const shallow = git("rev-parse", "--is-shallow-repository").trim() === "true";
  const boundaries = shallow
    ? new Set(readFileSync(Buffer.from(git("rev-parse", "--path-format=absolute", "--git-path", "shallow").trimEnd(),
      "latin1"), "utf8").split("\n"))
    : new Set<string>();
  const history = git("log", "--no-merges", "--root", "--topo-order", `--max-count=${maxCommits + 1}`,
    "--no-decorate", "--no-notes", "--no-show-signature", "--no-color", "--no-relative", "--no-renames",
    "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--name-only", "-z", "--format=tformat:%x00%H", tip, "--");

  const scratch = mkdtempSync(join(resolve(directory), "build-"));
  try {
    const output = await buildPolicy(scratch, new URL("../evidence/changed-code.bend", import.meta.url), "changed-code.mjs");
    const policy: Policy = (await import(pathToFileURL(output).href)).default;
    let counts = policy.empty_counts();
    let commitsScanned = 0;
    let hasMoreCommits = false;
    for (const { commit, paths } of decodeLog(history)) {
      if (commitsScanned === maxCommits) {
        hasMoreCommits = true;
        break;
      }
      const input = paths.reduceRight<List<string>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
      counts = policy.count_commit(counts, input, boundaries.has(commit));
      commitsScanned++;
    }
    const files = [];
    for (let ranked = policy.top_paths(counts); ranked.$ === "Con"; ranked = ranked.tail) {
      files.push({ ...encodePath(ranked.head.path), commits: ranked.head.commits });
    }
    console.log(JSON.stringify({ revision: tip, commitsScanned, hasMoreCommits, shallow, files }, null, 2));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
