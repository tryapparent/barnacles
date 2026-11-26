import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../check-directory-width.ts", import.meta.url));

test("directory width checks immutable candidates at the file and subdirectory limits", () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent);
  const cwd = mkdtempSync(join(parent, "directory-width-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const check = (...args: string[]) => spawnSync(process.execPath, [checker, ...args], { cwd, encoding: "utf8" });
  const write = (path: string) => {
    const file = join(cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "synthetic\n");
  };

  try {
    git("init", "-q");
    git("config", "user.name", "Synthetic Test");
    git("config", "user.email", "synthetic@example.invalid");
    git("config", "commit.gpgsign", "false");
    for (let index = 0; index < 10; index++) {
      write(`feature/file-${index}`);
      write(`feature/part-${index}/README.md`);
    }
    for (let index = 0; index < 11; index++) write(`.github/workflows/workflow-${index}.yml`);
    git("add", ".");
    const initial = check();
    assert.equal(initial.status, 0, initial.stderr);
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "limit");
    const base = git("rev-parse", "HEAD");

    write("feature/extra");
    write("feature/another/README.md");
    assert.equal(check().status, 0);
    git("add", "feature/extra");
    const file = check();
    assert.equal(file.status, 1);
    assert.match(file.stderr, /"feature" has 11 files and 10/);
    git("reset", "-q", "--", "feature/extra");
    git("add", "feature/another");
    const directory = check();
    assert.equal(directory.status, 1);
    assert.match(directory.stderr, /"feature" has 10 files and 11/);
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "overwide fixture");
    const tip = git("rev-parse", "HEAD");
    assert.equal(check().status, 0);
    assert.equal(check(base, tip).status, 1);

    write("feature/another/extra");
    git("add", "feature/another/extra");
    assert.equal(check().status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
