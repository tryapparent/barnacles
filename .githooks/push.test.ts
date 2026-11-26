import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("pre-push routes the outgoing commit and blocks failed verification", () => {
  const job = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(job, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const root = mkdtempSync(join(job, "push-test-"));
  const cwd = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(cwd);
  const git = (...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const pass = (...args: string[]) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const write = (path: string, text: string) => writeFileSync(join(cwd, path), text);
  const commit = (path: string) => {
    pass("add", path);
    pass("commit", "--quiet", "-m", "synthetic change");
  };

  try {
    pass("init", "--quiet", "--initial-branch=main");
    pass("init", "--quiet", "--bare", remote);
    pass("config", "user.name", "Synthetic Test");
    pass("config", "user.email", "synthetic@example.invalid");
    pass("config", "commit.gpgsign", "false");
    pass("remote", "add", "origin", remote);
    mkdirSync(join(cwd, ".githooks"));
    mkdirSync(join(cwd, "node_modules/web-tree-sitter"), { recursive: true });
    mkdirSync(join(cwd, "collector/github"), { recursive: true });
    mkdirSync(join(cwd, "dashboard"));
    mkdirSync(join(cwd, "tooling"));
    copyFileSync(new URL("../tooling/verify.ts", import.meta.url), join(cwd, "tooling", "verify.ts"));
    copyFileSync(new URL("../tooling/check-directory-width.ts", import.meta.url), join(cwd, "tooling", "check-directory-width.ts"));
    write("tooling/check-boundaries.ts", "process.exit(0)\n");
    write("dashboard/prepare.test.ts", "process.exit(process.env.BARNACLES_WEB_BUILD ? 0 : 1)\n");
    for (const file of ["pre-push", "snapshot.ts"]) {
      copyFileSync(new URL("./" + file, import.meta.url), join(cwd, ".githooks", file));
    }
    write(".gitattributes", "collector/github/attempt.test.ts export-ignore\n");
    write(".githooks/check-comments.ts", "process.exit(0)\n");
    write(".githooks/check-bend-paths.ts", "process.exit(0)\n");
    write("README.md", "Baseline\n");
    write("package.json", '{"name":"push-fixture","version":"1.0.0","type":"module","scripts":{"verify":"node tooling/verify.ts","build:harbor":"node tooling/build-harbor.ts"}}\n');
    write("tooling/build-harbor.ts", "process.exit(process.argv[2] === '--outDir' && process.argv[3] ? 0 : 1)\n");
    write("package-lock.json", '{"name":"push-fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}\n');
    write("collector/github/attempt.test.ts", 'console.log("committed collector test")\n');
    write("collector/sources.test.ts", "process.exit(0)\n");
    pass("add", "README.md", "package.json", "package-lock.json", "collector", "dashboard", "tooling", ".githooks", ".gitattributes");
    pass("commit", "--quiet", "-m", "baseline");
    pass("push", "--quiet", "origin", "main");
    pass("config", "core.hooksPath", ".githooks");
    pass("switch", "--quiet", "-c", "feature");

    write("README.md", "Documentation change\n");
    commit("README.md");
    assert.doesNotMatch(pass("push", "origin", "feature").stderr, /checking .* tests/);

    write("collector/github/attempt.test.ts", 'console.log("pushed snapshot test")\n');
    commit("collector/github/attempt.test.ts");
    write("collector/github/attempt.test.ts", "process.exit(1)\n");
    const success = pass("push", "origin", "feature");
    assert.match(success.stderr, /checking collector dashboard tests/);
    assert.match(success.stdout, /pushed snapshot test/);
    assert.doesNotMatch(success.stderr, /checking hook tests/);

    commit("collector/github/attempt.test.ts");
    const failure = git("push", "origin", "feature");
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /checking collector dashboard tests/);
    assert.match(failure.stdout, /not ok/);
    mkdirSync(join(cwd, "overwide"));
    for (let index = 0; index < 11; index++) write(`overwide/file-${index}.md`, "Synthetic\n");
    commit("overwide");
    const width = git("push", "origin", "feature");
    assert.equal(width.status, 1);
    assert.match(width.stderr, /directory-width check: "overwide" has 11 files/);
    assert.doesNotMatch(width.stderr, /checking .* tests/);
    pass("push", "origin", "--delete", "feature");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
