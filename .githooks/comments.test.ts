import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { comments } from "./comment-syntax.ts";

test("lexical comment parsers distinguish comments from literals", async () => {
  const fixtures = [
    ["example.ts", 'const url = "https://example.com";\n// line\n/** docs */', 2],
    ["example.ts", 'const pattern = /https?:\\/\\//; const tpl = `/* text */`;', 0],
    ["example.ts", '`template ${1 /* expression */}`', 1],
    ["example.bend", 'def text() -> String:\n  "# literal"\n# line', 1],
    ["example.sql", "SELECT '-- literal';\n-- line\n/* block */", 2],
    ["example.sh", "#!/bin/sh\nprintf '%s' '# literal'\n# line", 1],
    ["example.yaml", 'key: "# value" # line', 1],
    ["example.html", '<!-- markup --><script>const s = "// literal"; /* block */</script>', 2],
    ["example.html", '<div style="color:red;/*inline*/" onclick="return true; // line"></div>', 2],
    ["README.md", 'Text `<!-- literal -->` <!-- inline -->\n\n<!-- block -->', 2],
    ["README.md", '```html\n<!-- example -->\n```', 0],
    [".gitignore", "# comment\n\\#pattern\npath#literal", 1],
  ] as const;
  for (const [name, text, count] of fixtures) {
    assert.equal((await comments(name, Buffer.from(text))).length, count, name);
  }
  await assert.rejects(comments("example.unknown", Buffer.from("x")), /Unsupported comment syntax/);
  await assert.rejects(comments("example.json", Buffer.from('{"x":1 /* marked */}')));
  for (const path of ["evidence/actions.sql", "evidence/sources.sql", ".githooks/pre-commit"]) {
    assert.deepEqual(await comments(path, readFileSync(path)), []);
  }
});

test("real Git commits check the staged tree and enforce comment multiplicity", () => {
  const job = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(job, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const cwd = mkdtempSync(join(job, "hook-test-"));
  const git = (...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const pass = (...args: string[]) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr);
  };
  const reject = (message: RegExp) => {
    const result = git("commit", "-qm", "should reject");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  };
  const write = (name: string, content: string) => writeFileSync(join(cwd, name), content);
  try {
    pass("init", "-q");
    pass("config", "user.name", "Synthetic Test");
    pass("config", "user.email", "synthetic@example.invalid");
    pass("config", "commit.gpgsign", "false");
    for (const entry of ["node_modules"]) {
      symlinkSync(fileURLToPath(new URL("../" + entry, import.meta.url)), join(cwd, entry));
    }
    mkdirSync(join(cwd, ".githooks"));
    for (const file of ["pre-commit", "check-comments.ts", "check-bend-paths.ts"]) {
      symlinkSync(fileURLToPath(new URL(file, import.meta.url)), join(cwd, ".githooks", file));
    }
    write(".githooks/bend-exceptions.json", '{"Host fixture":[".githooks/bend-exceptions.json","renamed.ts"]}\n');
    pass("add", ".githooks/bend-exceptions.json");
    pass("config", "core.hooksPath", ".githooks");
    write("a.ts", "// rejected on an unborn branch\nconst value = 1;\n");
    pass("add", "a.ts");
    reject(/Added or modified comment/);
    write("a.ts", "// legacy\nconst value = 1;\n");
    pass("add", "a.ts");
    pass("-c", "core.hooksPath=/dev/null", "commit", "-qm", "synthetic legacy baseline");
    write("a.ts", "// legacy\nconst value = 2;\n");
    pass("add", "a.ts");
    write("a.ts", "// legacy\nconst value = 2;\n// unstaged only\n");
    pass("commit", "-qm", "unchanged staged comment");
    pass("add", "a.ts");
    write("a.ts", "// legacy\nconst value = 2;\n");
    reject(/Added or modified comment/);
    write("a.ts", "// legacy\n// legacy\nconst value = 2;\n");
    pass("add", "a.ts");
    reject(/Added or modified comment/);
    write("a.ts", "// legacy\nconst value = 2;\n");
    pass("add", "a.ts");
    pass("mv", "a.ts", "renamed.ts");
    pass("commit", "-qm", "rename preserves existing comment");
    write("copy.ts", "// legacy\nconst value = 2;\n");
    pass("add", "copy.ts");
    reject(/Added or modified comment/);
    pass("rm", "--cached", "copy.ts");
    symlinkSync("renamed.ts", join(cwd, "link.ts"));
    pass("add", "link.ts");
    reject(/Only regular staged files/);
    pass("rm", "--cached", "link.ts");
    write("renamed.ts", "const value = 3;\n");
    pass("add", "renamed.ts");
    pass("commit", "-qm", "remove existing comment");
    write("policy.ts", "const value = 1;\n");
    pass("add", "policy.ts");
    write(".githooks/bend-exceptions.json", '{"Unstaged exception":["policy.ts"]}\n');
    reject(/Bend2 path check: "policy.ts"/);
    pass("restore", "--", ".githooks/bend-exceptions.json");
    pass("rm", "-f", "policy.ts");
    write("policy.bend", "def value() -> U32: 1\n");
    pass("add", "policy.bend");
    pass("commit", "-qm", "Bend2 feature");

  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
