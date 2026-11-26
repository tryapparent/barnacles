import { withHookPolicy } from "../tooling/bend.ts";
import { candidateTrees, git, gitFields, gitText, list, rulesFile, type HookRules } from "./check-bend-paths.ts";
import { comments } from "./comment-syntax.ts";

async function check(rules: HookRules) {
  const { base, staged, fromIndex } = candidateTrees(rules, process.argv.slice(2));
  const fields = gitFields("diff", "--raw", "--no-abbrev", "-z", "-M50%", base, staged, "--");
  let failed = false;
  for (let i = 0; i < fields.length;) {
    const [oldMode, newMode, oldOid, newOid, status] = fields[i++].slice(1).split(" ");
    const oldPath = fields[i++];
    const path = status.startsWith("R") || status.startsWith("C") ? fields[i++] : oldPath;
    const action = rules.comment_action(oldMode, newMode, oldOid, newOid, oldPath, path, status);
    if (action === "skip") continue;
    try {
      if (action === "unsupported") throw Error("Only regular staged files have a supported comment syntax");
      const added = await comments(path, git("cat-file", "blob", newOid));
      if (!added.length) continue;
      const oldComments = action === "compare" ? await comments(oldPath, git("cat-file", "blob", oldOid)) : [];
      if (!rules.comments_allowed(list(oldComments), list(added))) {
        throw Error("Added or modified comment. Remove it from the staged version.");
      }
    } catch (error) {
      console.error(`comment check: ${JSON.stringify(path)} — ${error instanceof Error ? error.message : error}`);
      failed = true;
    }
  }
  if (fromIndex && gitText("write-tree") !== staged) throw Error("Git index changed during the comment check");
  if (failed) process.exitCode = 1;
}

await withHookPolicy<HookRules>(rulesFile, check).catch((error: Error) => {
  console.error(`comment check: ${error.message}`);
  process.exitCode = 1;
});
