import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [commit, destination] = process.argv.slice(2);
if (!destination || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit ?? "")) {
  throw Error("Expected a Git commit ID and snapshot destination");
}
const git = (...args: string[]) => execFileSync("git", args, {
  maxBuffer: 64 * 1024 * 1024,
});
const tree = new TextDecoder("utf-8", { fatal: true }).decode(git("ls-tree", "-rz", "--full-tree", commit));
for (const entry of tree.split("\0").filter(Boolean)) {
  const separator = entry.indexOf("\t");
  const [mode, type, blob] = entry.slice(0, separator).split(" ");
  const path = entry.slice(separator + 1);
  if (type !== "blob" || !["100644", "100755"].includes(mode) ||
      path.split("/").some((component) => !component || component === "." || component === "..")) {
    throw Error(`Cannot build a verification snapshot for ${JSON.stringify(path)}`);
  }
  const file = resolve(destination, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, git("cat-file", "blob", blob), {
    flag: "wx", mode: mode === "100755" ? 0o755 : 0o644,
  });
}
