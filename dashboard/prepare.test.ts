import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { saveDelivery, saveThread } from "../evidence/sources.ts";

test("dashboard derives a covered comparison and preserves missing source coverage", () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "dashboard-test-"));
  try {
    const repo = "synthetic/example";
    const source = join(job, "source.sqlite");
    const week = 7 * 86400;
    const cutoff = Math.floor(Date.now() / 1000);
    const monday = cutoff - ((cutoff + 3 * 86400) % week);
    for (const [pr, published, cycle] of [
      [1, monday - 2 * week + 7200, 1800],
      [2, monday - week + 7200, 5400],
    ]) {
      const sha = String(pr).repeat(40);
      saveDelivery(source, {
        repository: repo, number: pr, state: "merged", opened: published - 1000,
        merged: published - 500, mergeSha: sha, firstCommit: null, firstReview: null,
        commitsComplete: false, reviewsComplete: false, updated: published,
      }, {
        id: pr, tag: `linux-main-v2-${sha}`, source: sha, tagMatches: true, channel: "linux-main-x86_64",
        published, assetId: pr, checked: published + 1, http: 206, bytes: 1,
        accessible: true, ancestry: "equal", shipped: true,
      });
      saveThread(source, {
        instance: "synthetic", id: `thread-${pr}`, created: (published - cycle) * 1000,
        updated: published * 1000, status: "completed", origin: "manual_t3", settled: true, runs: [],
        pullRequests: [{ repository: repo, number: pr, source: "created", state: "merged", owning: true }],
      });
    }
    const out = join(job, "out");
    execFileSync(process.execPath, ["dashboard/prepare.ts", source, out, repo], { stdio: "pipe", timeout: 60_000 });
    const db = new DatabaseSync(join(out, "dashboard.sqlite"), { readOnly: true });
    try {
      const summary = db.prepare("SELECT shipped, linked, direction, delta_seconds FROM coverage").get();
      assert.deepEqual(Object.values(summary!), [2, 2, "Gardening", 3600]);
      assert.equal(db.prepare("SELECT count(*) AS n FROM time_map").get()?.n, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM trace").get()?.n, 0);
      const config = JSON.parse(readFileSync(join(out, "dashboards/shipping.json"), "utf8"));
      assert.equal(config.uid, "barnacles-shipping");
      assert.ok(config.panels.some(({ type }: { type: string }) => type === "marcusolsson-treemap-panel"));
    } finally { db.close(); }
  } finally { rmSync(job, { recursive: true, force: true }); }
});
