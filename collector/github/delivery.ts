import type { PullRequest, ReleaseEvidence } from "../../evidence/source-records.ts";
import { execFileSync } from "node:child_process";
import type { SourcePolicy } from "../../evidence/source-policy.ts";
import { array, repository, row, seconds, sha, str } from "../wire.ts";
import { positiveInt, readGitHub } from "./attempt.ts";

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

export function pullRequest(repo: string, number: number, policy: SourcePolicy, read = readGitHub): PullRequest {
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
  const commitsComplete = commits.length === commitCount;
  const commitTimes = commits.map((value) => {
    const commit = row(value);
    return { sha: sha(commit.sha), at: seconds(row(row(commit.commit).committer).date) };
  }).sort((a, b) => a.at - b.at);
  const firstCommit = commitsComplete && commitTimes[0]?.at ? commitTimes[0] : null;
  const reviews = array(read(path + "/reviews?per_page=100"), 100);
  const firstReview = reviews.map((value) => {
    const review = row(value);
    return { id: positiveInt(review.id), at: seconds(review.submitted_at) };
  }).filter(({ at }) => policy.pr_milestone(opened, at)).sort((a, b) => a.at - b.at)[0] ?? null;
  return {
    repository: name, number, opened, merged, mergeSha: merged ? sha(pr.merge_commit_sha) : null,
    state: policy.link_state(merged ? "merged" : str(pr.state)),
    firstCommit, commitsComplete, firstReview, reviewsComplete: reviews.length < 100,
    updated: seconds(pr.updated_at),
  };
}

export function releaseEvidence(pr: PullRequest, tag: string, policy: SourcePolicy,
  read = readGitHub, access = probe): ReleaseEvidence {
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
  return {
    id: positiveInt(release.id), tag, source, tagMatches, channel: "linux-main-x86_64",
    published: published || null, assetId: asset ? positiveInt(asset.id) : null,
    checked, http: proof.http || null, bytes: proof.http ? proof.bytes : null, accessible, ancestry,
    shipped: policy.shipping(pr.merged ?? 0, published, checked,
      ancestry === "equal" || ancestry === "ancestor", accessible),
  };
}
