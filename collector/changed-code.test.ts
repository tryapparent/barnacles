import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("changed-code CLI ranks Git paths and reports bounded and shallow coverage", () => {
  const directory = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(directory, "Set PLOW_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(directory, "changed-code-test-"));
  const repository = join(job, "repo");
  const shallow = join(job, "shallow-é");
  const cli = fileURLToPath(new URL("./changed-code.ts", import.meta.url));
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgsign=false", "-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid",
    ...args], { cwd: repository, encoding: "utf8" }).trim();
  const write = (path: string | Buffer, contents: string) => writeFileSync(
    typeof path === "string" ? join(repository, path) : Buffer.concat([Buffer.from(repository + "/"), path]), contents);
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "Synthetic change");
  };
  const analyze = (repo: string, ...args: string[]) =>
    JSON.parse(execFileSync(process.execPath, [cli, job, repo, ...args], { encoding: "utf8" }));

  try {
    git("init", "--quiet", "--initial-branch=main");
    mkdirSync(join(repository, "nested"));
    const invalidUtf8 = Buffer.from([0xff]);
    write(invalidUtf8, "invalid UTF-8 path");
    write("\nstrange\tname.ts", "unusual filename");
    write("nested/hot.ts", "root");
    write("cold.ts", "root");
    const padding = Array.from({ length: 30 }, (_, n) => `padding-${String(n).padStart(2, "0")}.ts`);
    for (const path of padding) write(path, "padding");
    commit();

    git("switch", "--quiet", "-c", "side");
    write("nested/hot.ts", "side");
    commit();
    git("commit", "--quiet", "--allow-empty", "-m", "Empty commit");
    const side = git("rev-parse", "HEAD");

    git("switch", "--quiet", "main");
    git("mv", "cold.ts", "renamed.ts");
    write(invalidUtf8, "edit invalid UTF-8 path");
    commit();
    const rename = git("rev-parse", "HEAD");
    git("merge", "--quiet", "--no-commit", "--no-ff", "side");
    write("merge-only.ts", "excluded merge");
    commit();

    const report = analyze(join(repository, "nested"));
    assert.deepEqual(report, {
      revision: git("rev-parse", "HEAD"),
      commitsScanned: 4,
      hasMoreCommits: false,
      shallow: false,
      files: [
        { path: "cold.ts", commits: 2 },
        { path: "nested/hot.ts", commits: 2 },
        { pathBytesBase64: "/w==", commits: 2 },
        { path: "\nstrange\tname.ts", commits: 1 },
        ...padding.slice(0, 21).map((path) => ({ path, commits: 1 })),
      ],
    });
    assert.deepEqual(analyze(repository, "--save-as", "Synthetic/Example"), report);
    const full = new DatabaseSync(join(job, "evidence.sqlite"), { readOnly: true });
    try {
      const stored = full.prepare("SELECT paths FROM git_change_inventory WHERE repository = ?").get("synthetic/example");
      const inventory = JSON.parse(String(stored?.paths));
      assert.ok(inventory.length > report.files.length);
      assert.ok(inventory.some((file: { path?: string }) => file.path === "padding-29.ts"));
    } finally { full.close(); }
    assert.deepEqual(analyze(repository, side, "2"), {
      revision: side, commitsScanned: 2, hasMoreCommits: true, shallow: false,
      files: [{ path: "nested/hot.ts", commits: 1 }],
    });
    assert.deepEqual(analyze(repository, rename, "1", "--save-as", "synthetic/example").files, [
      { path: "cold.ts", commits: 1 },
      { path: "renamed.ts", commits: 1 },
      { pathBytesBase64: "/w==", commits: 1 },
    ]);
    const db = new DatabaseSync(join(job, "evidence.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT * FROM git_change_scans").all().map(Object.values),
        [["synthetic/example", rename, 1, 1, 0]]);
      assert.deepEqual(db.prepare("SELECT path, path_base64, commits FROM git_changed_files ORDER BY rank").all().map(Object.values),
        [["cold.ts", null, 1], ["renamed.ts", null, 1], [null, "/w==", 1]]);
      const inventory = JSON.parse(String(db.prepare("SELECT paths FROM git_change_inventory").get()?.paths));
      assert.equal(inventory.length, 3);
    } finally { db.close(); }

    git("clone", "--quiet", "--no-local", "--depth=2", "--branch=side", repository, shallow);
    assert.deepEqual(analyze(shallow), {
      revision: side, commitsScanned: 2, hasMoreCommits: false, shallow: true, files: [],
    });
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
