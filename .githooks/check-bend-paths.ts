import { execFileSync } from "node:child_process";

const git = (...args: string[]) => execFileSync("git", args, {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
const [from, to, ...extra] = process.argv.slice(2);
if (extra.length || Boolean(from) !== Boolean(to) ||
    (from && ![from, to].every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))) {
  throw Error("Expected two Git object IDs, or no arguments to check the index");
}
const staged = to ?? git("write-tree").trim();
let base = from;
if (!base) {
  try {
    base = git("rev-parse", "--verify", "HEAD^{tree}").trim();
  } catch {
    base = git("hash-object", "-t", "tree", "-w", "--stdin").trim();
  }
}

const registry = JSON.parse(git("show", `${staged}:.githooks/bend-exceptions.json`)) as Record<string, string[]>;
const approved = new Set(Object.values(registry).flat());
const added = git("diff", "--name-only", "--no-renames", "--diff-filter=AT", "-z", base, staged, "--").split("\0");
const rejected = added.filter((path) => path && !approved.has(path) &&
  !/\.(?:bend|md)$/.test(path) && !/(?:^|\/)LICENSE$/.test(path));
for (const path of rejected) {
  console.error(`Bend2 path check: ${JSON.stringify(path)} needs a .bend implementation or an explicitly approved host exception.`);
}
if (!to && git("write-tree").trim() !== staged) throw Error("Git index changed during the Bend2 path check");
if (rejected.length) process.exitCode = 1;
