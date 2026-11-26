import { execFileSync } from "node:child_process";
import { githubPollRows, loadEvidence, type Milestone, type PullRequest, type ReleaseEvidence, type SourcePolicy } from "../../evidence/index.ts";
import { array, repository, row, seconds, sha, str } from "../wire.ts";
import { collectAttempt, positiveInt, readGitHub, type ClockPolicy } from "./attempt.ts";

function probe(url: string, size: number) {
  try {
    const receipt = execFileSync("curl", [
      "-q", "--silent", "--location", "--max-redirs", "4", "--proto", "=https",
      "--proto-redir", "=https", "--max-time", "20", "--max-filesize", "1",
      "--range", "0-0", "--output", "/dev/null", "--dump-header", "-",
      "--write-out", "%{http_code} %{size_download}", "--", url,
    ], { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] });
    const [http, bytes] = receipt.trimEnd().split("\n").at(-1)!.split(" ").map(Number);
    const range = receipt.split(/\r?\n/).findLast((line) => /^content-range:/i.test(line));
    return { http: http || 0, bytes: bytes || 0, range: range?.toLowerCase() === `content-range: bytes 0-0/${size}` };
  } catch {
    return { http: 0, bytes: 0, range: false };
  }
}

function workflowRuns(path: string, read: typeof readGitHub) {
  let response: Record<string, unknown>;
  try { response = row(read(path)); }
  catch { return []; }
  if (!Array.isArray(response.workflow_runs) || response.workflow_runs.length > 100 ||
      response.total_count !== response.workflow_runs.length) return [];
  return response.workflow_runs.map(row);
}

function firstPRCI(repo: string, pr: Record<string, unknown>, commits: unknown[], complete: boolean,
  opened: number, merged: number | null, policy: SourcePolicy, read: typeof readGitHub) {
  if (!merged || !pr.head) return null;
  const head = row(pr.head);
  const baseRepo = row(row(pr.base).repo);
  const branch = str(head.ref);
  if (!branch || baseRepo.id === undefined) return null;
  const period = [opened, merged].map((clock) => new Date(clock * 1000).toISOString().replace(".000Z", "Z")).join("..");
  const query = new URLSearchParams({ event: "pull_request", branch, created: period, per_page: "100" });
  const revisions = new Set(commits.map((commit) => str(row(commit).sha)));
  const first = workflowRuns(`repos/${repo}/actions/runs?${query}`, read).reduce<Milestone>((best, run) => {
    if (!Array.isArray(run.pull_requests)) return best;
    const prLinks = run.pull_requests.map(row);
    const explicit = prLinks.some((link) => link.number === pr.number && link.base &&
      row(link.base).repo && row(row(link.base).repo).id === baseRepo.id);
    const headRepoId = head.repo ? row(head.repo).id : null;
    const runRepoId = run.repository ? row(run.repository).id : null;
    const runHeadRepoId = run.head_repository ? row(run.head_repository).id : null;
    const revision = str(run.head_sha);
    const sameBranch = Boolean(prLinks.length === 0 && complete && runRepoId === baseRepo.id &&
      headRepoId && headRepoId === runHeadRepoId && run.head_branch === branch &&
      revision && revisions.has(revision));
    const at = seconds(run.run_started_at);
    return policy.pr_ci_start(str(run.event), str(run.status), str(run.conclusion), Number(run.run_attempt ?? 0),
      explicit || sameBranch, opened, at, merged)
      ? policy.pick_milestone(best, { $: "Milestone", id: String(positiveInt(run.id)), at }) : best;
  }, { $: "Milestone", id: "", at: 0xffffffff });
  return first.id ? { id: Number(first.id), at: first.at } : null;
}

function releaseDispatch(root: string, source: string, published: number, policy: SourcePolicy, read: typeof readGitHub) {
  const query = new URLSearchParams({ head_sha: source, event: "workflow_dispatch", per_page: "100" });
  const runs = workflowRuns(`${root}/actions/workflows/verification.yml/runs?${query}`, read).filter((run) => {
    const identity = /^main · source ([0-9a-f]{40}) · candidate run ([1-9]\d*)(?: ·|$)/.exec(str(run.display_title));
    return policy.publishing_run(str(run.event), str(run.conclusion), seconds(run.created_at), published,
      seconds(run.updated_at), policy.same_revision(identity?.[1] ?? "", source), identity?.[2] === String(run.id));
  });
  return runs.length === 1 ? { id: positiveInt(runs[0].id), at: seconds(runs[0].created_at) } : null;
}

export function pullRequest(repo: string, number: number, policy: SourcePolicy, read = readGitHub, includeCI = false): PullRequest {
  const name = repository(repo);
  const path = `repos/${name}/pulls/${positiveInt(number)}`;
  const pr = row(read(path));
  if (pr.number !== number || repository(row(row(pr.base).repo).full_name) !== name) {
    throw Error("GitHub pull request identity mismatch");
  }
  const opened = seconds(pr.created_at);
  if (!opened) throw Error("Missing GitHub pull request creation time");
  const merged = policy.merged_at(opened, seconds(pr.merged_at), pr.merged === true) || null;
  const commitCount = pr.commits === 0 ? 0 : positiveInt(pr.commits);
  const commits = array(read(path + "/commits?per_page=100"), 100);
  const empty: Milestone = { $: "Milestone", id: "", at: 0xffffffff };
  const commitsComplete = policy.commit_complete(commitCount, commits.length);
  const earliestCommit = commits.reduce<Milestone>((best, value) => {
    const commit = row(value);
    return policy.pick_milestone(best, {
      $: "Milestone", id: sha(commit.sha), at: seconds(row(row(commit.commit).committer).date),
    });
  }, empty);
  const reviews = array(read(path + "/reviews?per_page=100"), 100);
  const earliestReview = reviews.reduce<Milestone>((best, value) => {
    const review = row(value);
    return policy.pick_review(best, {
      $: "Milestone", id: String(positiveInt(review.id)), at: seconds(review.submitted_at),
    }, opened);
  }, empty);
  const firstCommit = policy.keep_commit(commitsComplete, earliestCommit)
    ? { sha: earliestCommit.id, at: earliestCommit.at } : null;
  const firstReview = earliestReview.id ? { id: Number(earliestReview.id), at: earliestReview.at } : null;
  return {
    repository: name, number, opened, merged, mergeSha: merged ? sha(pr.merge_commit_sha) : null,
    state: policy.link_state(merged ? "merged" : str(pr.state)),
    firstCommit, commitsComplete, firstReview, reviewsComplete: reviews.length < 100,
    firstCI: includeCI ? firstPRCI(name, pr, commits, commitsComplete, opened, merged, policy, read) : null,
    updated: seconds(pr.updated_at),
  };
}

export function releaseEvidence(pr: PullRequest, tag: string, policy: SourcePolicy,
  read = readGitHub, access = probe, includeDispatch = false): ReleaseEvidence {
  const source = sha(policy.linux_main_source(str(tag)));
  const root = `repos/${pr.repository}`;
  const release = row(read(`${root}/releases/tags/${tag}`));
  if (release.tag_name !== tag) throw Error("GitHub release tag mismatch");
  const gitObject = row(row(read(`${root}/git/ref/tags/${tag}`)).object);
  const tagMatches = gitObject.type === "commit" && policy.same_revision(str(gitObject.sha), source);
  const published = seconds(release.published_at);
  let ancestry = "unknown";
  if (pr.mergeSha && tagMatches) {
    if (policy.same_revision(pr.mergeSha, source)) {
      ancestry = "equal";
    } else {
      const comparison = row(read(`${root}/compare/${pr.mergeSha}...${source}?per_page=1`));
      ancestry = policy.proves_ancestry(str(row(comparison.base_commit).sha),
        str(row(comparison.merge_base_commit).sha), pr.mergeSha, str(comparison.status)) ? "ancestor" : "unproven";
    }
  }

  const candidates = array(release.assets, 1000).map(row).filter((asset) =>
    policy.linux_main_asset(str(asset.state), str(asset.name)) && /^[A-Za-z0-9._+-]+$/.test(str(asset.name)));
  const asset = candidates.length === 1 ? candidates[0] : undefined;
  const name = str(asset?.name);
  const url = `https://github.com/${pr.repository}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const proof = asset && policy.may_probe(candidates.length, published, release.draft === false, tagMatches)
    ? access(url, positiveInt(asset.size)) : { http: 0, bytes: 0, range: false };
  const checked = Math.floor(Date.now() / 1000);
  const accessible = policy.asset_access(proof.http, proof.bytes, proof.range);
  const shipped = policy.shipping(pr.merged ?? 0, published, checked,
    ancestry === "equal" || ancestry === "ancestor", accessible);
  return {
    id: positiveInt(release.id), tag, source, tagMatches, channel: "linux-main-x86_64",
    published: published || null, assetId: asset ? positiveInt(asset.id) : null,
    checked, http: proof.http || null, bytes: proof.http ? proof.bytes : null, accessible, ancestry,
    shipped, dispatch: includeDispatch && shipped ? releaseDispatch(root, source, published, policy, read) : null,
  };
}

export function pollGitHub(database: string, repo: string, policy: SourcePolicy, clocks: ClockPolicy,
  read = readGitHub, access = probe) {
  const root = `repos/${repo}`;
  const prs = array(read(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=30`), 30).map(row);
  const inventory = row(read(`${root}/actions/runs?per_page=30`));
  const runs = array(inventory.workflow_runs, 30).map(row);
  const releases = array(read(`${root}/releases?per_page=20`), 20).map(row);
  const stored = githubPollRows(database, repo);
  const prClocks = new Map(stored.prs.map((pr) => [Number(pr.pr_number), Number(pr.updated_at)]));
  const attempts = new Map(stored.attempts.map((run) => [`${run.run_id}/${run.attempt}`, run]));
  const changes = new Map<number, PullRequest>();
  let failed = 0;
  function capture(kind: string, action: () => void) {
    try {
      action();
    } catch (error) {
      failed++;
      console.error(`GitHub poll ${kind} failed: ${(error as Error).message}`);
    }
  }
  for (const item of prs) capture("pull request", () => {
    const number = positiveInt(item.number);
    const updated = seconds(item.updated_at);
    if (!updated) throw Error("Missing pull request update time");
    if (!policy.poll_pr_needed(updated, prClocks.get(number) ?? 0)) return;
    const pr = pullRequest(repo, number, policy, read, true);
    loadEvidence(database, { source: "github-delivery", pullRequest: pr });
    changes.set(number, pr);
  });
  for (const run of runs) capture("workflow", () => {
    const runId = positiveInt(run.id);
    const attempt = positiveInt(run.run_attempt);
    const updated = seconds(run.updated_at);
    if (!updated) throw Error("Missing workflow update time");
    const previous = attempts.get(`${runId}/${attempt}`);
    if (!policy.poll_attempt_needed(updated, Number(previous?.source_updated ?? 0), str(previous?.status))) return;
    const fact = collectAttempt({ repository: repo, runId, attempt, sha: sha(run.head_sha) }, clocks, read);
    loadEvidence(database, { source: "github-actions", attempt: fact });
  });
  const mergeShas = new Map(stored.prs.map((pr) => [Number(pr.pr_number), str(pr.merge_sha)]));
  for (const pr of changes.values()) mergeShas.set(pr.number, pr.mergeSha ?? "");
  const byMerge = Map.groupBy(mergeShas, ([, merge]) => merge);
  const proofs = Map.groupBy(stored.releases, (release) => `${release.pr_number}/${release.release_id}`);
  for (const item of releases) capture("release", () => {
    const tag = str(item.tag_name);
    const source = policy.poll_release_source(tag, seconds(item.published_at), item.draft !== false);
    if (!source) return;
    const releaseId = positiveInt(item.id);
    for (const [number] of byMerge.get(source) ?? []) {
      if (proofs.get(`${number}/${releaseId}`)?.some((old) =>
        policy.poll_release_recorded(old.shipped === 1, str(old.merge_sha), source))) continue;
      const pr = changes.get(number) ?? pullRequest(repo, number, policy, read, true);
      if (!policy.same_revision(pr.mergeSha ?? "", source)) continue;
      const release = releaseEvidence(pr, tag, policy, read, access, true);
      if (release.id !== releaseId) throw Error("GitHub release identity changed during polling");
      loadEvidence(database, { source: "github-delivery", pullRequest: pr, release });
    }
  });
  return { pullRequestsScanned: prs.length, workflowRunsScanned: runs.length, releasesScanned: releases.length, failed };
}
