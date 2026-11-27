import { execFileSync } from "node:child_process";
import type { Tiktoken } from "js-tiktoken/lite";
import { withHookPolicy } from "../tooling/bend.ts";

type BendList = { $: "Nil" } | { $: "Con"; head: string; tail: BendList };
export type HookRules = {
  valid_object_id(value: string): boolean;
  valid_tree_pair(from: string, to: string): boolean;
  comment_action(oldMode: string, newMode: string, oldOid: string, newOid: string, oldPath: string,
    path: string, status: string): "skip" | "unsupported" | "compare" | "fresh";
  comments_allowed(before: BendList, after: BendList): boolean;
  push_base(localOid: string, remoteRef: string, remoteOid: string): "skip" | "missing" | "main" | "remote";
  push_scopes(paths: BendList): BendList;
  snapshot_mode(mode: string, kind: string, path: string): number;
};

type PathPolicy = Pick<HookRules, "valid_tree_pair"> & {
  check_paths(registry: string, added: BendList): { $: "InvalidRegistry" } | { $: "Checked"; rejected: BendList };
  source_budget_candidate(mode: string, path: string): boolean;
  source_budget_covered(path: string, prefix: string): boolean;
  source_budget_inherits(status: string, oldMode: string, mode: string, oldOid: string, oid: string): boolean;
  source_budget_violation(count: number, previous: number): number;
};

export const rulesFile = new URL("./policy/rules.bend", import.meta.url);
export const git = (...args: string[]) => execFileSync("git", args, {
  maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
export const gitText = (...args: string[]) => git(...args).toString("utf8").trim();
export const gitFields = (...args: string[]) =>
  new TextDecoder("utf-8", { fatal: true }).decode(git(...args)).split("\0").filter(Boolean);

export function list(values: readonly string[]): BendList {
  return values.reduceRight<BendList>((tail, head) => ({ $: "Con", head, tail }), { $: "Nil" });
}

export function values(list: BendList) {
  const result: string[] = [];
  for (let node = list; node.$ === "Con"; node = node.tail) result.push(node.head);
  return result;
}

export function candidateTrees(rules: Pick<HookRules, "valid_tree_pair">, args: string[]) {
  const [from, to] = args;
  if ((args.length !== 0 && args.length !== 2) || !rules.valid_tree_pair(from ?? "", to ?? "")) {
    throw Error("Expected two Git object IDs, or no arguments to check the index");
  }
  if (from && to) return { base: from, staged: to, fromIndex: false };
  const staged = gitText("write-tree");
  try {
    return { base: gitText("rev-parse", "--verify", "--quiet", "HEAD^{tree}"), staged, fromIndex: true };
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    return { base: gitText("hash-object", "-t", "tree", "-w", "--stdin"), staged, fromIndex: true };
  }
}

async function checkSourceBudgets(policy: PathPolicy, base: string, candidate: string) {
  const fields = gitFields("diff", "--raw", "--no-abbrev", "-z", "--find-renames=100%", base, candidate, "--");
  let encoding: Tiktoken | undefined;
  let passed = true;
  for (let i = 0; i < fields.length;) {
    const [oldMode, mode, oldOid, oid, status] = fields[i++].slice(1).split(" ");
    const oldPath = fields[i++];
    const path = status.startsWith("R") || status.startsWith("C") ? fields[i++] : oldPath;
    if (!policy.source_budget_candidate(mode, path)) continue;
    const text = git("cat-file", "blob", oid).toString("utf8");
    if (!policy.source_budget_covered(path, text.slice(0, 2))) continue;
    if (!encoding) {
      const [{ Tiktoken }, { default: ranks }] = await Promise.all([
        import("js-tiktoken/lite"), import("js-tiktoken/ranks/o200k_base"),
      ]);
      encoding = new Tiktoken(ranks);
    }
    const count = encoding.encode(text, [], []).length;
    let violation = policy.source_budget_violation(count, 0);
    if (!violation) continue;
    if (policy.source_budget_inherits(status, oldMode, mode, oldOid, oid)) {
      const previous = oldOid === oid ? count :
        encoding.encode(git("cat-file", "blob", oldOid).toString("utf8"), [], []).length;
      violation = policy.source_budget_violation(count, previous);
    }
    if (violation) {
      console.error(`source token check: ${JSON.stringify(path)} has ${count} source tokens (allowance ${violation}).`);
      passed = false;
    }
  }
  return passed;
}

async function check(policy: PathPolicy) {
  const { base, staged, fromIndex } = candidateTrees(policy, process.argv.slice(2));
  const registry = new TextDecoder("utf-8", { fatal: true }).decode(git("show", `${staged}:.githooks/bend-exceptions.json`));
  const added = gitFields("diff", "--name-only", "--no-renames", "--diff-filter=AT", "-z", base, staged, "--");
  const result = policy.check_paths(registry, list(added));
  if (result.$ === "InvalidRegistry") throw Error("Expected an exception registry with unique groups of path strings");
  const rejected = values(result.rejected);
  for (const path of rejected) {
    console.error(`Bend2 path check: ${JSON.stringify(path)} needs a .bend implementation or an explicitly approved host exception.`);
  }
  const budgetsPassed = await checkSourceBudgets(policy, base, staged);
  if (fromIndex && gitText("write-tree") !== staged) throw Error("Git index changed during the Bend2 path and token checks");
  if (rejected.length || !budgetsPassed) process.exitCode = 1;
}

if (import.meta.main) {
  await withHookPolicy<PathPolicy>(new URL("./policy/paths.bend", import.meta.url), check).catch((error: unknown) => {
    console.error(`Bend2 path check: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
