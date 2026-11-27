import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

type Call = (route: string, init?: RequestInit) => Promise<Response>;

export async function verifyHarborWeb(call: Call) {
  const page = await call("/");
  assert.equal(page.status, 200);
  assert.equal((await call("/changed-code")).status, 200);
  assert.equal((await call("/sessions")).status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const script = (await page.text()).match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(script);
  const bundle = await call(script);
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type") ?? "", /text\/javascript/);
  await bundle.arrayBuffer();
  assert.equal((await call("/dashboard.sqlite")).status, 404);
}

export async function verifySessionStudy(job: string, snapshot: string, cutoff: number, path: string, call: Call,
  get: (route: string, expected?: number) => ReturnType<Response["json"]>) {
  assert.equal(path, "/api/v1/sessions");
  assert.deepEqual(await get(path), { study: null, sessions: [], trace: null });
  assert.equal((await call("/api/v1/sessions", { headers: {} })).status, 403);
  const studyFile = join(job, "waterfall.json");
  const replayFile = join(job, "replay.json");
  const t3 = "t3-thread://v2/11111111-1111-1111-1111-111111111111/";
  const syntheticId = "mcp:launch:" + "a".repeat(64);
  const sourceJob = "https://github.com/synthetic/example/actions/runs/8/job/9";
  const start = cutoff * 1000 - 12000;
  const eventRows = [
    [6, 2000, 5000, "Linux", sourceJob, "completed", "linked", false],
    [1, 1250, null, "Run", "internal-receipt", "running", "linked", false],
    [1, 12, 500, "First run", "T3 position 4", "completed", "linked", false],
    [10, 7000, 7000, "Commit", "https://not-github.example.invalid/commit/1", "", "worktree", false],
    [7, 5000, 12001, "Out of bounds", "", "", "linked", false],
    [7, 7000, 6000, "Reversed", "", "", "linked", false],
  ];
  writeFileSync(studyFile, JSON.stringify({ cutoff: cutoff * 1000, threads: [
    { i: 1, title: "Prior thread", link: t3 + "22222222-2222-2222-2222-222222222222",
      start: start - 1000, cutoff: 13000, rollouts: 0,
      events: Array.from({ length: 40000 }, (_, index) =>
        [8, 12000 - (index % 12000), 12001 - (index % 12000), "Step", "", "", "linked", false]) },
    { i: 2, title: "Recorded thread", link: "[Recorded thread](" + t3 + syntheticId + ")",
      start, cutoff: 12000, rollouts: 1, events: eventRows },
  ] }));
  const signal = { rule: "ci-queue", thread: "sample-2", id: "8:1:9", seconds: 3, median: 1, peers: 5 };
  writeFileSync(replayFile, JSON.stringify({ findings: [
    signal, { ...signal, id: "8:1:900" }, { ...signal, thread: "sample-1" }, { ...signal, rule: "ci-execution" },
  ] }));
  const importStudy = () => run(process.execPath, ["dashboard/prepare.ts", "--session-study", snapshot, studyFile, replayFile]);
  await importStudy();
  const observed = await get(path);
  assert.deepEqual(observed.study, { cutoff: cutoff * 1000, replay: true });
  assert.deepEqual(observed.sessions.map((entry: { thread: { title: string }; count: number; signals: number }) =>
    [entry.thread.title, entry.count, entry.signals]), [["Recorded thread", 4, 1], ["Prior thread", 40000, 0]]);
  const id = observed.sessions[0].thread.id;
  const sessionDetail = await get("/api/v1/sessions?session=" + id);
  assert.equal(sessionDetail.trace.entry.thread.source, t3 + syntheticId);
  assert.equal(sessionDetail.trace.entry.end, 7000);
  assert.deepEqual(sessionDetail.trace.lanes[1].events.map((event: { index: number }) => event.index), [2, 1]);
  assert.deepEqual(sessionDetail.trace.lanes[1].events[1].end, { $: "None" });
  assert.equal(sessionDetail.trace.lanes[1].events[1].source, "");
  assert.equal(sessionDetail.trace.lanes[10].events[0].source, "");
  assert.equal(sessionDetail.trace.lanes[6].events[0].source, sourceJob);
  assert.deepEqual(sessionDetail.trace.signals[0].event, { $: "Some", value: 0 });
  assert.equal((await get("/api/v1/sessions?session=" + "e".repeat(64), 404)).error.code, "session_not_observed");
  await get("/api/v1/sessions?session=one&session=two", 400);
  writeFileSync(studyFile, JSON.stringify({ cutoff: cutoff * 1000, threads: [{}] }));
  await assert.rejects(importStudy);
  assert.deepEqual(await get(path), observed);
}
