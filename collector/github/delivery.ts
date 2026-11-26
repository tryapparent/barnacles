import { execFileSync } from "node:child_process";
import { githubPollRows, loadEvidence, repository, type AdmissionPolicy, type List, type Milestone, type PullRequest, type ReleaseEvidence, type SourcePolicy } from "../../evidence/index.ts";
import { array, bendList, row, seconds, sha, str } from "../wire.ts";
import { collectAttempt, positiveInt, readGitHub, type ClockPolicy } from "./attempt.ts";

type PRTarget = { $: "PRTarget"; number: string; repo: string; fork: string; branch: string; opened: number; merged: number };
type PRLink = { $: "PRLink"; number: string; repo: string };
type WorkflowRun = { $: "WorkflowRun"; id: string; event: string; status: string; conclusion: string; attempt: string;
  repo: string; fork: string; branch: string; revision: string; links_known: boolean; links: List<PRLink>; started: number };
type DispatchRun = { $: "DispatchRun"; id: string; event: string; conclusion: string; title: string; created: number; updated: number };
type ReleaseAsset = { $: "ReleaseAsset"; index: number; state: string; name: string };
type DeliveryPolicy = SourcePolicy & {
  pr_identity(number: string, expectedNumber: string, repo: string, expectedRepo: string): boolean;
  workflow_complete(expected: string, returned: string, size: number, arraySeen: boolean): boolean;
  search_pr_ci(target: PRTarget): boolean;
  first_pr_workflow(runs: List<WorkflowRun>, target: PRTarget, revisions: List<string>, complete: boolean): Milestone;
  release_dispatch(runs: List<DispatchRun>, source: string, published: number): Milestone;
  pr_commits(expected: string, commits: List<Milestone>): { first: Milestone; complete: boolean };
  pr_reviews(reviews: List<Milestone>, opened: number): { first: Milestone; complete: boolean };
  same_tag(observed: string, requested: string): boolean;
  tag_matches(kind: string, revision: string, source: string): boolean;
  ancestry_request(merge: string, source: string, tagVerified: boolean): string;
  ancestry_result(base: string, mergeBase: string, expected: string, status: string): string;
  choose_asset(assets: List<ReleaseAsset>, published: number, publicRelease: boolean, verified: boolean):
    { index: number; probe: boolean };
  release_shipped(merged: number, published: number, checked: number, ancestry: string, access: boolean): boolean;
  range_matches(header: string, size: string): boolean;
};

const githubId = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : "";

function observation(milestone: Milestone) {
  return milestone.id ? { id: Number(milestone.id), at: milestone.at } : null;
}

function probe(url: string, size: number, policy: DeliveryPolicy) {
  try {
    const receipt = execFileSync("curl", [
      "-q", "--silent", "--location", "--max-redirs", "4", "--proto", "=https",
      "--proto-redir", "=https", "--max-time", "20", "--max-filesize", "1",
      "--range", "0-0", "--output", "/dev/null", "--dump-header", "-",
      "--write-out", "%{http_code} %{size_download}", "--", url,
    ], { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] });
    const [http, bytes] = receipt.trimEnd().split("\n").at(-1)!.split(" ").map(Number);
    const range = receipt.split(/\r?\n/).findLast((line) => /^content-range:/i.test(line));
    return { http: http || 0, bytes: bytes || 0, range: policy.range_matches(range?.toLowerCase() ?? "", String(size)) };
  } catch {
    return { http: 0, bytes: 0, range: false };
  }
}

function workflowRuns(path: string, read: typeof readGitHub, policy: DeliveryPolicy) {
  let response: Record<string, unknown>;
  try { response = row(read(path)); }
  catch { return []; }
  const runs = Array.isArray(response.workflow_runs) ? response.workflow_runs : undefined;
  const size = runs?.length ?? 0;
  const expected = typeof response.total_count === "number" ? String(response.total_count) : "";
  return policy.workflow_complete(expected, String(size), size, runs !== undefined) ? runs!.map(row) : [];
}

function firstPRCI(repo: string, pr: Record<string, unknown>, revisions: string[], complete: boolean,
  opened: number, merged: number | null, policy: DeliveryPolicy, read: typeof readGitHub) {
  const head = pr.head ? row(pr.head) : {};
  const baseRepo = row(row(pr.base).repo);
  const target: PRTarget = { $: "PRTarget", number: githubId(pr.number), repo: githubId(baseRepo.id),
    fork: head.repo ? githubId(row(head.repo).id) : "", branch: str(head.ref), opened, merged: merged ?? 0 };
  if (!policy.search_pr_ci(target)) return null;
  const period = [target.opened, target.merged].map((clock) => new Date(clock * 1000).toISOString().replace(".000Z", "Z")).join("..");
  const query = new URLSearchParams({ event: "pull_request", branch: target.branch, created: period, per_page: "100" });
  const runs = workflowRuns(`repos/${repo}/actions/runs?${query}`, read, policy).map((run): WorkflowRun => {
    const links = Array.isArray(run.pull_requests) ? run.pull_requests.map(row) : undefined;
    return { $: "WorkflowRun", id: githubId(run.id), event: str(run.event), status: str(run.status),
      conclusion: str(run.conclusion), attempt: typeof run.run_attempt === "number" || typeof run.run_attempt === "string"
        ? String(run.run_attempt) : "",
      repo: run.repository ? githubId(row(run.repository).id) : "",
      fork: run.head_repository ? githubId(row(run.head_repository).id) : "", branch: str(run.head_branch),
      revision: str(run.head_sha), started: seconds(run.run_started_at), links_known: links !== undefined,
      links: bendList((links ?? []).map((link): PRLink => {
        const base = link.base ? row(link.base) : {};
        return { $: "PRLink", number: githubId(link.number), repo: base.repo ? githubId(row(base.repo).id) : "" };
      })) };
  });
  return observation(policy.first_pr_workflow(bendList(runs), target, bendList(revisions), complete));
}

function releaseDispatch(root: string, source: string, published: number, policy: DeliveryPolicy, read: typeof readGitHub) {
  const query = new URLSearchParams({ head_sha: source, event: "workflow_dispatch", per_page: "100" });
  const runs = workflowRuns(`${root}/actions/workflows/verification.yml/runs?${query}`, read, policy).map((run): DispatchRun => ({
    $: "DispatchRun", id: githubId(run.id), event: str(run.event), conclusion: str(run.conclusion), title: str(run.display_title),
    created: seconds(run.created_at), updated: seconds(run.updated_at),
  }));
  return observation(policy.release_dispatch(bendList(runs), source, published));
}

export function pullRequest(repo: string, number: number, source: SourcePolicy, read = readGitHub, includeCI = false): PullRequest {
  const policy = source as DeliveryPolicy;
  const name = repository(repo, policy);
  const path = `repos/${name}/pulls/${positiveInt(number)}`;
  const pr = row(read(path));
  if (!policy.pr_identity(githubId(pr.number), String(number), repository(row(row(pr.base).repo).full_name, policy), name)) {
    throw Error("GitHub pull request identity mismatch");
  }
  const opened = seconds(pr.created_at);
  if (!opened) throw Error("Missing GitHub pull request creation time");
  const merged = policy.merged_at(opened, seconds(pr.merged_at), pr.merged === true) || null;
  const commitCount = pr.commits === 0 ? 0 : positiveInt(pr.commits);
  const commits = array(read(path + "/commits?per_page=100"), 100).map((value): Milestone => {
    const commit = row(value);
    return { $: "Milestone", id: sha(commit.sha), at: seconds(row(row(commit.commit).committer).date) };
  });
  const { first: earliestCommit, complete: commitsComplete } = policy.pr_commits(String(commitCount), bendList(commits));
  const reviews = array(read(path + "/reviews?per_page=100"), 100).map((value): Milestone => {
    const review = row(value);
    return { $: "Milestone", id: String(positiveInt(review.id)), at: seconds(review.submitted_at) };
  });
  const { first: earliestReview, complete: reviewsComplete } = policy.pr_reviews(bendList(reviews), opened);
  return {
    repository: name, number, title: policy.source_title(str(pr.title)), opened, merged, mergeSha: merged ? sha(pr.merge_commit_sha) : null,
    state: policy.link_state(merged ? "merged" : str(pr.state)),
    firstCommit: earliestCommit.id ? { sha: earliestCommit.id, at: earliestCommit.at } : null,
    commitsComplete, firstReview: observation(earliestReview), reviewsComplete,
    firstCI: includeCI ? firstPRCI(name, pr, commits.map(({ id }) => id), commitsComplete, opened, merged, policy, read) : null,
    updated: seconds(pr.updated_at),
  };
}

export function releaseEvidence(pr: PullRequest, tag: string, rules: SourcePolicy,
  read = readGitHub, access?: (url: string, size: number) => ReturnType<typeof probe>, includeDispatch = false): ReleaseEvidence {
  const policy = rules as DeliveryPolicy;
  const source = sha(policy.linux_main_source(str(tag)));
  const root = `repos/${pr.repository}`;
  const release = row(read(`${root}/releases/tags/${tag}`));
  if (!policy.same_tag(str(release.tag_name), tag)) throw Error("GitHub release tag mismatch");
  const gitObject = row(row(read(`${root}/git/ref/tags/${tag}`)).object);
  const tagMatches = policy.tag_matches(str(gitObject.type), str(gitObject.sha), source);
  const published = seconds(release.published_at);
  const merge = pr.mergeSha ?? "";
  let ancestry = policy.ancestry_request(merge, source, tagMatches);
  if (ancestry === "compare") {
    const comparison = row(read(`${root}/compare/${merge}...${source}?per_page=1`));
    ancestry = policy.ancestry_result(str(row(comparison.base_commit).sha),
      str(row(comparison.merge_base_commit).sha), merge, str(comparison.status));
  }

  const assets = array(release.assets, 1000).map(row);
  const selected = policy.choose_asset(bendList(assets.map((asset, index): ReleaseAsset => ({
    $: "ReleaseAsset", index: index + 1, state: str(asset.state), name: str(asset.name),
  }))), published, release.draft === false, tagMatches);
  const asset = assets[selected.index - 1];
  let proof = { http: 0, bytes: 0, range: false };
  if (selected.probe) {
    const url = `https://github.com/${pr.repository}/releases/download/${tag}/${encodeURIComponent(str(asset.name))}`;
    const size = positiveInt(asset.size);
    proof = access ? access(url, size) : probe(url, size, policy);
  }
  const checked = Math.floor(Date.now() / 1000);
  const accessible = policy.asset_access(proof.http, proof.bytes, proof.range);
  const shipped = policy.release_shipped(pr.merged ?? 0, published, checked, ancestry, accessible);
  return {
    id: positiveInt(release.id), tag, source, tagMatches, channel: "linux-main-x86_64",
    published: published || null, assetId: asset ? positiveInt(asset.id) : null,
    checked, http: proof.http || null, bytes: proof.http ? proof.bytes : null, accessible, ancestry,
    shipped, dispatch: includeDispatch && shipped ? releaseDispatch(root, source, published, policy, read) : null,
  };
}

export function pollGitHub(database: string, repo: string, policy: SourcePolicy, clocks: ClockPolicy,
  admission: AdmissionPolicy, read = readGitHub, access?: Parameters<typeof releaseEvidence>[4]) {
  const root = `repos/${repo}`;
  const prs = array(read(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=30`), 30).map(row);
  const inventory = row(read(`${root}/actions/runs?per_page=30`));
  const runs = array(inventory.workflow_runs, 30).map(row);
  const releases = array(read(`${root}/releases?per_page=20`), 20).map(row);
  const stored = githubPollRows(database, repo);
  const previousPRs = new Map(stored.prs.map((pr) => [Number(pr.pr_number), pr]));
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
    const previous = previousPRs.get(number);
    if (!policy.poll_pr_needed(updated, Number(previous?.updated_at ?? 0), str(item.title), str(previous?.title))) return;
    const pr = pullRequest(repo, number, policy, read, true);
    loadEvidence(database, { source: "github-delivery", pullRequest: pr }, admission);
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
    loadEvidence(database, { source: "github-actions", attempt: fact }, admission);
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
      loadEvidence(database, { source: "github-delivery", pullRequest: pr, release }, admission);
    }
  });
  return { pullRequestsScanned: prs.length, workflowRunsScanned: runs.length, releasesScanned: releases.length, failed };
}
