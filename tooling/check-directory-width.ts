import { execFileSync } from "node:child_process";
import { posix } from "node:path";

const limit = 10;
const excluded = new Set([".git", "target", "node_modules", "vendor", "third_party", "third-party", "__pycache__"]);
const toolRoots = [".github", ".githooks"];

type Tree = {
  children: Map<string, Map<string, "file" | "directory">>;
  eligible: Set<string>;
  directories: Set<string>;
};

const git = (...args: string[]) => execFileSync("git", args, {
  maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
const decode = (value: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const firstParty = (path: string) => !path.split("/").some((part) => excluded.has(part));

function inspect(treeish: string): Tree {
  const children: Tree["children"] = new Map();
  const eligible = new Set<string>();
  const directories = new Set<string>();
  for (const entry of decode(git("ls-tree", "-rz", "--full-tree", treeish)).split("\0")) {
    if (!entry) continue;
    const split = entry.indexOf("\t");
    const [mode, kind] = entry.slice(0, split).split(" ");
    const path = entry.slice(split + 1);
    if (!firstParty(path)) continue;
    const parts = path.split("/");
    let parent = "";
    for (const [index, part] of parts.entries()) {
      const nested = index < parts.length - 1;
      const direct = children.get(parent) ?? new Map();
      direct.set(part, nested || mode === "160000" ? "directory" : "file");
      children.set(parent, direct);
      if (kind === "blob") eligible.add(parent);
      if (nested) {
        parent = parent ? parent + "/" + part : part;
        directories.add(parent);
      }
    }
  }
  return { children, eligible, directories };
}

function check() {
  const [from, to, ...extra] = process.argv.slice(2);
  if (extra.length || Boolean(from) !== Boolean(to) ||
      (from && ![from, to].every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))) {
    throw Error("Expected two Git object IDs, or no arguments to check the index");
  }
  const candidate = to ?? decode(git("write-tree")).trim();
  let base = from;
  if (!base) {
    try {
      base = decode(git("rev-parse", "--verify", "--quiet", "HEAD^{tree}")).trim();
    } catch (error) {
      if (!(error instanceof Error) || (error as Error & { status?: number }).status !== 1) throw error;
      base = decode(git("hash-object", "-t", "tree", "-w", "--stdin")).trim();
    }
  }
  const changed = decode(git("diff", "--name-only", "--no-renames", "-z", base, candidate, "--"))
    .split("\0").filter((path) => path && firstParty(path));
  if (!changed.length) return;
  const after = inspect(candidate);
  const before = inspect(base);
  const affected = new Set(changed.map((path) => posix.dirname(path) === "." ? "" : posix.dirname(path)));
  for (const directory of new Set([...after.children.keys(), ...before.children.keys()])) {
    const oldEntries = before.children.get(directory) ?? new Map();
    const entries = after.children.get(directory) ?? new Map();
    if (oldEntries.size !== entries.size || [...oldEntries].some(([name, kind]) => entries.get(name) !== kind)) {
      affected.add(directory);
    }
  }
  for (const directory of [...affected].sort()) {
    if (directory === ".github/workflows" || !(after.eligible.has(directory) || before.eligible.has(directory))) continue;
    const entries = [...(after.children.get(directory)?.values() ?? [])];
    const files = entries.filter((kind) => kind === "file").length;
    const directories = entries.length - files;
    const tools = directory ? 0 : toolRoots.filter((root) => after.directories.has(root)).length;
    if (files > limit || directories - tools > limit) {
      console.error(`directory-width check: ${JSON.stringify(directory || ".")} has ${files} files and ${directories - tools} ordinary subdirectories (limit ${limit} each). Split changes by responsibility.`);
      process.exitCode = 1;
    }
  }
  if (!to && decode(git("write-tree")).trim() !== candidate) throw Error("Git index changed during the directory-width check");
}

try {
  check();
} catch (error) {
  console.error(`directory-width check: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
