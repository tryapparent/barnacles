import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("pre-push routes the outgoing commit and blocks failed verification", () => {
  const job = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(job, "Set PLOW_TEST_DIRECTORY to a private job directory");
  const root = mkdtempSync(join(job, "push-test-"));
  const cwd = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(cwd);
  const env = { ...process.env };
  delete env.PLOW_BEND_BUNDLE;
  const git = (...args: string[]) => spawnSync("git", args, { cwd, env, encoding: "utf8" });
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
    symlinkSync(fileURLToPath(new URL("../node_modules/js-tiktoken", import.meta.url)), join(cwd, "node_modules/js-tiktoken"));
    mkdirSync(join(cwd, "collect/source"), { recursive: true });
    mkdirSync(join(cwd, "analyze"));
    mkdirSync(join(cwd, "verify"));
    write("verify/README.md", "Synthetic verification owner\n");
    mkdirSync(join(cwd, "tooling"));
    for (const file of ["verify.ts", "check-directory-width.ts", "check-boundaries.ts", "bend.ts", "verification.bend"]) {
      copyFileSync(new URL("../tooling/" + file, import.meta.url), join(cwd, "tooling", file));
    }
    write("analyze/run.test.ts", "process.exit(0)\n");
    for (const file of ["pre-push", "snapshot.ts", "check-bend-paths.ts"]) {
      copyFileSync(new URL("./" + file, import.meta.url), join(cwd, ".githooks", file));
    }
    write(".gitattributes", "collect/source/attempt.test.ts export-ignore\n");
    write(".githooks/check-comments.ts", "process.exit(0)\n");
    write(".githooks/bend-exceptions.json", "{}\n");
    mkdirSync(join(cwd, ".githooks/policy"));
    for (const file of ["paths.bend", "rules.bend", "width.bend"]) {
      copyFileSync(new URL("./policy/" + file, import.meta.url), join(cwd, ".githooks/policy", file));
    }
    write("README.md", "Baseline\n");
    for (const file of ["package-lock.json"]) {
      copyFileSync(new URL("../" + file, import.meta.url), join(cwd, file));
    }
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    write("package.json", JSON.stringify(packageJson));
    write("collect/source/attempt.test.ts", 'console.log("committed collector test")\n');
    write("collect/fixture.test.ts", "process.exit(0)\n");
    pass("add", "README.md", "package.json", "package-lock.json", "collect", "analyze", "verify", "tooling", ".githooks", ".gitattributes");
    pass("commit", "--quiet", "-m", "baseline");
    pass("push", "--quiet", "origin", "main");
    const install = spawnSync(process.execPath, ["tooling/bend.ts", "--install-hooks"], { cwd, encoding: "utf8" });
    assert.equal(install.status, 0, install.stderr);
    pass("switch", "--quiet", "-c", "feature");

    write("README.md", "Documentation change\n");
    commit("README.md");
    assert.doesNotMatch(pass("push", "origin", "feature").stderr, /checking .* tests/);

    write("collect/source/attempt.test.ts", 'console.log("pushed snapshot test")\n');
    commit("collect/source/attempt.test.ts");
    write("collect/source/attempt.test.ts", 'import "../../analyze/run.test.ts";\nprocess.exit(1)\n');
    const success = pass("push", "origin", "feature");
    assert.match(success.stderr, /checking collect analyze tests/);
    assert.match(success.stdout, /pushed snapshot test/);
    assert.doesNotMatch(success.stderr, /checking hook tests/);

    commit("collect/source/attempt.test.ts");
    const boundary = git("push", "origin", "feature");
    assert.equal(boundary.status, 1);
    assert.match(boundary.stderr, /collect\/source\/attempt\.test\.ts:1 cannot import/);

    write("collect/source/attempt.test.ts", "process.exit(1)\n");
    commit("collect/source/attempt.test.ts");
    const failure = git("push", "origin", "feature");
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /checking collect analyze tests/);
    assert.match(failure.stdout, /not ok/);
    write("oversized.bend", `def example() -> String:\n  "${" a".repeat(4100)}"\n`);
    commit("oversized.bend");
    write("oversized.bend", "def example() -> String: \"small\"\n");
    const budget = git("push", "origin", "feature");
    assert.equal(budget.status, 1);
    assert.match(budget.stderr, /source token check: "oversized\.bend" has 4109 source tokens \(allowance 4000\)/);
    assert.doesNotMatch(budget.stderr, /checking .* tests/);
    pass("rm", "-f", "oversized.bend");
    pass("commit", "-qm", "remove oversized source");
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
