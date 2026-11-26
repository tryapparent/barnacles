import { execFileSync } from "node:child_process";
import { comments } from "./comment-syntax.ts";

const git = (args: string[], input?: string) => execFileSync("git", args, {
  input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});

async function check() {
  const [from, to, ...extra] = process.argv.slice(2);
  if (extra.length || Boolean(from) !== Boolean(to) ||
      (from && ![from, to].every((value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)))) {
    throw Error("Expected two Git object IDs, or no arguments to check the index");
  }
  const staged = to ?? git(["write-tree"]).toString().trim();
  let base = from;
  if (!base) {
    try {
      base = git(["rev-parse", "--verify", "HEAD^{tree}"]).toString().trim();
    } catch {
      base = git(["hash-object", "-t", "tree", "-w", "--stdin"], "").toString().trim();
    }
  }
  const fields = new TextDecoder("utf-8", { fatal: true }).decode(
    git(["diff", "--raw", "--no-abbrev", "-z", "-M50%", base, staged, "--"]),
  ).split("\0");
  let failed = false;
  for (let i = 0; fields[i];) {
    const [oldMode, newMode, oldOid, newOid, status] = fields[i++].slice(1).split(" ");
    const oldPath = fields[i++];
    const path = status.startsWith("R") || status.startsWith("C") ? fields[i++] : oldPath;
    if (newMode === "000000") continue;
    try {
      if (!newMode.startsWith("100")) throw Error("Only regular staged files have a supported comment syntax");
      if (path === oldPath && oldOid === newOid && oldMode.startsWith("100")) continue;
      const added = await comments(path, git(["cat-file", "blob", newOid]));
      if (!added.length) continue;
      const allowance = new Map<string, number>();
      if (oldMode.startsWith("100") && !status.startsWith("C")) {
        for (const comment of await comments(oldPath, git(["cat-file", "blob", oldOid]))) {
          allowance.set(comment, (allowance.get(comment) ?? 0) + 1);
        }
      }
      for (const comment of added) {
        const count = allowance.get(comment) ?? 0;
        if (!count) throw Error("Added or modified comment. Remove it from the staged version.");
        allowance.set(comment, count - 1);
      }
    } catch (error) {
      console.error(`comment check: ${JSON.stringify(path)} — ${error instanceof Error ? error.message : error}`);
      failed = true;
    }
  }
  if (!to && git(["write-tree"]).toString().trim() !== staged) throw Error("Git index changed during the comment check");
  if (failed) process.exitCode = 1;
}

check().catch((error: Error) => {
  console.error(`comment check: ${error.message}`);
  process.exitCode = 1;
});
