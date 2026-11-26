import { execFileSync } from "node:child_process";
import { withHookPolicy } from "./bend.ts";

type BendList<T> = { $: "Nil" } | { $: "Con"; head: T; tail: BendList<T> };
type TreeEntry = { $: "Entry"; mode: string; kind: string; path: string };
type Violation = { directory: string; files: number; directories: number; limit: number };
type WidthPolicy = {
  valid_tree_pair(from: string, to: string): boolean;
  has_first_party_changes(paths: BendList<string>): boolean;
  check_width(before: BendList<TreeEntry>, after: BendList<TreeEntry>, changed: BendList<string>): BendList<Violation>;
};

const git = (...args: string[]) => execFileSync("git", args, {
  maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
const decode = (value: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(value);
const toBend = <T>(items: T[]): BendList<T> =>
  items.reduceRight<BendList<T>>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });

function treeEntries(treeish: string): BendList<TreeEntry> {
  const entries = decode(git("ls-tree", "-rz", "--full-tree", treeish)).split("\0");
  entries.pop();
  return toBend(entries.map((entry) => {
    const split = entry.indexOf("\t");
    const [mode, kind] = entry.slice(0, split).split(" ");
    return { $: "Entry", mode, kind, path: entry.slice(split + 1) };
  }));
}

function check(policy: WidthPolicy) {
  const args = process.argv.slice(2);
  const [from, to] = args;
  if ((args.length !== 0 && args.length !== 2) || !policy.valid_tree_pair(from ?? "", to ?? "")) {
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
  const paths = decode(git("diff", "--name-only", "--no-renames", "-z", base, candidate, "--")).split("\0");
  paths.pop();
  if (!paths.length) return;
  const changed = toBend(paths);
  if (!policy.has_first_party_changes(changed)) return;
  const violations: Violation[] = [];
  const result = policy.check_width(treeEntries(base), treeEntries(candidate), changed);
  for (let node = result; node.$ === "Con"; node = node.tail) violations.push(node.head);
  violations.sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0);
  for (const { directory: path, files, directories, limit } of violations) {
    console.error(`directory-width check: ${JSON.stringify(path || ".")} has ${files} files and ${directories} ordinary subdirectories (limit ${limit} each). Split changes by responsibility.`);
    process.exitCode = 1;
  }
  if (!to && decode(git("write-tree")).trim() !== candidate) throw Error("Git index changed during the directory-width check");
}

try {
  await withHookPolicy<WidthPolicy>(new URL("../.githooks/policy/width.bend", import.meta.url), check);
} catch (error) {
  console.error(`directory-width check: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
