import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  buildAdmissionPolicy, loadEvidence, type ActionAttempt, type PullRequest, type ReleaseEvidence, type RolloutEvidence, type ThreadEvidence,
} from "../evidence/index.ts";
test("dashboard derives a covered comparison and preserves missing source coverage", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent, "Set PLOW_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "dashboard-test-"));
  try {
    const admission = await buildAdmissionPolicy(job);
    const repo = "synthetic/example";
    const source = join(job, "source.sqlite");
    const saveDelivery = (pullRequest: PullRequest, release?: ReleaseEvidence) =>
      loadEvidence(source, { source: "github-delivery", pullRequest, release }, admission);
    const saveRollout = (rollout: RolloutEvidence) => loadEvidence(source, { source: "codex", rollout }, admission);
    const saveThread = (thread: ThreadEvidence) => loadEvidence(source, { source: "t3", thread }, admission);
    const saveAttempt = (attempt: ActionAttempt) => loadEvidence(source, { source: "github-actions", attempt }, admission);
    const week = 7 * 86400;
    const cutoff = Math.floor(Date.now() / 1000);
    const monday = cutoff - ((cutoff + 3 * 86400) % week);
    for (const [pr, published, cycle] of [
      [1, monday - 2 * week + 7200, 1800],
      [2, monday - week + 7200, 5400],
    ]) {
      const sha = String(pr).repeat(40);
      saveDelivery({
        repository: repo, number: pr, state: "merged", opened: published - 1000,
        merged: published - 500, mergeSha: sha, firstCommit: { sha, at: published - (pr === 1 ? 1500 : 700) },
        firstCI: pr === 1 ? { id: 3, at: published - 980 } : null, firstReview: null,
        commitsComplete: true, reviewsComplete: false, updated: published,
      }, {
        id: pr, tag: `linux-main-v2-${sha}`, source: sha, tagMatches: true, channel: "linux-main-x86_64",
        published, assetId: pr, checked: published + 1, http: 206, bytes: 1,
        accessible: true, ancestry: "equal", shipped: true, dispatch: pr === 1 ? { id: 4, at: published - 200 } : null,
      });
      saveThread({
        instance: "synthetic", id: `thread-${pr}`, created: (published - cycle) * 1000,
        updated: published * 1000, status: "completed", origin: "manual_t3", settled: true, runs: [],
        pullRequests: [{ repository: repo, number: pr, source: "created", state: "merged", owning: true }],
      });
    }
    const at = (cutoff - 1000) * 1000;
    for (const workflowId of [1, 2]) {
      const created = at / 1000;
      const started = created + workflowId;
      saveAttempt({
        repository: repo, runId: workflowId, workflowId, attempt: 1, sha: String(workflowId).repeat(40),
        status: "completed", conclusion: "success", createdAt: created, startedAt: started,
        sourceUpdated: started + 10, observedAt: started + 12, jobs: [{
          id: workflowId, label: "Build", status: "completed", conclusion: "success", created,
          priorExecution: false, queueEnd: started, executionStart: started, executionEnd: started + 10, steps: [{
            number: 1, label: "Compile", status: "completed", conclusion: "success", start: started + 2, end: started + 5,
          }],
        }],
      });
    }
    const pointSession = "point-only\b\f\\u0008😀";
    saveRollout({
      instance: "local", session: pointSession, lines: 5, malformed: 0, orphans: 0,
      calls: [], markers: [{ line: 3, at }],
    });
    saveRollout({
      instance: "local", session: "test-session", lines: 12, malformed: 0, orphans: 0,
      calls: [
        { id: "launch", line: 2, tool: "Shell command", command: "git status", start: at, end: at + 100,
          async: true, asyncEnd: at + 600, terminalCall: "wait", ambiguous: false, categories: "Git inspection + File inspection" },
        { id: "wait", line: 4, tool: "Cell wait", command: null, start: at + 500, end: at + 600,
          async: false, asyncEnd: null, terminalCall: null, ambiguous: false },
        { id: "later", line: 7, tool: "Shell command", command: null, start: at + 750, end: at + 800,
          async: false, asyncEnd: null, terminalCall: null, ambiguous: false, categories: "Git inspection" },
        { id: "pending", line: 8, tool: "Tool script", command: null, start: at + 760, end: null,
          async: false, asyncEnd: null, terminalCall: null, ambiguous: false },
      ], markers: [{ line: 6, at: at + 650, resultCall: "wait" }, { line: 10, at: at + 850, resultCall: "later" }],
    });
    saveRollout({
      instance: "local", session: "other-project-rollout", lines: 10, malformed: 0, orphans: 0,
      calls: [{ id: "launch", line: 2, tool: "Tool script", command: null, start: at + 800, end: at + 900,
        async: true, asyncEnd: null, terminalCall: null, ambiguous: false },
      ...Array.from({ length: 6 }, (_, index) => {
        const file_count = 1 + index % 3;
        const seconds = 5 + file_count * 2;
        const start = at + 1000 + index * 20000;
        return { id: "mix-" + index, line: index + 3, tool: "Shell command", command: null,
          start, end: start + seconds * 1000, async: false, asyncEnd: null, terminalCall: null, ambiguous: false,
          categories: "File inspection + Rust build",
          mix: { $: "Mix" as const, file_count, git_count: 0, build_count: 1, push_count: 0, seconds } };
      })],
      markers: [],
    });
    loadEvidence(source, { source: "git-change-scan", repository: repo, report: {
      revision: "a".repeat(40), commitsScanned: 5, hasMoreCommits: true, shallow: true,
      files: [{ path: "src/frequent.ts", commits: 4 }, { pathBytesBase64: "/w==", commits: 2 }],
    } }, admission);
    loadEvidence(source, { source: "git-change-scan", repository: "synthetic/other", report: {
      revision: "b".repeat(40), commitsScanned: 5, hasMoreCommits: false, shallow: false,
      files: [{ path: "other.ts", commits: 5 }],
    } }, admission);
    const out = join(job, "out");
    assert.throws(() => execFileSync(process.execPath,
      ["dashboard/prepare.ts", join(job, "missing.sqlite"), out, repo], { stdio: "pipe" }), /existing evidence SQLite/);
    assert.equal(existsSync(out), false);
    const prepare = (output: string, repository: string) =>
      execFileSync(process.execPath, ["dashboard/prepare.ts", source, output, repository, new Date(cutoff * 1000).toISOString()],
        { stdio: "pipe", timeout: 120_000 });
    const buildStarted = Date.now();
    prepare(out, repo);
    assert.equal(existsSync(join(out, "dashboards")), false);
    const manifest = JSON.parse(readFileSync(join(out, "snapshot.json"), "utf8"));
    assert.equal(manifest.formatVersion, 1);
    assert.match(manifest.generation, /^[0-9a-f-]{36}$/);
    assert.ok(Date.parse(manifest.createdAt) >= buildStarted);
    assert.equal(manifest.coverage.to, cutoff);
    assert.equal(manifest.coverage.timingCutoffMs, cutoff * 1000);
    assert.deepEqual([manifest.coverage.pullRequests, manifest.coverage.shipped, manifest.coverage.linked], [2, 2, 2]);
    const validate = ["dashboard/prepare.ts", "--validate", out];
    execFileSync(process.execPath, validate, { stdio: "pipe" });
    writeFileSync(join(out, "snapshot.json"), JSON.stringify({ ...manifest, formatVersion: 2 }));
    assert.throws(() => execFileSync(process.execPath, validate, { stdio: "pipe" }), /Unsupported snapshot format/);
    writeFileSync(join(out, "snapshot.json"), JSON.stringify(manifest));
    const db = new DatabaseSync(join(out, "dashboard.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(Object.values(db.prepare("SELECT revision, commits_scanned, truncated, shallow FROM changed_code_scan").get()!),
        ["a".repeat(40), 5, 1, 1]);
      assert.deepEqual(db.prepare("SELECT path, path_base64, commits FROM changed_files ORDER BY rank").all().map(Object.values),
        [["src/frequent.ts", null, 4], [null, "/w==", 2]]);
      const summary = db.prepare("SELECT shipped, linked, direction, delta_seconds FROM coverage").get();
      assert.deepEqual(Object.values(summary!), [2, 2, "Gardening", 3600]);
      assert.deepEqual(db.prepare("SELECT mean_seconds, observed, missing FROM delivery_stages ORDER BY ordinal").all().map(Object.values),
        [[2500, 2, 0], [500, 1, 1], [20, 1, 1], [480, 1, 1], [300, 1, 1], [200, 1, 1],
          [500, 2, 0], [500, 2, 0], [3600, 2, 0]]);
      assert.deepEqual(db.prepare("SELECT name, elapsed_seconds FROM delivery_milestones WHERE pr=2 ORDER BY ordinal").all().map(Object.values),
        [["Thread started", null], ["First commit", 4700], ["PR opened", null], ["First PR CI", null],
          ["PR merged", null], ["Release dispatch", null], ["Shipped", null], ["Access verified", null]]);
      const overview = db.prepare(`SELECT operation, count, mean_seconds, total_seconds, unmeasured, has_area
        FROM operation_totals WHERE window='24h' AND clock=? ORDER BY rank`);
      assert.deepEqual(overview.all("CI execution").map(Object.values), [["Build", 2, 10, 20, 0, 1]]);
      assert.deepEqual(db.prepare(`SELECT workflow FROM workflows WHERE window='24h' AND clock='CI execution' ORDER BY rank`).all().map(Object.values),
        [[1], [2]]);
      assert.deepEqual(overview.all("CI queue").map(Object.values), [["Build", 2, 1.5, 3, 0, 1]]);
      assert.deepEqual(overview.all("CI steps").map(Object.values), [["Compile", 2, 3, 6, 0, 1]]);
      assert.deepEqual(db.prepare(`SELECT clock, total_seconds, union_seconds FROM clock_totals
        WHERE window='1h' AND clock LIKE 'CI %' ORDER BY clock`).all().map(Object.values),
        [["CI execution", 20, 11], ["CI queue", 3, 2], ["CI steps", 6, 4]]);
      assert.deepEqual(overview.all("Async cells").map(Object.values),
        [["Mixed", 1, 0.6, 0.6, 0, 1], ["Unknown", 0, null, null, 1, 0]]);
      const toolOverview = overview.all("Tool envelopes");
      assert.equal(toolOverview[0].operation, "Mixed");
      assert.equal(toolOverview[0].count, 7);
      const mixed = db.prepare("SELECT operation, count, total_seconds FROM mixed_groups WHERE window='24h' AND clock=? ORDER BY rank");
      assert.deepEqual(mixed.all("Tool envelopes").map(Object.values),
        [["Mixed · File inspection + Rust build", 6, 54], ["Mixed · Git inspection + File inspection", 1, 0.1]]);
      assert.deepEqual(mixed.all("Async cells").map(Object.values), [["Mixed · Git inspection + File inspection", 1, 0.6]]);
      assert.deepEqual(Object.values(toolOverview.find(({ operation }) => operation === "Git inspection")!),
        ["Git inspection", 1, 0.05, 0.05, 0, 1]);
      assert.equal(db.prepare("SELECT count(*) AS n FROM operation_totals WHERE operation='Estimated model wait'").get()?.n, 0);
      assert.deepEqual(db.prepare(`SELECT source, first_ms, latest_ms, receipt_ms, position FROM source_bounds
        WHERE window='1h' ORDER BY ordinal`).all().map(Object.values), [
        ["Codex", at, at + 112000, null, "Ends in window"],
        ["Actions", at, at + 12000, at + 14000, "Ends in window"],
        ["T3", (monday - 2 * week + 5400) * 1000, (monday - week + 7200) * 1000, null, "Before window"],
        ["Releases", (monday - 2 * week + 7200) * 1000, (monday - week + 7200) * 1000,
          (monday - week + 7201) * 1000, "Before window"],
      ]);
      const estimated = db.prepare("SELECT seconds, total, samples FROM category_estimates WHERE name=?");
      assert.deepEqual(Object.values(estimated.get("File inspection")!), [2, 24, 6]);
      assert.deepEqual(Object.values(estimated.get("Rust build")!), [null, null, 0]);
      assert.equal(db.prepare("SELECT count FROM timing WHERE window='24h' AND clock='Tool envelopes' AND operation='Mixed'").get()?.count, 7);
      assert.equal(db.prepare("SELECT count(*) AS n FROM trace WHERE ended IS NULL").get()?.n, 2);
      assert.deepEqual(db.prepare("SELECT started, ended, measured FROM trace_windows ORDER BY session").all().map(Object.values),
        [[at, at + 850, 4], [at + 800, at + 112000, 7], [at, at, 0]]);
      assert.deepEqual(db.prepare("SELECT kind, observed, missing FROM trace_coverage ORDER BY session, ordinal").all().map(Object.values),
        [["Tool envelopes", 3, 1], ["Async cells", 1, 0], ["Reasoning events", 2, null],
          ["Tool envelopes", 7, 0], ["Async cells", 0, 1], ["Reasoning events", 0, null],
          ["Tool envelopes", 0, 0], ["Async cells", 0, 0], ["Reasoning events", 1, null]]);
      assert.deepEqual(db.prepare("SELECT source_line, observed FROM trace_reasoning ORDER BY session").all().map(Object.values),
        [[6, at + 650], [10, at + 850], [3, at]]);
      const otlp = readFileSync(join(out, "tempo.ndjson"), "utf8");
      assert.ok(!otlp.includes("test-session"));
      const [full, envelopeOnly, eventOnly] = otlp.trim().split("\n").map((line) => JSON.parse(line).resourceSpans[0].scopeSpans[0].spans);
      assert.equal(full.length, 6);
      assert.ok(!JSON.stringify(full).includes("Tool script"));
      assert.equal(envelopeOnly.length, 8);
      const [window, ...spans] = full;
      assert.equal(window.traceId, "695719703bc0fad47217c2cd16ef4ff6");
      assert.equal(window.spanId, "39e4bba7420737a5");
      assert.equal(Object.hasOwn(window, "parentSpanId"), false);
      const estimates = spans.filter((span: { name: string }) => span.name === "Estimated model wait");
      assert.equal(estimates.length, 1);
      assert.equal(estimates[0].spanId, "e8edc28e125acea2");
      assert.equal(estimates[0].parentSpanId, window.spanId);
      assert.equal(estimates[0].startTimeUnixNano, ((BigInt(at) + 600n) * 1_000_000n).toString());
      assert.equal(estimates[0].endTimeUnixNano, ((BigInt(at) + 650n) * 1_000_000n).toString());
      const cell = spans.find((span: { name: string }) => span.name === "Async cell · Git inspection +1");
      const launch = spans.find((span: { name: string }) => span.name === "Git inspection +1");
      assert.equal(window.traceId, db.prepare("SELECT trace_id FROM trace_windows WHERE session=1").get()?.trace_id);
      assert.equal(cell.spanId, "f1580dc4d6ea1977");
      assert.equal(cell.parentSpanId, window.spanId);
      assert.equal(launch.parentSpanId, cell.spanId);
      assert.ok(launch.attributes.some(({ key, value }: { key: string; value: { stringValue?: string } }) =>
        key === "plow.categories" && value.stringValue === "Git inspection + File inspection"));
      assert.ok(launch.attributes.some(({ key, value }: { key: string; value: { stringValue?: string } }) =>
        key === "plow.submitted_command" && value.stringValue === "git status"));
      assert.equal(spans.find((span: { name: string }) => span.name === "Cell wait").parentSpanId, cell.spanId);
      assert.equal(window.events[0].timeUnixNano, ((BigInt(at) + 650n) * 1_000_000n).toString());
      assert.equal(eventOnly.length, 1);
      const pointKey = JSON.stringify(["local", pointSession]);
      const traceId = createHash("sha256").update(JSON.stringify(["barnacles-codex-trace", pointKey])).digest("hex").slice(0, 32);
      assert.equal(eventOnly[0].traceId, traceId);
      assert.equal(eventOnly[0].startTimeUnixNano, eventOnly[0].endTimeUnixNano);
    } finally { db.close(); }

    const report = JSON.parse(execFileSync(process.execPath, ["evidence/report-actions.ts", source, repo],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }));
    assert.deepEqual(report.filter(({ clock }: { clock: string }) => clock === "CI queue"), [
      { workflow_id: 2, clock: "CI queue", operation: "Build", count: 1, mean_seconds: 2, total_seconds: 2, unmeasured_count: 0 },
      { workflow_id: 1, clock: "CI queue", operation: "Build", count: 1, mean_seconds: 1, total_seconds: 1, unmeasured_count: 0 },
    ]);

    const legacy = new DatabaseSync(source);
    try {
      legacy.exec("DROP TABLE codex_reasoning_inputs; DROP TABLE codex_commands");
    } finally { legacy.close(); }
    const legacyOut = join(job, "legacy");
    execFileSync(process.execPath, ["dashboard/prepare.ts", source, legacyOut, repo], { stdio: "pipe", timeout: 60_000 });
    const legacyPayload = readFileSync(join(legacyOut, "tempo.ndjson"), "utf8");
    const legacyTrace = JSON.parse(legacyPayload.split("\n")[0]).resourceSpans[0].scopeSpans[0].spans;
    assert.equal(legacyTrace[0].events.length, 2);
    assert.equal(legacyTrace.length, 5);
    assert.ok(!legacyPayload.includes("Estimated model wait"));
    assert.ok(!legacyPayload.includes("plow.submitted_command"));
  } finally { rmSync(job, { recursive: true, force: true }); }
});

test("timing windows clip spans, count overlap once and preserve unknown clocks", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent, "Set PLOW_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "dashboard-window-test-"));
  try {
    const admission = await buildAdmissionPolicy(job);
    const source = join(job, "source.sqlite");
    const out = join(job, "out");
    const upper = Date.parse("2025-02-03T12:00:00Z");
    const lower = upper - 3_600_000;
    const day = upper - 86_400_000;
    const spans: [string, number | null, number | null][] = [
      ["Build", upper - 2_000, upper + 1_000],
      ["Git", lower - 5_000, lower + 8_000],
      ["Build", lower, lower + 20_000],
      ["Build", lower + 3_000, lower + 6_000],
      ["Build", lower - 1_000, lower],
      ["Build", lower, lower],
      ["Build", upper, upper],
      ["Build", day - 10_000, day + 10_000],
      ["Build", lower - 5_000, null],
      ["Build", lower + 1_000, null],
      ["Build", null, lower + 4_000],
      ["Build", lower + 15_000, lower + 14_000],
      ["Build", null, null],
    ];
    for (const [index, [categories, start, end]] of spans.entries()) {
      loadEvidence(source, { source: "codex", rollout: {
        instance: "local", session: `synthetic-${index}`, lines: 2, malformed: 0, orphans: 0, markers: [],
        calls: [{ id: "operation", line: 2, tool: "Shell command", start, end, categories,
          async: false, asyncEnd: null, terminalCall: null, ambiguous: false }],
      } }, admission);
    }
    const jobStart = day / 1000 + 1;
    const steps = Array.from({ length: 20_000 }, (_, index) => {
      const start = jobStart + (index * 177) % 10_000;
      return { number: index + 1, label: "Compile", status: "completed", conclusion: "success", start, end: start + 1 };
    });
    loadEvidence(source, { source: "github-actions", attempt: {
      repository: "synthetic/example", runId: 1, workflowId: 1, attempt: 1, sha: "a".repeat(40),
      status: "completed", conclusion: "success", createdAt: jobStart, startedAt: jobStart,
      sourceUpdated: jobStart + 10_000, observedAt: jobStart + 10_001, jobs: [{
        id: 1, label: "Build", status: "completed", conclusion: "success", created: jobStart,
        priorExecution: false, queueEnd: jobStart, executionStart: jobStart, executionEnd: jobStart + 10_000, steps,
      }],
    } }, admission);
    execFileSync(process.execPath, ["dashboard/prepare.ts", source, out, "synthetic/example",
      new Date(upper).toISOString()], { stdio: "pipe", timeout: 120_000 });
    const db = new DatabaseSync(join(out, "dashboard.sqlite"), { readOnly: true });
    try {
      assert.deepEqual(db.prepare("SELECT * FROM timing_windows ORDER BY started_ms DESC").all().map(Object.values),
        [["1h", lower, upper], ["24h", day, upper]]);
      const clock = db.prepare(`SELECT window, count, total_seconds, union_seconds, unmeasured, unplaced
        FROM clock_totals WHERE clock=? ORDER BY window`);
      assert.deepEqual(clock.all("Tool envelopes").map(Object.values), [
        ["1h", 5, 33, 22, 3, 1],
        ["24h", 7, 49, 37, 4, 1],
      ]);
      assert.deepEqual(clock.all("CI steps").map(Object.values), [
        ["1h", 0, null, null, 0, 0],
        ["24h", 20_000, 20_000, 10_000, 0, 0],
      ]);
      const ranked = db.prepare(`SELECT operation, total_seconds, union_seconds, count, mean_seconds
        FROM operation_totals WHERE window=? AND clock='Tool envelopes' ORDER BY rank`);
      assert.deepEqual(ranked.all("1h").map(Object.values), [["Build", 25, 22, 4, 6.25], ["Git", 8, 8, 1, 8]]);
      assert.deepEqual(ranked.all("24h").map(Object.values), [["Build", 36, 33, 6, 6], ["Git", 13, 13, 1, 13]]);
      assert.equal(db.prepare("SELECT position FROM source_bounds WHERE source='Actions' AND window='1h'").get()?.position,
        "Before window");
    } finally { db.close(); }
  } finally { rmSync(job, { recursive: true, force: true }); }
});

test("timing names waits from confirmed process receipts and keeps unresolved time", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent, "Set PLOW_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "dashboard-waits-test-"));
  const cutoff = "2025-02-03T12:00:00Z";
  const began = Date.parse(cutoff) - 120000;
  const waits = [
    ["ci-wait", "Cell wait", 1],
    ["ci-poll", "Process I/O", 2],
    ["git-wait", "Cell wait", 3],
    ["git-launch", "Git push", 2],
    ["build-poll", "Process I/O", 4],
    ["ambiguous-poll", "Process I/O", 5],
    ["ambiguous-wait", "Cell wait", 6],
    ["legacy-wait", "Cell wait", 7],
    ["mixed-wait", "Cell wait", 8],
    ["mixed-poll", "Process I/O", 9],
  ] as const;
  const receipt = (call: string, status: string, category: string): NonNullable<RolloutEvidence["waitAttribution"]>["observations"][number] => ({
    call, resultCall: call, resultLine: 30, handle: "1", start: null, end: null, observer: { $: "NoWatch" },
    fact: { $: "ProcessFact", status, owner: call, category, watch: { $: "NoWatch" },
      receipt: { $: "ExitReceipt", seconds: 1, code: 0 } },
  });
  try {
    const admission = await buildAdmissionPolicy(job);
    const source = join(job, "source.sqlite");
    const out = join(job, "out");
    const batch: { source: "codex"; rollout: RolloutEvidence } = { source: "codex", rollout: {
      instance: "test-instance", session: "test-session", lines: 30, malformed: 0, orphans: 0, markers: [],
      calls: waits.map(([id, categories, duration], index) => ({
        id, tool: categories, categories, command: null, line: index + 1,
        start: began + index * 10000, end: began + index * 10000 + duration * 1000,
        async: false, asyncEnd: null, terminalCall: null, ambiguous: false,
      })),
      waitAttribution: {
        waits: [
          { call: "ci-wait", cell: "ci", status: "linked_cell", owner: "ci-poll" },
          { call: "git-wait", cell: "git", status: "linked_cell", owner: "git-launch" },
          { call: "ambiguous-wait", cell: "git", status: "ambiguous_cell", owner: "git-launch" },
          { call: "mixed-wait", cell: "mixed", status: "linked_cell", owner: "mixed-poll" },
        ],
        observations: [
          receipt("ci-poll", "process_running", "Exact GitHub watcher request"),
          receipt("git-launch", "process_opened", "Git push"),
          receipt("build-poll", "process_exited", "Rust build"),
          receipt("ambiguous-poll", "ambiguous_process_handle", "Rust build"),
          receipt("mixed-poll", "process_running", "File inspection + Rust build"),
        ],
      },
    } };
    loadEvidence(source, batch, admission);
    loadEvidence(source, batch, admission);
    execFileSync(process.execPath, ["dashboard/prepare.ts", source, out, "synthetic/example", cutoff],
      { stdio: "pipe", timeout: 120_000 });
    const db = new DatabaseSync(join(out, "dashboard.sqlite"), { readOnly: true });
    try {
      const groups = db.prepare(`SELECT operation, count, total_seconds FROM operation_totals
        WHERE window='24h' AND clock='Tool envelopes' ORDER BY rank`).all().map(Object.values);
      assert.deepEqual(groups, [
        ["Waiting for an unidentified task", 3, 21],
        ["Unidentified process", 2, 14],
        ["Rust build · process I/O", 1, 4],
        ["Waiting for Git push", 1, 3],
        ["Git push", 1, 2],
        ["GitHub Actions · process I/O", 1, 2],
        ["Waiting for GitHub Actions", 1, 1],
      ]);
      assert.deepEqual(db.prepare(`SELECT count, total_seconds FROM clock_totals
        WHERE window='24h' AND clock='Tool envelopes'`).all().map(Object.values), [[10, 47]]);
      assert.equal(db.prepare("SELECT count(*) AS n FROM trace WHERE operation='Cell wait'").get()?.n, 5);
    } finally { db.close(); }
  } finally { rmSync(job, { recursive: true, force: true }); }
});

test("a snapshot preserves bound process spans and incomplete clocks", async () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent, "Set PLOW_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "process-captures-"));
  const source = join(job, "evidence.sqlite");
  const snapshot = join(job, "snapshot");
  const at = Math.floor(Date.now() / 1000) - 60;
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  try {
    const admission = await buildAdmissionPolicy(job);
    const calls = [0, 1, 2].map((number) => ({
      id: `capture-${number}`, line: number + 2, tool: "Shell command", command: null, start: (at + number) * 1000,
      end: null, async: false, asyncEnd: null, terminalCall: null, ambiguous: number === 2,
    }));
    loadEvidence(source, { source: "codex", rollout: {
      instance: "fixture", session: "session", lines: 4, malformed: 0, orphans: 0, calls, markers: [],
    } }, admission);
    const events = [
      "ready", "root 1000000 100", "exec 1001000 100 bash", "fork 1002000 100 101",
      "exec 1003000 101 cargo", "fork 1004000 101 102", "exec 1005000 102 private-name",
      "exit 1105000 102", "exit 1203000 101", "exec 1305000 100 git", "exit 1400000 100",
    ];
    const capture = async (number: number, log = "") => {
      const binding = join(job, "binding.json");
      const input = join(job, "events");
      const diagnostics = join(job, "observer.log");
      const content = [...(number === 1 ? events.slice(0, -1) : events), "done", ""].join("\n");
      writeFileSync(input, content);
      writeFileSync(diagnostics, log);
      writeFileSync(binding, JSON.stringify({
        instance: "fixture", session: "session", call: `capture-${number}`, line: number + 2,
        startedAt: iso(at + number), eventsSha256: createHash("sha256").update(content).digest("hex"),
      }));
      return promisify(execFile)(process.execPath, ["collector/import-sources.ts", job, "process", binding, input, diagnostics]);
    };
    await assert.rejects(capture(2), /binding does not match/);
    await assert.rejects(capture(0, "lost events"), /Invalid or oversized kernel event capture/);
    await capture(0);
    await capture(0);
    await capture(1);
    await promisify(execFile)(process.execPath, ["dashboard/prepare.ts", source, snapshot, "synthetic/example"]);
    const db = new DatabaseSync(join(snapshot, "dashboard.sqlite"), { readOnly: true });
    try {
      const captures = db.prepare("SELECT trace_json FROM process_timings ORDER BY position").all()
        .map((row) => JSON.parse(String(row.trace_json)));
      assert.equal(captures.length, 2);
      assert.deepEqual(captures.map((entry: { durationMicros: number | null; unfinished: number }) =>
        [entry.durationMicros, entry.unfinished]), [[null, 1], [400, 0]]);
      assert.deepEqual(captures[1].spans.map((span: { start: number; elapsed: number; parent: number; name: string }) =>
        [span.start, span.elapsed, span.parent, span.name]),
        [[1, 304, 1, "Bash"], [3, 200, 2, "Cargo"], [5, 100, 3, "Unidentified executable"], [305, 95, 1, "Git"]]);
      assert.doesNotMatch(JSON.stringify(captures), /private-name|capture-0|session|eventsSha256/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});
