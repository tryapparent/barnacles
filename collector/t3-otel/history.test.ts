import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openT3History } from "../../evidence/index.ts";
import { buildPolicy, loadPolicy } from "../../tooling/bend.ts";
import { historyPage, type HistoryPolicy } from "./history.ts";

test("history stops at an exact local anchor and reconciles a command outside the head", async () => {
  const job = mkdtempSync(join(process.env.PLOW_TEST_DIRECTORY!, "t3-overlap-"));
  const path = join(job, "history.sqlite");
  try {
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
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

test("T3 deployment updates only history, is idempotent and restores the old container on failed readiness", () => {
  const job = mkdtempSync(join(process.env.PLOW_TEST_DIRECTORY!, "t3-promotion-"));
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
  const prepare = new URL("../../dashboard/prepare.ts", import.meta.url);
  const run = (fail = false) => execFileSync(process.execPath, [prepare.pathname, "--deploy-t3-history", job],
    { stdio: "pipe", env: { ...process.env, PATH: `${job}:${process.env.PATH}`, PLOW_T3_DEPLOY_ENV: settings,
      STATE: state, ACTIONS: actions, BREAK_READY: fail ? "1" : "" } });
  try {
    assert.throws(() => run(true));
    assert.equal(readFileSync(state, "utf8"), previous);
    run();
    assert.equal(readFileSync(state, "utf8"), stack);
    const first = readFileSync(actions, "utf8");
    run();
    assert.equal(readFileSync(actions, "utf8"), first);
    assert.match(first, /history-rollback/);
  } finally { rmSync(job, { recursive: true, force: true }); }
});
