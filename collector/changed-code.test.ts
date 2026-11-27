import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildPolicy, loadPolicy } from "../tooling/bend.ts";
import { openT3History } from "../evidence/index.ts";
import { bendList, bendValues } from "./wire.ts";
import type { HistoryPolicy } from "./codex/otel.ts";

test("T3 backfill resumes older pages, ranks days newest first and slows under load", async () => {
  const job = mkdtempSync(join(process.env.PLOW_TEST_DIRECTORY!, "t3-history-"));
  const path = join(job, "state.sqlite");
  const day = 86400000;
  const yesterday = 1700006400000;
  const target = (id: string, updated: number) => ({ $: "Target" as const, id, updated });
  try {
    const policy = await loadPolicy<HistoryPolicy>(await buildPolicy(job, new URL("./t3-otel/history.bend", import.meta.url), "history.mjs"));
    const older = target("first-lexically", yesterday - 7 * day);
    const newer = target("yesterday", yesterday);
    const head = target("latest", yesterday + day);
    const entries = Array.from({ length: 12_000 }, (_, i) => target("id-" + i, older.updated - i));
    const catalog = [...bendValues(policy.inventory(bendList([...entries, older, head, newer, target(head.id, older.updated)])))];
    assert.equal(catalog.length, 12_003);
    assert.deepEqual(catalog.slice(0, 2), [head, newer]);

    const writer = openT3History(path, "test", policy.replay);
    try {
      writer.commit(head.id, "", "saved-cursor", 1, [], { revision: head.updated, frontier: older.updated });
    } finally { writer.close(); }
    const restarted = openT3History(path, "test", policy.replay);
    try {
      const state = restarted.checkpoints().get(head.id)!;
      const resumed = policy.plan(head, state.cursor, true, state.mark!.revision, state.mark!.frontier, false);
      const staleTask = policy.plan(older, "", false, 0, 0, false);
      const recentTask = policy.plan(newer, "", false, 0, 0, false);
      assert.ok(resumed.$ === "Some" && staleTask.$ === "Some" && recentTask.$ === "Some");
      assert.equal(resumed.value.cursor, "saved-cursor");
      assert.deepEqual([...bendValues(policy.batch(bendList([
        resumed.value, staleTask.value, recentTask.value,
      ])))].map(item => item.id), [newer.id]);
      assert.deepEqual(policy.pacing(50, 2, false), { $: "Pace", workers: 2, pause: 50 });
      assert.deepEqual(policy.pacing(50, 1001, false), { $: "Pace", workers: 1, pause: 1000 });
      assert.deepEqual(policy.pacing(1000, 2, true), { $: "Pace", workers: 1, pause: 2000 });
      assert.equal(policy.older_frontier(yesterday, older.updated), older.updated);
    } finally { restarted.close(); }
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("T3 ingress adopts its existing path, rolls back partial apply, and refuses foreign routes", () => {
  const job = mkdtempSync(join(process.env.PLOW_TEST_DIRECTORY!, "t3-ingress-"));
  const state = join(job, "serve.json");
  const serve = join(job, "tailscale");
  const host = "test.tailnet.ts.net:8444";
  const paths = ["/api/orchestration", "/api/auth/websocket-ticket", "/ws"];
  const config = {
    TCP: { 8444: { HTTPS: true } },
    Web: { [host]: { Handlers: { [paths[0]]: { Proxy: "http://127.0.0.1:3784/api/orchestration" } } } },
  };
  const snapshot = () => JSON.parse(readFileSync(state, "utf8"));
  writeFileSync(state, JSON.stringify(config));
  writeFileSync(serve, `#!${process.execPath}
const {readFileSync,writeFileSync}=require("node:fs");
const file=process.env.FIXTURE_SERVE, args=process.argv.slice(2), host=process.env.PLOW_T3_HISTORY_SERVE_HOST;
const conf=JSON.parse(readFileSync(file,"utf8"));
if(args[0]==="status") console.log(JSON.stringify({Self:{DNSName:"test.tailnet.ts.net."}}));
else if(args[1]==="status") console.log(JSON.stringify(conf));
else {
  const path=args.find(arg=>arg.startsWith("--set-path=")).split("=")[1], target=args.at(-1), handlers=conf.Web[host].Handlers;
  if(path===process.env.FIXTURE_FAILURE) process.exit(1);
  if(target==="off") delete handlers[path];
  else handlers[path]={Proxy:target};
  writeFileSync(file,JSON.stringify(conf));
}
`, { mode: 0o700 });
  const run = (failure = "") => execFileSync("sh", [fileURLToPath(new URL("../dashboard/run.sh", import.meta.url)), "t3-history-ingress"], {
    env: { ...process.env, PATH: `${job}:${process.env.PATH}`, FIXTURE_SERVE: state, FIXTURE_FAILURE: failure,
      PLOW_COLLECTOR_SERVE_SUDO: "0", PLOW_T3_HISTORY_SERVE_HOST: host, PLOW_T3_HISTORY_LOOPBACK_PORT: "3784" },
    stdio: "pipe",
  });
  try {
    assert.throws(() => run("/ws"));
    assert.deepEqual(snapshot(), config);
    run();
    const applied = snapshot();
    assert.deepEqual(Object.keys(applied.Web[host].Handlers).sort(), paths.sort());
    run();
    assert.deepEqual(snapshot(), applied);
    applied.Web[host].Handlers["/"] = { Proxy: "http://127.0.0.1:9876" };
    writeFileSync(state, JSON.stringify(applied));
    assert.throws(() => run());
    assert.deepEqual(snapshot(), applied);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("PR watch replay requires the stamped revision and exact completed run", () => {
  const directory = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(directory);
  const job = mkdtempSync(join(directory, "pr-watch-test-"));
  const capture = join(job, "capture.json");
  const cli = fileURLToPath(new URL("./t3.ts", import.meta.url));
  const at = (second: string) => `2026-01-01T12:00:${second}Z`;
  const key = { host: "github.com", repository: "synthetic/example", number: 7, headSha: "a".repeat(40) };
  const thread = { id: "mcp:launch:synthetic" };
  const message = { id: "message:pr-watch:synthetic", threadId: thread.id, runId: "run:thread:mcp%3Alaunch%3Asynthetic:ordinal:2",
    notification: { source: { kind: "monitor", pullRequest: { ...key, watchStartedAt: at("01") } } },
    createdAt: at("02.125"), text: "Private prose never enters the receipt" };
  const run = { id: message.runId, userMessageId: message.id, threadId: thread.id, status: "completed",
    requestedAt: at("02.125"), startedAt: at("02.250"), completedAt: at("04") };
  const replay = (messages: unknown[] = [message], runs: unknown[] = [run], expected = { ...key, messageId: message.id }) => {
    writeFileSync(capture, JSON.stringify({ version: 1, expected, projection: { thread, messages, runs } }));
    return JSON.parse(execFileSync(process.execPath, [cli, "--replay-pr-watch", job, capture],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  };

  try {
    const proof = replay();
    assert.deepEqual(proof, { thread: thread.id, message: message.id, run: run.id, host: key.host,
      repository: key.repository, number: key.number, head_sha: key.headSha,
      watch_started_ms: Date.parse(at("01")), notification_created_ms: Date.parse(message.createdAt),
      run_started_ms: Date.parse(run.startedAt), run_completed_ms: Date.parse(run.completedAt) });
    assert.deepEqual(replay([message, { ...message, text: "Ignored detail" }], [run, run]), proof);
    assert.deepEqual(replay(), proof);
    assert.equal(replay([message], [{ ...run, userMessageId: "message:other" }]), null);
    assert.equal(replay([message], [{ ...run, id: "run:other" }]), null);
    assert.equal(replay([message], [{ ...run, userMessageId: undefined }]), null);
    assert.equal(replay([message], [{ ...run, threadId: "thread:other" }]), null);
    assert.equal(replay([{ ...message, notification: { source: { kind: "monitor" } } }]), null);
    assert.equal(replay([{ ...message, notification: undefined }]), null);
    assert.equal(replay([message], [{ ...run, startedAt: at("02.124") }]), null);
    assert.equal(replay([message], [{ ...run, startedAt: "" }]), null);
    assert.equal(replay([message], [{ ...run, status: "failed" }]), null);
    assert.equal(replay([message], [run, { ...run, startedAt: at("02.251") }]), null);
    assert.equal(replay([message, { ...message, createdAt: at("02.126") }]), null);
    assert.equal(replay([message], [run], { ...key, messageId: message.id, repository: "synthetic/other" }), null);
    assert.equal(replay([message], [run], { ...key, messageId: message.id, headSha: "b".repeat(40) }), null);
    assert.equal(replay([message], [run], { ...key, messageId: message.id, number: 8 }), null);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

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
