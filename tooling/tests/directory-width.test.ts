import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../check-directory-width.ts", import.meta.url));

type Fixture = {
  git: (...args: string[]) => string;
  check: (...args: string[]) => SpawnSyncReturns<string>;
  write: (path: string) => void;
};

function withRepository(run: (fixture: Fixture) => void) {
  const parent = process.env.PLOW_TEST_DIRECTORY;
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
    run({ git, check, write });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("directory width checks immutable candidates at the file and subdirectory limits", () => {
  withRepository(({ git, check, write }) => {
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
  });
});

test("directory width preserves exclusions, root tool slots and blob eligibility", () => {
  withRepository(({ git, check, write }) => {
    for (let index = 0; index < 10; index++) write(`part-${index}/file`);
    for (let index = 0; index < 11; index++) {
      write(`.github/workflows/workflow-${index}.yml`);
      write(`part-0/vendor/ignored-${index}`);
      write(`target/ignored-${index}`);
    }
    write(".githooks/policy.bend");
    git("add", ".");
    const initial = check();
    assert.equal(initial.status, 0, initial.stderr);
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "synthetic tool slots");
    const base = git("rev-parse", "HEAD");

    git("rm", "-q", "-r", ".githooks");
    git("update-index", "--add", "--cacheinfo", `160000,${base},.githooks`);
    const gitlink = check();
    assert.equal(gitlink.status, 1);
    assert.match(gitlink.stderr, /"\." has 0 files and 11 ordinary subdirectories/);
    git("reset", "-q", "--hard", base);

    for (let index = 0; index < 11; index++) {
      git("update-index", "--add", "--cacheinfo", `160000,${base},part-0/modules/module-${index}`);
    }
    const linksOnly = check();
    assert.equal(linksOnly.status, 0, linksOnly.stderr);
    write("part-0/modules/file");
    git("add", "part-0/modules/file");
    const withBlob = check();
    assert.equal(withBlob.status, 1);
    assert.match(withBlob.stderr, /"part-0\/modules" has 1 files and 11/);
  });
});

test("directory width checks ancestors when their immediate entries change", () => {
  withRepository(({ git, check, write }) => {
    for (let index = 0; index < 11; index++) write(`ancestor/part-${index}/file`);
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "synthetic legacy width");

    write("ancestor/part-0/another");
    git("add", "ancestor/part-0/another");
    const existingChild = check();
    assert.equal(existingChild.status, 0, existingChild.stderr);

    write("ancestor/new-part/file");
    git("add", "ancestor/new-part/file");
    const newChild = check();
    assert.equal(newChild.status, 1);
    assert.match(newChild.stderr, /"ancestor" has 0 files and 12/);
  });
});
