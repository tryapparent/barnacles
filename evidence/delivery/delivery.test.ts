import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadEvidence, type PullRequest, type ReleaseEvidence } from "../index.ts";

test("the report keeps each release proof bound to its own observation across replay and replacement", () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent);
  const job = mkdtempSync(join(parent, "release-proof-"));
  const path = join(job, "evidence.sqlite");
  const saveDelivery = (pullRequest: PullRequest, release?: ReleaseEvidence) =>
    loadEvidence(path, { source: "github-delivery", pullRequest, release });
  const sha = "a".repeat(40);
  const base = 1760000000;
  const pr: PullRequest = { repository: "synthetic/example", number: 1, state: "merged", opened: base, merged: base + 10,
    mergeSha: sha, firstCommit: null, firstReview: null, commitsComplete: true, reviewsComplete: true, updated: base + 10 };
  const proof: ReleaseEvidence = { id: 1, tag: "synthetic", source: sha, channel: "linux-main-x86_64",
    tagMatches: true, published: base + 30, assetId: 1, checked: base + 40, http: 206, bytes: 1,
    accessible: true, ancestry: "equal", shipped: true, dispatch: { id: 5, at: base + 20 } };
  const report = () => JSON.parse(execFileSync(process.execPath,
    ["collector/import-sources.ts", job, "report"], { encoding: "utf8" }));
  try {
    saveDelivery(pr);
    const legacyPR = { ...pr, number: 2 };
    const unsafeLegacy = { ...pr, number: 3 };
    saveDelivery(legacyPR);
    saveDelivery(unsafeLegacy);
    const fixture = new DatabaseSync(path);
    try {
      fixture.exec(`
        CREATE TABLE github_releases(repository, release_id, channel, source_sha, published_at, asset_id);
        CREATE TABLE github_asset_checks(repository, release_id, channel, checked_at, asset_id);
        CREATE TABLE github_release_proofs(repository, pr_number, release_id, channel, checked_at, ancestry, shipped, merge_sha);
      `);
      for (const legacy of [legacyPR, unsafeLegacy]) {
        const key = [legacy.repository, legacy.number, proof.channel] as const;
        fixture.prepare("INSERT INTO github_releases VALUES (?, ?, ?, ?, ?, ?)").run(...key, sha, proof.published, proof.assetId);
        fixture.prepare("INSERT INTO github_asset_checks VALUES (?, ?, ?, ?, ?)").run(...key, proof.checked, proof.assetId);
        fixture.prepare("INSERT INTO github_release_proofs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          legacy.repository, legacy.number, legacy.number, proof.channel, proof.checked, proof.ancestry, 1, sha);
      }
      fixture.prepare("INSERT INTO github_asset_checks VALUES (?, ?, ?, ?, ?)").run(
        unsafeLegacy.repository, unsafeLegacy.number, proof.channel, proof.checked + 1, 2);
    } finally {
      fixture.close();
    }

    saveDelivery(pr, proof);
    saveDelivery(pr, proof);
    const replacement = { ...proof, source: "b".repeat(40), published: base + 80, assetId: 2, checked: base + 100,
      http: 404, bytes: null, accessible: false, shipped: false, dispatch: null };
    saveDelivery(pr, replacement);
    saveDelivery(pr, replacement);
    const [historical, legacy, conflicting] = report();
    assert.deepEqual([historical.asset_id, historical.published_at, historical.checked_at, historical.release_run],
      [proof.assetId, proof.published, proof.checked, proof.dispatch?.id]);
    assert.equal(historical.pr_to_release_seconds, 30);
    assert.equal(legacy.pr_to_release_seconds, 30);
    assert.equal(conflicting.pr_to_release_seconds, null);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS n FROM github_release_observations").get()?.n, 2);
    } finally {
      db.close();
    }
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
