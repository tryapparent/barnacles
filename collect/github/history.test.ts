import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = join(import.meta.dirname, "main.ts");
const base = Date.parse("2026-07-10T18:00:00Z");
const day = 86_400_000;
const iso = (value: number) => new Date(value).toISOString().replace(".000Z", "Z");
const sha = "a".repeat(40);
const merge = "b".repeat(40);
const old = base - 9 * day;
const recent = base - 600_000;
const veryOld = base - 24 * day;
const secret = "fixture-secret";
const unrelated = "Synthetic Private Person";
const repo = "example/demo";

function pr(number: number, updated: number, opened = updated - 1000) {
  const merged = number === 101;
  return { number, body: unrelated, user: { login: secret }, state: merged ? "closed" : "open",
    head: { sha }, base: { repo: { full_name: "Example/Demo" } }, merge_commit_sha: merge,
    created_at: iso(opened), updated_at: iso(updated), merged_at: merged ? iso(updated - 100) : null };
}

function run(runId: number, attempt: number, at: number, status: string, conclusion: string | null) {
  return { id: runId, run_attempt: attempt, head_sha: sha, created_at: iso(at), run_started_at: iso(at + 4000),
    updated_at: iso(at + 50_000), workflow_id: 4, status, conclusion, actor: { login: unrelated }, repository: { id: 40 },
    pull_requests: [{ number: 101, base: { repo: { id: 40 } } }] };
}

function job(runId: number, attempt: number, at: number, status: string, conclusion: string | null) {
  return { id: runId * 100 + attempt, run_id: runId, run_attempt: attempt, head_sha: sha, runner_id: 4,
    name: attempt === 2 ? unrelated : "build", status, conclusion, created_at: iso(at + 6000),
    started_at: iso(at + 9000), completed_at: status === "completed" ? iso(at + 48_000) : null,
    runner_name: unrelated, steps: [{ name: secret }], log_url: "/private/path" };
}

function records(root: string) {
  return readdirSync(root).filter(name => name.endsWith(".jsonl")).flatMap(name =>
    readFileSync(join(root, name), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>));
}

test("normal CLI resumes GitHub history and follows exact attempts independently", { timeout: 180_000 }, async t => {
  const root = mkdtempSync(join(process.env.PLOW_TEST_DIRECTORY ?? "/tmp", "apparent-dev-plow-github-proof-"));
  if (!process.env.PLOW_GITHUB_KEEP_PROOF) t.after(() => rmSync(root, { recursive: true, force: true }));
  const token = join(root, "token");
  writeFileSync(token, secret + "\n", { mode: 0o600 });
  const spool = join(root, "spool");
  const checkpoint = join(root, "state", "checkpoint.json");
  const githubSpool = join(spool, "github"), healthSpool = join(spool, "health");
  const source = Array.from({ length: 101 }, (_, index) => pr(index + 1, veryOld + index * 10_000));
  let phase = 0;
  let requests = 0;
  let limited = false;
  let failTransient = false;
  let inaccessible = true;
  const seen = new Set<string>();
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, "GET");
    const url = new URL(request.url!, "http://" + request.headers.host);
    if (url.pathname.startsWith("/repos/example/other/")) {
      assert.equal(request.headers.authorization, "Bearer other-token");
      response.end(url.pathname.endsWith("/pulls") ? "[]" : '{"total_count":0,"workflow_runs":[]}');
      return;
    }
    assert.equal(request.headers.authorization, "Bearer " + secret);
    assert(url.pathname.startsWith("/repos/" + repo + "/"));
    const path = url.pathname.slice(("/repos/" + repo + "/").length);
    seen.add(path);
    if (limited) {
      response.writeHead(429, { "retry-after": "120" }).end();
      return;
    }
    const send = (data: unknown) => response.end(JSON.stringify(data));
    const replyPage = <T>(items: T[], key?: string) => {
      const page = Number(url.searchParams.get("page"));
      assert.equal(url.searchParams.get("per_page"), "100");
      const last = Math.ceil(items.length / 100);
      if (page < last) {
        const link = (which: number) => new URL(url.pathname + "?" + new URLSearchParams({
          ...Object.fromEntries(url.searchParams), page: String(which),
        }), url.origin).href;
        response.setHeader("link", "<" + link(page + 1) + '>; rel="next", <' + link(last) + '>; rel="last"');
      }
      const data = items.slice((page - 1) * 100, page * 100);
      send(key ? { total_count: items.length, [key]: data } : data);
    };
    if (path === "pulls") {
      const pulls = phase > 0 ? [...source, pr(102, base - 60_000, base - 70_000)] : source;
      replyPage(url.searchParams.get("direction") === "desc" ? pulls.toReversed() : pulls);
      return;
    }
    const all = [
      run(5, phase === 0 ? 1 : 2, recent, phase === 0 ? "in_progress" : "completed", phase === 0 ? null : "failure"),
      run(4, 1, old, "completed", "timed_out"),
      run(2, 1, veryOld, "completed", "success"),
      ...(phase > 0 ? [run(6, 1, base - 120_000, "completed", "success")] : []),
      ...(phase > 1 ? [run(7, 1, base + 500_000, "completed", "success")] : []),
    ];
    if (path === "actions/runs") {
      if (failTransient) { failTransient = false; response.writeHead(503).end(); return; }
      const [lo, hi] = url.searchParams.get("created")!.split("..").map(Date.parse);
      replyPage(all.filter(row => {
        const at = Date.parse(row.created_at);
        return lo <= at && at <= hi;
      }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), "workflow_runs");
      return;
    }
    const exact = /^actions\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?$/.exec(path);
    assert(exact);
    const runId = Number(exact[1]);
    const attempt = Number(exact[2]);
    if (runId === 2 && inaccessible) { response.writeHead(404).end(); return; }
    const latest = all.find(item => item.id === runId)!;
    assert(latest && attempt <= latest.run_attempt);
    const result = attempt < latest.run_attempt ? run(runId, attempt, recent, "completed", "success") : latest;
    if (exact[3]) {
      const entry = job(runId, attempt, Date.parse(result.created_at) + (attempt - 1) * 51_000, result.status, result.conclusion);
      const size = runId === 5 && attempt === 1 ? 101 : 1;
      replyPage(Array.from({ length: size }, (_, index) => ({ ...entry, id: entry.id + 10_000 * index })), "jobs");
    } else {
      send(result);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const prefix = { ...process.env, PLOW_GITHUB_ORIGIN: "http://127.0.0.1:" + address.port,
    PLOW_GITHUB_REPOSITORIES: "fixture=Example/Demo", PLOW_GITHUB_ACTIONS_SINCE: iso(veryOld - day),
    PLOW_GITHUB_STATE: join(root, "state"), PLOW_SPOOL: spool, PLOW_GITHUB_READ_TOKEN_FILE: token,
    PLOW_GITHUB_CREDENTIAL_LAYOUT: "legacy" };
  const cycle = async (at: number, budget: number, overrides = {}) => {
    const source = "Date.now = () => " + at;
    await execute(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(source), cli, "--once"],
      { env: { ...prefix, PLOW_GITHUB_MAX_STEPS: String(budget), ...overrides } });
  };
  const evidence = (kind?: string) => records(githubSpool).filter(row => kind ? row.kind === kind : row.kind !== "github_coverage");
  const state = (repository = repo) => JSON.parse(readFileSync(checkpoint, "utf8")).repositories[repository];
  const healthAt = (at: number) => records(healthSpool).filter(row => row.observedMs === at);
  await cycle(base, 5);
  const first = state();
  assert.equal(first.cursors.pulls_backfill.page, 1);
  assert(!first.cursors.pulls_backfill.done);
  assert.equal(evidence("github_pr").length, 1);
  assert(evidence("github_actions_attempt").some(row => row.runId === "5" && row.status === "in_progress"));
  assert(first.pending["5:1"]);
  assert(healthAt(base).some(row => row.lane === "backfill" && row.status === "working"));

  phase = 1;
  limited = true;
  await cycle(base + 90_000, 50);
  const afterLimit = requests;
  assert(healthAt(base + 90_000).some(row => row.status === "retrying" && row.gapCode === "rate_limited"));
  limited = false;
  await cycle(base + 120_000, 50);
  assert.equal(requests, afterLimit);
  failTransient = true;
  await cycle(base + 240_000, 60);
  const coverage = () => evidence("github_coverage");
  assert(coverage().some(row => row.gapCode === "transient"));
  assert(coverage().some(row => row.lane === "actions_retention" && row.gapCode === "retention_unknown"));
  assert(!healthAt(base + 240_000).some(row => row.lane === "backfill" && row.status === "complete"));
  assert(evidence("github_pr").some(row => row.prNumber === "102"));
  await cycle(base + 300_000, 100);
  assert(coverage().some(row => row.gapCode === "unavailable"));
  assert(!healthAt(base + 300_000).some(row => row.lane === "backfill" && row.status === "complete"));
  inaccessible = false;
  await cycle(base + 360_000, 100);
  const attempts = evidence("github_actions_attempt");
  assert(attempts.some(row => row.runId === "5" && row.attempt === "1" && row.conclusion === "success" &&
    row.completedMs === null && row.lastJobCompletedMs === recent + 48_000));
  assert(attempts.some(row => row.runId === "5" && row.attempt === "2" && row.conclusion === "failure" &&
    row.createdMs === null && row.startedMs === null && row.updatedMs === recent + 50_000));
  assert(attempts.some(row => row.runId === "4" && row.conclusion === "timed_out"));
  assert(attempts.some(row => row.runId === "6" && row.status === "completed"));
  assert(attempts.some(row => row.runId === "2" && row.status === "completed"));
  assert(evidence("github_actions_job").some(row => row.runId === "5" && row.attempt === "2" &&
    row.jobId === "502" && row.startedMs === recent + 60_000 && row.jobName === "Other jobs"));
  assert(evidence("github_pr").some(row => row.prNumber === "101" && row.headSha === sha &&
    row.mergeSha === merge && row.mergedMs === veryOld + 999_900));
  assert(healthAt(base + 360_000).some(row => row.lane === "backfill" && row.status === "complete"));
  assert(coverage().some(row => row.lane === "actions_backfill" && row.status === "window_exhausted"));
  assert(evidence("github_actions_job").some(row => row.jobId === "1000501" && row.status === "completed"));
  assert.equal(state().cursors.actions_live.watermark, Math.floor((base + 360_000) / 1000) - 15);

  const beforeReplay = evidence().map(row => row.eventId).sort();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const batch = readdirSync(githubSpool).find(file => file.endsWith(".jsonl"))!;
  const content = readFileSync(join(githubSpool, batch), "utf8");
  const keys = content.trim().split("\n").map(line => {
    const [revision, ...identity] = JSON.parse(line).eventId.split(":");
    return hash(identity.join(":") + ":" + revision);
  });
  assert.equal(batch, hash(keys.join(":")) + ".jsonl");
  rmSync(join(root, "state", "staged", keys[0]));
  writeFileSync(join(root, "state", "outbox.json"), JSON.stringify({ content, keys }), { mode: 0o600 });

  await cycle(base + 480_000, 100);
  assert.deepEqual(evidence().map(row => row.eventId).sort(), beforeReplay);
  assert.equal(new Set(beforeReplay).size, beforeReplay.length);
  const serialized = JSON.stringify([records(githubSpool), records(healthSpool)]);
  for (const value of [secret, unrelated, "/private/path", root, "log_url", "runner_name", "actor", "pull_requests"]) {
    assert(!serialized.includes(value), value);
  }
  assert(healthAt(base + 480_000).some(row => row.lane === "backfill" && row.status === "complete" &&
    row.eligibleUnits === null && !JSON.stringify(row).includes(repo)));

  const checkpointWithBacklog = JSON.parse(readFileSync(checkpoint, "utf8"));
  const retryAt = (base + 3_600_000) / 1000;
  checkpointWithBacklog.repositories[repo].pending = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => {
    const id = String(index + 1000);
    return [id + ":1", { run: { run: id, attempt: 1, head: sha, created: veryOld / 1000 },
      lanes: ["actions_live", "actions_backfill"], due: retryAt, failures: 1, gap: "unavailable" }];
  }));
  writeFileSync(checkpoint, JSON.stringify(checkpointWithBacklog));
  phase = 2;
  await cycle(base + 550_000, 45);
  assert(seen.has("actions/runs/7/attempts/1/jobs"));
  assert(evidence("github_actions_attempt").some(row => row.runId === "7" && row.conclusion === "success"));
  assert.equal(Object.keys(state().pending).length, 4096);
  assert.equal(state().pending["1000:1"].due, retryAt);

  await assert.rejects(execute(process.execPath, [cli, "--once"], {
    env: { ...prefix, PLOW_GITHUB_REPOSITORIES: "_fixture=example/demo" },
  }), /GitHub collector failed/);
  writeFileSync(join(root, "github-read-fixture"), "unsafe-token", { mode: 0o600 });
  chmodSync(join(root, "github-read-fixture"), 0o644);
  writeFileSync(join(root, "github-read-other"), "other-token", { mode: 0o400 });
  const expanded = { PLOW_GITHUB_CREDENTIAL_LAYOUT: "per-alias", PLOW_GITHUB_CREDENTIAL_DIR: root,
    PLOW_GITHUB_REPOSITORIES: "fixture=example/demo,other=example/other",
    PLOW_GITHUB_ACTIONS_SINCE_BY_ALIAS: JSON.stringify({ other: iso(veryOld - 2 * day) }) };
  const at = base + 700_000;
  await cycle(at, 45, expanded);
  assert.equal(healthAt(at).filter(row => row.scope === "fixture" && row.gapCode === "access_denied").length, 2);
  assert.equal(healthAt(at).filter(row => row.scope === "other" && row.lastSuccessMs === at).length, 2);
  assert.equal(state().floor, (veryOld - day) / 1000);
  assert.equal(state("example/other").floor, (veryOld - 2 * day) / 1000);
  await assert.rejects(cycle(at + 1000, 45, { ...expanded, PLOW_GITHUB_ACTIONS_SINCE_BY_ALIAS: "" }), /GitHub collector failed/);
});
