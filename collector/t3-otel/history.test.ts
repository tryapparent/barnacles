import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { openT3History, readT3Projections, sourcePolicy } from "../../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { historyPage, type HistoryPolicy } from "./history.ts";
import { stockProjection, watchPolicy, type ProjectionCodec, type WatchCodec } from "./projection.ts";

function scratch(t: TestContext, label: string) {
  const job = mkdtempSync(join(process.env.PLOW_TEST_DIRECTORY!, label));
  t.after(() => rmSync(job, { recursive: true, force: true }));
  return job;
}

function promotion(job: string, state: string, actions: string, settings: Record<string, string>) {
  const prepare = new URL("../../dashboard/prepare.ts", import.meta.url);
  return (fail = false) => execFileSync(process.execPath, [prepare.pathname, "--deploy-t3-history", job], {
    env: { ...process.env, PATH: `${job}:${process.env.PATH}`, STATE: state, ACTIONS: actions,
      ...settings, BREAK_READY: fail ? "1" : "" },
  });
}

test("history loads from the container source layout", (t) => {
  const job = scratch(t, "history-package-");
  const compose = parse(readFileSync(new URL("./compose.yaml", import.meta.url), "utf8"));
  for (const [, copy] of compose.services.history.build.dockerfile_inline.matchAll(/^COPY (.+)$/gm)) {
    const inputs = copy.trim().split(/\s+/);
    const destination = inputs.pop()!;
    for (const input of inputs) {
      const output = join(job, destination, destination.endsWith("/") ? basename(input) : "");
      mkdirSync(dirname(output), { recursive: true });
      cpSync(new URL("../../" + input, import.meta.url), output, { recursive: true });
    }
  }
  execFileSync(process.execPath, ["--input-type=module", "-e", 'await import("./collector/codex/otel.ts")'], { cwd: job });
});

test("history resumes at a local anchor and reconciles an older command", async (t) => {
  const job = scratch(t, "t3-overlap-");
  const path = join(job, "history.sqlite");
  const policy = await loadPolicy<HistoryPolicy>(
    await buildPolicy(job, new URL("./history.bend", import.meta.url), "history.mjs"));
  const command = { id: "older-command", threadId: "fixture", type: "command_execution",
    status: "running", ordinal: 1, updatedAt: "2026-01-01T00:00:00Z",
    providerThreadId: "native-thread", providerTurnId: "native-turn",
    nativeItemRef: { driver: "codex", strength: "strong", nativeId: "native-item" } };
  const anchor = { id: "anchor", threadId: "fixture", type: "user_message", ordinal: 2 };
  const head = (items: unknown[], sequence = 1) => ({ snapshotSequence: sequence, historyCursor: "older",
    hasMoreHistory: true, projection: { thread: { id: "fixture" }, turnItems: items } });
  const initial = historyPage(policy, "fixture", head([command, anchor]), "");
  assert.equal(initial.tip, "anchor");
  assert.equal(initial.next, "older");
  const older = (sourceThreadId: string, visibility: string) => ({ snapshotSequence: 2, nextCursor: "ancient",
    hasMoreHistory: true, items: [{ sourceThreadId, visibility, item: anchor }] });
  assert.equal(historyPage(policy, "fixture", older("other", "inherited"), "older", "anchor").next, "ancient");
  assert.equal(historyPage(policy, "fixture", older("fixture", "local"), "older", "anchor").next, "");
  const overlapping = historyPage(policy, "fixture", head([anchor, { ...anchor, id: "new-tip", ordinal: 3 }], 2), "", "anchor");
  assert.equal(overlapping.next, "");
  assert.equal(overlapping.tip, "new-tip");
  const finished = historyPage(policy, "fixture", head([{ ...command, status: "completed", exitCode: 7,
    updatedAt: "2026-01-01T00:00:02Z", completedAt: "2026-01-01T00:00:02Z" }]), "").commands[0];
  const store = openT3History(path, "source", policy.replay, policy.stale_item);
  try {
    store.commit("fixture", "", "", 1, initial.commands, { revision: 1, frontier: 1, covered: initial.tip });
    const mark = policy.advance_checkpoint(false, "", "anchor", 2, overlapping.tip, 2, 1, 0, overlapping.next);
    assert.ok(mark.$ === "Some");
    store.commit("fixture", "", overlapping.next, 2, overlapping.commands, mark.value);
    store.reconcile("fixture", command.id, 3, { ...finished, native_item: "wrong" }, policy.confirm_exit);
    assert.equal(store.pending().length, 1);
    store.reconcile("fixture", command.id, 4, finished, policy.confirm_exit);
    store.commit("fixture", "", "", 3, initial.commands);
    assert.equal(store.pending().length, 0);
  } finally {
    store.close();
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT exit_code FROM t3_history_commands").get()?.exit_code, 7);
    assert.equal(db.prepare("SELECT covered FROM t3_history_anchors").get()?.covered, "new-tip");
  } finally { db.close(); }
});

test("T3 deployment is scoped, idempotent, and restores failed updates", (t) => {
  const job = scratch(t, "t3-promotion-");
  const stack = join(job, "collector/t3-otel/compose.yaml");
  const previous = join(job, "original.yaml");
  const settings = join(job, "compose.env");
  const state = join(job, "state");
  const actions = join(job, "actions");
  mkdirSync(join(job, "collector/t3-otel"), { recursive: true });
  for (const path of [stack, previous, settings, actions]) writeFileSync(path, "");
  writeFileSync(state, previous);
  writeFileSync(join(job, "docker"), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(4), state=process.env.STATE, stack=args[args.indexOf('-f')+1];
if (args.includes('config')) console.log(JSON.stringify({services:{history:{healthcheck:{}}}}));
else if (args.includes('ps')) console.log('history-container');
else if (args[0]==='inspect') console.log(JSON.stringify([{Image:'sha256:old',Config:{Image:'project-history',Labels:{'com.docker.compose.project.config_files':fs.readFileSync(state,'utf8')}},State:{Health:{Status:'healthy'}}}]));
else {
  if (args.includes('up') && (!args.includes('--no-deps') || args.at(-1)!=='history')) process.exit(2);
  fs.appendFileSync(process.env.ACTIONS,JSON.stringify(args)+'\\n');
  if (args.includes('up')) {
    fs.writeFileSync(state,stack);
    if (args.includes('--wait') && process.env.BREAK_READY==='1') process.exit(1);
  }
}
`, { mode: 0o700 });
  const run = promotion(job, state, actions, { PLOW_T3_DEPLOY_ENV: settings });
  assert.throws(() => run(true));
  assert.equal(readFileSync(state, "utf8"), previous);
  run();
  assert.equal(readFileSync(state, "utf8"), stack);
  const first = readFileSync(actions, "utf8");
  run();
  assert.equal(readFileSync(actions, "utf8"), first);
  assert.match(first, /history-rollback/);
});

test("ordinary refresh joins stock T3 history, traces, and exact CI", async (t) => {
  const job = scratch(t, "t3-live-join-");
  const [history, forge, codex, joined] = ["history", "forge", "codex", "joined"].map(name => join(job, name + ".sqlite"));
  const now = Date.now() - 2000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const sec = Math.floor(now / 1000);
  const repository = "fixture/project";
  const sha = "a".repeat(40);
  const forgeDb = new DatabaseSync(forge);
  forgeDb.exec(readFileSync(new URL("../../evidence/storage/actions.sql", import.meta.url), "utf8"));
  forgeDb.prepare("INSERT INTO action_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    repository, 42, 1, sha, 7, "completed", "failure", sec - 2, sec - 1, sec, sec, 1);
  forgeDb.prepare("INSERT INTO action_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    repository, 42, 1, 47, "fixture lane", "completed", "failure", sec - 2, 0, sec - 1, sec - 1, sec);
  forgeDb.close();
  const traces = new DatabaseSync(codex);
  traces.exec(readFileSync(new URL("../../evidence/storage/sources.sql", import.meta.url), "utf8"));
  const ns = (ms: number) => String(BigInt(ms) * 1000000n);
  traces.prepare("INSERT INTO codex_otel_spans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "codex-fixture", "a".repeat(32), "b".repeat(16), null, "agent.span", ns(now), ns(now + 100), 0,
    "session-fixture", null, null, "fingerprint");
  traces.close();
  const codec = await loadPolicy<ProjectionCodec>(await buildPolicy(job, sourcePolicy, "sources.mjs"));
  const watches = await loadPolicy<WatchCodec>(await buildPolicy(job, watchPolicy, "watches.mjs"));
  const policy = await loadPolicy<HistoryPolicy>(
    await buildPolicy(job, new URL("./history.bend", import.meta.url), "history.mjs"));
  const instance = "t3-fixture";
  const id = "thread-fixture";
  const pullRequest = { host: "github.com", repository, number: 1, source: "agent", snapshot: { state: "open" } };
  const run = { id: "run-fixture", threadId: id, requestedAt: iso(now), startedAt: iso(now + 100),
    completedAt: iso(now + 1000), status: "completed" };
  const reference = { id: "ref-fixture", appThreadId: id, driver: "codex",
    nativeThreadRef: { driver: "codex", nativeId: "session-fixture", strength: "strong" } };
  const monitor = { id: "message:pr-watch:fixture", threadId: id, runId: run.id, createdAt: iso(now + 1100),
    notification: { source: { kind: "monitor", pullRequest: { ...pullRequest, headSha: sha, watchStartedAt: run.startedAt } } } };
  const projection = stockProjection(instance, id, {
    thread: { id, createdAt: iso(now), updatedAt: iso(now + 1200), createdBy: "user", creationSource: "web",
      settledAt: run.completedAt, title: "Fix labels",
      pullRequests: [pullRequest, { ...pullRequest, host: "gitlab.com" }] },
    runs: [run, { ...run, threadId: "inherited" }], providerThreads: [reference],
    messages: [monitor],
  }, codec, policy.local_row, watches);
  const shared = join(job, "projection", "evidence.sqlite");
  const store = openT3History(history, instance, policy.replay, policy.stale_item, shared);
  try {
    assert.deepEqual([false, true].map(saved => policy.projection_due(now, now, now, saved)), [true, false]);
    assert.ok(!policy.projection_due(now - 604800001, 0, now, false));
    store.commit(id, "", "", 1, [], undefined, projection);
    assert.throws(() => store.commit(id, "another-reader", "", 2, [], undefined, projection));
    const stale = { ...projection, thread: { ...projection.thread, updated: now } };
    store.commit(id, "", "", 2, [], undefined, stale);
    assert.deepEqual(readT3Projections(shared, instance, now), [projection]);
    assert.deepEqual([projection.thread.runs.length, projection.thread.pullRequests.length], [1, 1]);
    store.commit(id, "", "", 3, [], undefined, { ...projection, prWatches: [] });
    assert.deepEqual(readT3Projections(shared, instance, now), [projection]);
  } finally { store.close(); }
  const receipt = { t3Instance: instance, threadId: id, codexInstance: "codex-fixture",
    references: [reference], ci: { observationId: "obs-fixture", kind: "query", repository,
      runId: 42, attempt: 1, headSha: sha } };
  writeFileSync(join(job, "receipt.json"), JSON.stringify(receipt));
  writeFileSync(join(job, "expired.json"), JSON.stringify({ ...receipt, threadId: "expired-fixture" }));
  const activity = join(job, "activity");
  mkdirSync(activity);
  const refresh = () => JSON.parse(String(execFileSync(process.execPath, [new URL("../wire.ts", import.meta.url).pathname,
    job, forge, codex, job, joined], { env: { ...process.env, PLOW_ANALYSIS_T3_HISTORY_DB: shared, PLOW_ANALYSIS_ACTIVITY_DIR: activity,
      PLOW_ANALYSIS_T3_INSTANCE: instance, PLOW_ANALYSIS_CODEX_INSTANCE: "codex-fixture" } })));
  assert.equal(refresh().exactCiReceipts, 1);
  const output = new DatabaseSync(joined, { readOnly: true });
  try {
    const summary = JSON.parse(String(output.prepare("SELECT payload FROM analysis_summary").get()?.payload));
    assert.deepEqual(summary.coverage, { $: "Coverage", active: 1, withCodex: 1, withCI: 1, withBoth: 1 });
    const feed = JSON.parse(readFileSync(join(activity, "timeline.json"), "utf8"));
    assert.equal(feed.overview.to, Date.parse(summary.analyzedAt));
    assert.deepEqual([feed.traces[0].end, feed.traces[0].extent, feed.traces[0].ci], [1, 1.1, [[.1, 1.1, "T3 PR watch"]]]);
    assert.equal(feed.traces[0].title, "Fix labels");
  } finally { output.close(); }
  assert.equal(refresh().recomputed, 0);
});

test("analysis promotion restores each prior Compose release", (t) => {
  const job = scratch(t, "analysis-split-release-");
  const settings = join(job, "compose.env");
  const stack = join(job, "compose.yaml");
  const api = join(job, "previous-api.yaml");
  const refresh = join(job, "previous-refresh.yaml");
  const state = join(job, "state.json");
  const log = join(job, "actions");
  for (const file of [settings, stack, api, refresh, log]) writeFileSync(file, "");
  const old = { "analysis-api": api, "analysis-refresh": refresh };
  writeFileSync(state, JSON.stringify(old));
  writeFileSync(join(job, "docker"), `#!${process.execPath}
const fs=require('node:fs'), args=process.argv.slice(4);
const state=JSON.parse(fs.readFileSync(process.env.STATE,'utf8'));
if (args[0]==='inspect') {
  const name=args[1];
  console.log(JSON.stringify([{Image:'sha256:'+name,Config:{Image:name,
    Labels:{'com.docker.compose.project.config_files':state[name]}},State:{Health:{Status:'healthy'}}}]));
} else if (args.includes('config')) {
  console.log(JSON.stringify({services:{
    'analysis-api':{ports:[{host_ip:'127.0.0.1'}],healthcheck:{}},
    'analysis-refresh':{environment:{PLOW_ANALYSIS_T3_HISTORY_DB:'/test.sqlite'},healthcheck:{}},
  }}));
} else if (args.includes('ps')) console.log(args.at(-1));
else {
  fs.appendFileSync(process.env.ACTIONS,JSON.stringify(args)+'\\n');
  if (args.includes('up')) {
    if (!args.includes('--no-build')) process.exit(2);
    const start=args.indexOf('analysis-refresh');
    for (const name of args.slice(start<0 ? args.length-1 : start)) state[name]=args[args.indexOf('-f')+1];
    fs.writeFileSync(process.env.STATE,JSON.stringify(state));
    if (args.includes('--wait')&&process.env.BREAK_READY==='1') process.exit(1);
  }
}
`, { mode: 0o700 });
  const deploy = promotion(job, state, log, {
    PLOW_T3_DEPLOY_ENV: join(job, "absent"), PLOW_ANALYSIS_DEPLOY_ENV: settings,
  });
  assert.throws(() => deploy(true));
  assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), old);
  assert.match(readFileSync(log, "utf8"), /--wait/);
  deploy();
  assert.deepEqual(JSON.parse(readFileSync(state, "utf8")), { "analysis-api": stack, "analysis-refresh": stack });
  const after = readFileSync(log, "utf8");
  deploy();
  assert.equal(readFileSync(log, "utf8"), after);
});
