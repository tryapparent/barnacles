import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  buildAdmissionPolicy, loadEvidence, type ActionAttempt, type PullRequest, type ReleaseEvidence, type RolloutEvidence, type ThreadEvidence,
} from "../evidence/index.ts";
import { dashboards } from "./panels.ts";

async function verifyCompose(initial: string, next: string, traceId: string) {
  const env = { ...process.env, COMPOSE_PROJECT_NAME: `barnacles-smoke-${process.pid}`, BARNACLES_PORT: "0" };
  const compose = (...args: string[]) => execFileSync("docker", ["compose", ...args], { env, encoding: "utf8" }).trim();
  const deploy = (snapshot: string, action?: string, image?: string) => execFileSync("dashboard/run.sh",
    action ? [snapshot, action] : [snapshot], {
      env: { ...env, BARNACLES_GRAFANA_IMAGE: image ?? "" }, stdio: "inherit", timeout: 150_000,
    });
  const readContainer = (service: string, format: string) =>
    execFileSync("docker", ["inspect", "--format", format, compose("ps", "-q", service)], { encoding: "utf8" }).trim();
  const grafanaSnapshot = () => readContainer("grafana",
    '{{range .Mounts}}{{if eq .Destination "/barnacles/dashboard.sqlite"}}{{.Source}}{{end}}{{end}}');
  const ready = async (version: string, repository: string, pullRequests: number) => {
    const base = `http://${compose("port", "grafana", "3000")}`;
    const read = async (path: string, options?: RequestInit) => {
      const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, path);
      return response.json();
    };
    assert.equal((await read("/api/health")).version, version);
    for (const uid of ["barnacles", "barnacles-tempo"]) {
      assert.equal((await read(`/api/datasources/uid/${uid}/health`)).status, "OK");
    }
    const shipping = await read("/api/dashboards/uid/barnacles-shipping");
    const scope = shipping.dashboard.panels.find(({ id }: { id: number }) => id === 1);
    assert.ok(scope.options.content.includes(repository));
    const coverage = await read("/api/ds/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "now-1h", to: "now", queries: [{
        datasource: { uid: "barnacles", type: "frser-sqlite-datasource" }, refId: "A",
        queryType: "table", queryText: "SELECT pr_count FROM coverage",
      }] }),
    });
    assert.deepEqual(coverage.results.A.frames[0].data.values, [[pullRequests]]);
    const trace = await read(`/api/datasources/proxy/uid/barnacles-tempo/api/traces/${traceId}`);
    const body = JSON.stringify(trace);
    assert.ok(body.includes(traceId) || body.includes(Buffer.from(traceId, "hex").toString("base64")));
    assert.ok(body.includes("Git inspection +1"));
  };

  Object.assign(env, { BARNACLES_SNAPSHOT_DIR: initial, BARNACLES_GRAFANA_UID: "0", BARNACLES_GRAFANA_GID: "0" });
  try {
    deploy(initial, "config");
    deploy(initial);
    await ready("12.3.0", "synthetic/example", 2);
    const tempo = compose("ps", "-q", "tempo");
    assert.equal(grafanaSnapshot(), join(initial, "dashboard.sqlite"));
    const upgraded = "grafana/grafana:12.3.1@sha256:2175aaa91c96733d86d31cf270d5310b278654b03f5718c59de12a865380a31f";
    deploy(initial, "grafana", upgraded);
    assert.equal(compose("ps", "-q", "tempo"), tempo);
    assert.equal(grafanaSnapshot(), join(initial, "dashboard.sqlite"));
    await ready("12.3.1", "synthetic/example", 2);
    deploy(initial, "grafana");
    assert.equal(compose("ps", "-q", "tempo"), tempo);
    await ready("12.3.0", "synthetic/example", 2);
    const image = readContainer("grafana", "{{.Image}}");
    assert.throws(() => deploy(next, "grafana"));
    assert.equal(compose("ps", "-q", "tempo"), tempo);
    assert.equal(grafanaSnapshot(), join(initial, "dashboard.sqlite"));
    deploy(next);
    await ready("12.3.0", "synthetic/other", 0);
    assert.equal(grafanaSnapshot(), join(next, "dashboard.sqlite"));
    assert.equal(readContainer("grafana", "{{.Image}}"), image);
    deploy(initial);
    await ready("12.3.0", "synthetic/example", 2);
  } catch (error) {
    console.error(compose("logs", "--no-color", "--tail", "30"));
    throw error;
  } finally {
    deploy(initial, "down");
  }
}

test("dashboard derives a covered comparison and preserves missing source coverage", async () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
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
        key === "barnacles.categories" && value.stringValue === "Git inspection + File inspection"));
      assert.ok(launch.attributes.some(({ key, value }: { key: string; value: { stringValue?: string } }) =>
        key === "barnacles.submitted_command" && value.stringValue === "git status"));
      assert.equal(spans.find((span: { name: string }) => span.name === "Cell wait").parentSpanId, cell.spanId);
      assert.equal(window.events[0].timeUnixNano, ((BigInt(at) + 650n) * 1_000_000n).toString());
      assert.equal(eventOnly.length, 1);
      const pointKey = JSON.stringify(["local", pointSession]);
      const traceId = createHash("sha256").update(JSON.stringify(["barnacles-codex-trace", pointKey])).digest("hex").slice(0, 32);
      assert.equal(eventOnly[0].traceId, traceId);
      assert.equal(eventOnly[0].startTimeUnixNano, eventOnly[0].endTimeUnixNano);
      const config = JSON.parse(readFileSync(join(out, "dashboards/shipping.json"), "utf8"));
      assert.equal(config.uid, "barnacles-shipping");
      assert.ok(config.links.some(({ url }: { url: string }) => url.startsWith("/d/barnacles-changed-code/")));
      const changes = JSON.parse(readFileSync(join(out, "dashboards/changed-code.json"), "utf8"));
      assert.equal(changes.timepicker.hidden, true);
      assert.match(changes.panels[0].options.content, /5 non-merge commits.*synthetic\/example.*aaaaaaaaaaaa/);
      assert.match(changes.panels[0].options.content, /outside the scan limit.*Shallow history/);
      assert.deepEqual(db.prepare(changes.panels[1].targets[0].rawQueryText).all().map(Object.values),
        [["src/frequent.ts", 4], ["Base64: /w==", 2]]);
      assert.equal(JSON.parse(readFileSync(join(out, "dashboards/actions.json"), "utf8")).uid, "barnacles-actions");
      const scope = config.panels.find(({ title }: { title: string }) => title === "Evidence scope").options.content;
      assert.match(scope, /synthetic\/example/);
      assert.match(scope, /all 3 imported rollouts across projects/);
      assert.equal(config.timepicker.hidden, true);
      const treemap = config.panels.find(({ type }: { type: string }) => type === "marcusolsson-treemap-panel");
      const ranked = config.panels.find(({ id }: { id: number }) => id === 10);
      assert.equal(treemap.options.textField, "Name");
      for (const panel of [treemap, ranked]) {
        const query = panel.targets[0].rawQueryText.replace("${operation_clock:sqlstring}", "'CI execution'")
          .replaceAll("${overview_operation:sqlstring}", "'All operations'").replaceAll("${window:sqlstring}", "'24h'");
        assert.equal(db.prepare(query).get()?.Name, "Build");
      }
      const timingBoard = JSON.parse(readFileSync(join(out, "dashboards/timing.json"), "utf8"));
      assert.equal(timingBoard.timepicker.hidden, true);
      const details = timingBoard.panels.find(({ id }: { id: number }) => id === 3);
      const drilldown = (clock: string, workflow: string, operation: string) => {
        const query = details.targets[0].rawQueryText.replaceAll("${clock:sqlstring}", `'${clock}'`)
          .replaceAll("${workflow:sqlstring}", `'${workflow}'`).replaceAll("${operation:sqlstring}", `'${operation}'`)
          .replaceAll("${window:sqlstring}", "'24h'");
        return db.prepare(query).all().map(({ Operation }) => Operation);
      };
      const groups = ["Mixed · File inspection + Rust build", "Mixed · Git inspection + File inspection"];
      assert.deepEqual(drilldown("Tool envelopes", "*", "Mixed"), groups);
      assert.deepEqual(drilldown("Tool envelopes", "0", "Mixed"), groups);
      assert.deepEqual(drilldown("Tool envelopes", "2", "Mixed"), []);
      assert.deepEqual(drilldown("Tool envelopes", "0", groups[1]), [groups[1]]);
      assert.deepEqual(drilldown("Tool envelopes", "*", "All operations"), ["Mixed", "Unknown", "Git inspection"]);
      assert.deepEqual(drilldown("CI execution", "2", "*"), ["Build"]);
      const trace = JSON.parse(readFileSync(join(out, "dashboards/trace.json"), "utf8"));
      assert.ok(trace.panels.some(({ type }: { type: string }) => type === "traces"));
      assert.equal(trace.templating.list[0].current.value, "1");
      assert.equal(trace.templating.list[1].current.value, window.traceId);
      if (process.env.BARNACLES_COMPOSE_SMOKE === "1") {
        const next = join(job, "next");
        prepare(next, "synthetic/other");
        assert.notEqual(JSON.parse(readFileSync(join(next, "snapshot.json"), "utf8")).generation, manifest.generation);
        await verifyCompose(out, next, window.traceId);
      }
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
    assert.ok(!legacyPayload.includes("barnacles.submitted_command"));
  } finally { rmSync(job, { recursive: true, force: true }); }
});

test("Actions dashboard reads ranked overlap, coverage and exact job steps from the snapshot contract", () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "actions-dashboard-test-"));
  const db = new DatabaseSync(join(job, "dashboard.sqlite"));
  try {
    db.exec(`
      CREATE TABLE actions_wait_coverage (
        window_start_ms INTEGER, window_end_ms INTEGER,
        wait_count INTEGER, exact_wait_count INTEGER, matched_wait_count INTEGER,
        matched_attempts INTEGER, unmatched_attempts INTEGER, jobless_attempts INTEGER,
        matched_wait_ms INTEGER, running_ms INTEGER, queue_only_ms INTEGER, unknown_job_ms INTEGER, wait_source_present INTEGER
      );
      CREATE TABLE actions_wait_jobs (
        job_label TEXT, job_count INTEGER, execution_ms INTEGER, only_known_running_ms INTEGER,
        queue_ms INTEGER, rank INTEGER
      );
      CREATE TABLE actions_wait_job_instances (
        repository TEXT, run_id INTEGER, head_sha TEXT, attempt INTEGER, job_id INTEGER, job_label TEXT,
        execution_ms INTEGER, only_known_running_ms INTEGER, queue_ms INTEGER
      );
      CREATE TABLE actions_wait_steps (
        run_id INTEGER, attempt INTEGER, job_id INTEGER, step_number INTEGER, step_label TEXT, execution_ms INTEGER
      );
      INSERT INTO actions_wait_coverage VALUES
        (1767225600123, 1767312000456, 12, 10, 8, 3, 1, 1, 300000, 210000, 15000, 75000, 1);
      INSERT INTO actions_wait_jobs VALUES
        ('Package', 1, 180000, 120000, 10000, 2),
        ('Build & ''verify'' / x64', 2, 200000, 120000, 5000, 1),
        ('Pending job', 1, NULL, NULL, 0, 3);
      INSERT INTO actions_wait_job_instances VALUES
        ('synthetic/example', 4201, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2, 2001, 'Build & ''verify'' / x64', 80000, 50000, 5000),
        ('synthetic/example', 4201, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 2002, 'Build & ''verify'' / x64', 120000, 70000, 0),
        ('synthetic/example', 4202, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 2003, 'Package', 180000, 120000, 10000),
        ('synthetic/example', 4202, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 2004, 'Pending job', NULL, NULL, 0),
        ('other/example', 9999, 'cccccccccccccccccccccccccccccccccccccccc', 1, 9999, 'Build & ''verify'' / x64', 45000, 0, 0);
      INSERT INTO actions_wait_steps VALUES
        (4201, 1, 2002, 1, 'First attempt only', 75000),
        (4201, 2, 2001, 2, 'Compile sources', 75000),
        (4201, 2, 2001, 1, 'Set up toolchain', 5000),
        (4202, 1, 2003, 1, 'Package output', 180000);
    `);
    const { actions, shipping } = dashboards({ from: 0, to: 0, rolloutCount: 0, timingCutoff: 0, traceSessions: 0 },
      "synthetic/example");
    assert.equal(shipping.links[0].url, "/d/barnacles-actions/actions");
    assert.equal(actions.timepicker.hidden, true);
    const query = (id: number, family = "*", instance = "*") => {
      const panel = actions.panels.find((panel) => "id" in panel && panel.id === id);
      assert.ok(panel && "targets" in panel);
      const sql = (panel.targets as { rawQueryText: string }[])[0].rawQueryText
        .replaceAll("${job_family:sqlstring}", `'${family.replaceAll("'", "''")}'`)
        .replaceAll("${job_instance:sqlstring}", `'${instance.replaceAll("'", "''")}'`);
      return db.prepare(sql).all().map(Object.values);
    };
    assert.deepEqual(query(2), [["Start", "2026-01-01 00:00:00.123"], ["End", "2026-01-02 00:00:00.456"], ["Source", "Watcher evidence available"]]);
    assert.deepEqual(query(3), [
      ["Build & 'verify' / x64", 2, 200000, 120000, 5000],
      ["Package", 1, 180000, 120000, 10000], ["Pending job", 1, null, null, 0],
    ]);
    assert.deepEqual(query(4).map((row) => row[1]), [12, 10, 8, 3, 1, 1]);
    assert.deepEqual(query(5).map((row) => row[1]), [300000, 210000, 15000, 75000]);
    assert.deepEqual(query(6, ":Build & 'verify' / x64").map((row) => [row[0], row[2], row[3], row.at(-1)]),
      [["2001", 2, "4201", "4201/2/2001"], ["2002", 1, "4201", "4201/1/2002"]]);
    assert.deepEqual(query(7, "*", "4201/2/2001"), [[1, "Set up toolchain", 5000], [2, "Compile sources", 75000]]);
    assert.deepEqual(query(7), []);
    db.exec("DELETE FROM actions_wait_jobs; DELETE FROM actions_wait_job_instances; DELETE FROM actions_wait_steps;");
    for (const id of [3, 6, 7]) assert.deepEqual(query(id), []);
    db.exec("UPDATE actions_wait_coverage SET wait_source_present = 0");
    assert.deepEqual(query(2).at(-1), ["Source", "Reimport Codex rollouts"]);
  } finally {
    db.close();
    rmSync(job, { recursive: true, force: true });
  }
});

test("timing windows clip spans, count overlap once and preserve unknown clocks", async () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
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
      const config = JSON.parse(readFileSync(join(out, "dashboards/shipping.json"), "utf8"));
      const ranked = config.panels.find(({ id }: { id: number }) => id === 10);
      const rows = (window: string) => db.prepare(ranked.targets[0].rawQueryText
        .replaceAll("${window:sqlstring}", window)
        .replaceAll("${operation_clock:sqlstring}", "'Tool envelopes'")
        .replaceAll("${overview_operation:sqlstring}", "'All operations'")).all().map(Object.values);
      assert.deepEqual(rows("'1h'"), [["Build", 25, 22, 4, 6.25], ["Git", 8, 8, 1, 8]]);
      assert.deepEqual(rows("'24h'"), [["Build", 36, 33, 6, 6], ["Git", 13, 13, 1, 13]]);
      assert.equal(db.prepare("SELECT position FROM source_bounds WHERE source='Actions' AND window='1h'").get()?.position,
        "Before window");
    } finally { db.close(); }
  } finally { rmSync(job, { recursive: true, force: true }); }
});

test("timing names waits from confirmed process receipts and keeps unresolved time", async () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
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

test("shipping API preserves historical and partial evidence and reads a replacement snapshot", async () => {
  const parent = process.env.BARNACLES_TEST_DIRECTORY;
  assert.ok(parent, "Set BARNACLES_TEST_DIRECTORY to a private job directory");
  const job = mkdtempSync(join(parent, "review-api-"));
  const source = join(job, "evidence.sqlite");
  const snapshot = join(job, "snapshot");
  const replacement = join(job, "replacement");
  const settings = join(job, "poll-interval");
  const repo = "synthetic/harbor";
  const at = Math.floor(Date.now() / 1000) - 60;
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  const cutoff = at + 60;
  const time = (seconds: number) => encodeURIComponent(iso(seconds));
  const prepare = (path: string) => promisify(execFile)(process.execPath,
    ["dashboard/prepare.ts", source, path, repo, iso(cutoff).replace(".000Z", "Z")], { timeout: 120_000 });
  let server: ReturnType<typeof spawn> | undefined;
  let stopped: Promise<unknown> | undefined;
  try {
    const admission = await buildAdmissionPolicy(job);
    const save = (pullRequest: PullRequest, release?: ReleaseEvidence) =>
      loadEvidence(source, { source: "github-delivery", pullRequest, release }, admission);
    const shipped: PullRequest = {
      repository: repo, number: 101, title: "Publish the updated dashboard", state: "merged",
      opened: at - 800, merged: at - 600, mergeSha: "a".repeat(40),
      firstCommit: { sha: "b".repeat(40), at: at - 900 }, firstCI: { id: 11, at: at - 750 },
      firstReview: null, commitsComplete: true, reviewsComplete: false, updated: at - 600,
    };
    const proof: ReleaseEvidence = {
      id: 21, tag: "synthetic-release", source: shipped.mergeSha!, tagMatches: true, channel: "linux-main-x86_64",
      published: at - 400, assetId: 13, checked: at - 300, http: 206, bytes: 32,
      accessible: true, ancestry: "equal", shipped: true, dispatch: { id: 12, at: at - 500 },
    };
    const open: PullRequest = { ...shipped, number: 202, title: "Improve the snapshot filters", state: "open", opened: at - 100,
      merged: null, mergeSha: null, firstCommit: null, firstCI: null, updated: at - 100 };
    save(shipped, proof);
    save(shipped, { ...proof, channel: "other-surface", id: 22, tag: "other-surface-release" });
    save(open);
    loadEvidence(source, { source: "t3", thread: {
      instance: "synthetic", id: "owner-101", title: "Review delivery timing", created: (at - 1000) * 1000, updated: at * 1000,
      status: "completed", origin: "manual_t3", settled: true, runs: [],
      pullRequests: [{ repository: repo, number: 101, source: "created", state: "merged", owning: true }],
    } }, admission);
    const hour = Math.floor(cutoff / 3600) * 3600000;
    const operations = [
      ["Cell wait", hour - 7200000, 30000], ["Cell wait", hour - 3600000, 20000],
      ["Rust build", hour - 3600000, 15000], ["Git inspection", hour - 3600000, 9000],
      ["Git push", hour - 3600000, 4000], ["Browser", hour - 3600000, 2000],
      ["File inspection + Rust build", hour - 3600000, 1000], ["Unknown", hour - 3600000, null],
    ] as const;
    const batch = { source: "codex" as const, rollout: {
      instance: "synthetic", session: "review-map", lines: operations.length, malformed: 0, orphans: 0, markers: [],
      calls: operations.map(([categories, start, elapsed], index) => ({
        id: `map-${index}`, tool: "exec_command", categories, command: null, line: index + 1,
        start, end: elapsed === null ? null : start + elapsed,
        async: false, asyncEnd: null, terminalCall: null, ambiguous: false,
      })),
    } };
    loadEvidence(source, batch, admission);
    loadEvidence(source, batch, admission);
    for (const [workflowId, label, seconds] of [[41, "Build", 30], [41, "Test", 20], [42, "Build", 10]] as const) {
      const runId = workflowId * 100 + seconds;
      const start = hour / 1000 - 3600;
      loadEvidence(source, { source: "github-actions", attempt: {
        repository: repo, sha: "a".repeat(40), runId, attempt: 1, workflowId, status: "completed", conclusion: "success",
        createdAt: start - 2, startedAt: start, sourceUpdated: start + seconds, observedAt: start + seconds,
        jobs: [{ id: 1, label, status: "completed", conclusion: "success", created: start - 2,
          priorExecution: false, queueEnd: start, executionStart: start, executionEnd: start + seconds,
          steps: [{ number: 1, label: "Run checks", status: "completed", conclusion: "success",
            start, end: start + seconds }] }],
      } }, admission);
    }
    const changes = [{ path: "src/routes/main.ts", commits: 4 }, { pathBytesBase64: "/w==", commits: 2 }];
    loadEvidence(source, { source: "git-change-scan", repository: repo,
      report: { revision: "a".repeat(40), commitsScanned: 5, hasMoreCommits: true, shallow: true, files: changes.slice(0, 1) },
      inventory: changes }, admission);
    await prepare(snapshot);
    const db = new DatabaseSync(join(snapshot, "dashboard.sqlite"), { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT window_end_ms FROM actions_wait_coverage").get()?.window_end_ms, cutoff * 1000);
    } finally { db.close(); }
    const web = process.env.BARNACLES_WEB_BUILD;
    const proxyUser = "owner@example.invalid";
    server = spawn(process.execPath, ["dashboard/prepare.ts", "--serve", snapshot, "0", ...(web ? [web] : [])], {
      env: { ...process.env, BARNACLES_PROXY_HOST: "harbor.example.invalid:8443", BARNACLES_PROXY_USER: proxyUser,
        BARNACLES_POLL_SETTINGS: settings },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr?.resume();
    stopped = once(server, "exit");
    const [announcement] = await once(server.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
    const base = /http:\/\/127\.0\.0\.1:\d+/.exec(String(announcement))?.[0];
    assert.ok(base);
    const call = (route: string, init?: RequestInit) => fetch(base + route, {
      signal: AbortSignal.timeout(10_000), headers: { "Tailscale-User-Login": proxyUser }, ...init,
    });
    assert.equal((await call("/", { headers: {} })).status, 403);
    assert.equal((await call("/api/v1", { headers: { "Tailscale-User-Login": "guest@example.invalid" } })).status, 403);
    const get = async (route: string, expected = 200) => {
      const result = await call(route);
      assert.equal(result.status, expected, route);
      assert.equal(result.headers.get("cache-control"), "no-store");
      return result.json();
    };

    if (web) {
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
    const discovery = await get("/api/v1");
    const { endpoints } = discovery;
    assert.equal(endpoints.shipping.path, "/api/v1/shipping");
    assert.deepEqual(await get(endpoints.changedCode.path), { repository: repo,
      scan: { revision: "a".repeat(40), commitsScanned: 5, hasMoreCommits: true, shallow: true, files: changes } });
    assert.equal(endpoints.processTimings.path, "/api/v1/process-timings");
    assert.deepEqual(await get(endpoints.processTimings.path), { captures: [] });
    assert.equal(endpoints.sessionHistory.path, "/api/v1/sessions");
    assert.deepEqual(await get(endpoints.sessionHistory.path), { study: null, sessions: [], trace: null });
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
    const importStudy = () => execFileSync(process.execPath, ["dashboard/prepare.ts", "--session-study", snapshot, studyFile, replayFile],
      { stdio: ["ignore", "pipe", "pipe"] });
    importStudy();
    const observed = await get(endpoints.sessionHistory.path);
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
    assert.throws(importStudy);
    assert.deepEqual(await get(endpoints.sessionHistory.path), observed);
    const settingsPath = discovery.pollingSettings;
    assert.equal(settingsPath, "/settings/polling");
    assert.deepEqual(await get(settingsPath), { minutes: 15 });
    const update = (value: string, origin: string, user = proxyUser) => new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(base + settingsPath + "?" + new URLSearchParams({ minutes: value }), {
        method: "PUT", headers: { Host: "harbor.example.invalid:8443", "Tailscale-User-Login": user, Origin: origin },
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.once("error", reject).setTimeout(10_000, () => req.destroy(Error("Polling settings request timed out"))).end();
    });
    const origin = "https://harbor.example.invalid:8443";
    assert.equal(await update("5", "https://other.example.invalid"), 403);
    assert.equal(await update("5", origin, "guest@example.invalid"), 403);
    assert.equal(await update("0", origin), 400);
    assert.deepEqual(await get(settingsPath), { minutes: 15 });
    assert.equal(await update("5", origin), 200);
    assert.equal(readFileSync(settings, "utf8"), "5\n");
    assert.deepEqual(await get(settingsPath), { minutes: 5 });
    const report = await get("/api/v1/shipping?limit=1");
    assert.equal(report.snapshotAt, iso(cutoff));
    assert.deepEqual(report.snapshotCoverage, { observedPullRequests: 2, verifiedShipments: 1, attributedShipments: 1 });
    assert.equal(report.shipments.weekly[0].meanCycleSeconds, 600);
    assert.equal(report.shipments.meanCycleSeconds, 600);
    assert.equal(report.shipments.attributed, 1);
    const publicationDay = iso(proof.published).slice(0, 10) + "T00:00:00.000Z";
    assert.deepEqual(report.shipments.dailyStages, [{
      startsAt: publicationDay, verified: 1,
      stages: [
        { phase: "pre-commit", measured: 1, meanSeconds: 100 },
        { phase: "pr-opened", measured: 1, meanSeconds: 100 },
        { phase: "first-ci", measured: 1, meanSeconds: 50 },
        { phase: "merged", measured: 1, meanSeconds: 150 },
        { phase: "dispatched", measured: 1, meanSeconds: 100 },
        { phase: "published", measured: 1, meanSeconds: 100 },
        { phase: "access-verified", measured: 1, meanSeconds: 100 },
      ],
    }]);
    assert.deepEqual(report.fleet.items.map((item: { number: number; stage: string }) => [item.number, item.stage]),
      [[202, "pr-opened"], [101, "access-verified"]]);
    assert.equal(report.deliveries.items[0].title, open.title);
    assert.equal(report.deliveries.nextOffset, 1);
    assert.equal(report.deliveries.maxMeasuredMillis, 700_000);
    assert.deepEqual(report.deliveries.timeline, { from: iso(at - 1000), to: iso(at - 100) });
    assert.equal(report.operations.mapKind, "categories");
    const tiles = report.operations.map;
    assert.deepEqual(tiles.map(({ label, totalSeconds, grouped }: { label: string; totalSeconds: number; grouped: number }) =>
      [label, totalSeconds, grouped]), [["Waiting", 50, 0], ["Rust build", 15, 0],
      ["Git inspection", 9, 0], ["Other", 7, 3]]);
    assert.deepEqual(tiles[0].children.map(({ label, totalSeconds }: { label: string; totalSeconds: number }) =>
      [label, totalSeconds]), [["Waiting for an unidentified task", 50]]);
    assert.equal(tiles[0].children[0].children.length, 0);
    assert.deepEqual(tiles[3].children.map(({ label }: { label: string }) => label), ["Git push", "Browser", "Mixed"]);
    assert.equal(tiles[3].children[2].children[0].label, "File inspection + Rust build");
    assert.equal(report.operations.items.find(({ operation }: { operation: string }) => operation === "Unknown").unmeasuredSpans, 1);
    const selectedMap = (await get("/api/v1/shipping?operation=Waiting%20for%20an%20unidentified%20task")).operations.map;
    assert.deepEqual(selectedMap, [tiles[0]]);
    assert.deepEqual((await get("/api/v1/shipping?clock=Async%20cells")).operations.map, []);
    for (const query of ["clock=CI%20execution", "clock=CI%20steps&operation=Run%20checks"]) {
      const [ci] = (await get("/api/v1/shipping?" + query)).operations.map;
      assert.equal(ci.label, "CI");
      assert.equal(ci.totalSeconds, 60);
      assert.deepEqual(ci.children.map((workflow: { label: string; totalSeconds: number; children: { label: string }[] }) =>
        [workflow.label, workflow.totalSeconds, workflow.children.map(({ label }) => label)]),
        [["Workflow 41", 50, ["Build", "Test"]], ["Workflow 42", 10, ["Build"]]]);
    }
    const [filteredCi] = (await get("/api/v1/shipping?clock=CI%20execution&operation=Test")).operations.map;
    assert.equal(filteredCi.totalSeconds, 20);
    assert.deepEqual(filteredCi.children[0].children.map(({ label }: { label: string }) => label), ["Test"]);
    assert.equal(report.operations.window, "24h");
    const page = await get("/api/v1/shipping?limit=1&offset=1");
    assert.deepEqual(page.shipments.dailyStages, report.shipments.dailyStages);
    assert.deepEqual(page.shipments.dailyChart, report.shipments.dailyChart);
    assert.equal(page.deliveries.nextOffset, null);
    assert.equal(page.deliveries.maxMeasuredMillis, report.deliveries.maxMeasuredMillis);
    assert.deepEqual(page.deliveries.timeline, report.deliveries.timeline);
    assert.equal(page.deliveries.items[0].title, "Review delivery timing");
    const detail = await get(page.deliveries.items[0].detailPath);
    assert.equal(detail.title, "Review delivery timing");
    assert.equal(detail.milestones[0].observedAt, iso(at - 1000));
    assert.equal(detail.milestones[3].provenance.url, "https://github.com/synthetic/harbor/actions/runs/11");
    assert.equal(detail.milestones[7].elapsedMillis, 100_000);

    const historical = await get("/api/v1/shipping?to=" + time(at - 399));
    assert.equal(historical.shipments.verified, 0);
    assert.equal(historical.shipments.meanCycleSeconds, null);
    assert.deepEqual(historical.shipments.weekly, []);
    assert.deepEqual(historical.shipments.dailyStages, []);
    assert.deepEqual(historical.shipments.dailyChart.days, []);
    assert.equal(historical.fleet.items[0].stage, "published");
    assert.equal(historical.deliveries.items[0].milestones[7].observedAt, null);
    assert.deepEqual(historical.deliveries.timeline, { from: iso(at - 1000), to: iso(at - 400) });
    assert.equal((await get("/api/v1/pull-requests/202?asOf=" + time(at - 399), 404)).error.code,
      "pull_request_not_observed");
    const partial = await get("/api/v1/pull-requests/202");
    assert.deepEqual(partial.milestones[0], {
      key: "thread-started", phase: "pre-commit", observedAt: null, elapsedMillis: null, provenance: null,
    });
    assert.equal(partial.milestones[2].elapsedMillis, null);
    assert.deepEqual((await get("/api/v1/shipping?to=" + time(at - 1001))).fleet.items, []);
    assert.equal((await get("/api/v1/shipping?from=2026-02-30", 400)).error.code, "invalid_request");
    assert.equal((await get("/api/v1/shipping?limit=0", 400)).error.code, "invalid_page");
    assert.equal((await get("/api/v1/shipping?clock=estimate", 400)).error.code, "invalid_clock");
    assert.equal((await get("/api/v1/shipping?from=1970-01-01", 400)).error.code, "invalid_window");
    assert.equal((await call("/api/v1/shipping", { method: "POST" })).status, 405);

    save({ ...open, state: "merged", merged: at - 50, mergeSha: "c".repeat(40), updated: at - 50 });
    const partialShipment = { ...shipped, number: 303, firstCommit: null, firstCI: null };
    save(partialShipment, { ...proof, checked: proof.published, dispatch: null });
    save({ ...partialShipment, number: 404, opened: shipped.opened - 86400, merged: shipped.merged! - 86400 },
      { ...proof, id: 23, tag: "previous-day-release", published: proof.published - 86400, checked: proof.checked - 86400,
        dispatch: null });
    const chartStart = Date.parse(iso(cutoff).slice(0, 10)) / 1000 - 30 * 86400;
    const olderRelease = chartStart - 1;
    save({ ...partialShipment, number: 505, opened: olderRelease - 300, merged: olderRelease - 100 },
      { ...proof, id: 24, tag: "older-release", published: olderRelease, checked: olderRelease + 50, dispatch: null });
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
    await prepare(replacement);
    renameSync(join(replacement, "dashboard.sqlite"), join(snapshot, "dashboard.sqlite"));
    const { captures } = await get(endpoints.processTimings.path);
    assert.equal(captures.length, 2);
    assert.deepEqual(captures.map((entry: { durationMicros: number | null; unfinished: number }) =>
      [entry.durationMicros, entry.unfinished]), [[null, 1], [400, 0]]);
    assert.deepEqual(captures[1].spans.map((span: { start: number; elapsed: number; parent: number; name: string }) =>
      [span.start, span.elapsed, span.parent, span.name]),
      [[1, 304, 1, "Bash"], [3, 200, 2, "Cargo"], [5, 100, 3, "Unidentified executable"], [305, 95, 1, "Git"]]);
    assert.doesNotMatch(JSON.stringify(captures), /private-name|capture-0|session|eventsSha256/);
    const refreshed = await get("/api/v1/pull-requests/202");
    assert.equal(refreshed.stage, "merged");
    assert.equal(refreshed.milestones[4].observedAt, iso(at - 50));
    assert.equal(refreshed.milestones[4].elapsedMillis, null);
    const { shipments } = await get("/api/v1/shipping");
    assert.equal(shipments.verified, 3);
    assert.deepEqual(shipments.dailyStages.map(({ startsAt, verified }: { startsAt: string; verified: number }) =>
      [startsAt, verified]), [[publicationDay, 2], [iso(Date.parse(publicationDay) / 1000 - 86400), 1]]);
    assert.deepEqual(shipments.dailyStages[0].stages[0], { phase: "pre-commit", measured: 1, meanSeconds: 100 });
    assert.deepEqual(shipments.dailyStages[0].stages.at(-1), { phase: "access-verified", measured: 2, meanSeconds: 50 });
    assert.deepEqual(shipments.dailyStages[1].stages[0], { phase: "pre-commit", measured: 0, meanSeconds: null });
    assert.deepEqual(shipments.dailyChart.days, shipments.dailyStages);
    const wide = await get("/api/v1/shipping?from=" + time(olderRelease));
    assert.equal(wide.shipments.verified, 4);
    assert.equal(wide.shipments.dailyStages.length, 3);
    assert.deepEqual(wide.shipments.dailyChart, { from: iso(chartStart), days: shipments.dailyStages });
  } finally {
    server?.kill();
    if (stopped) await stopped;
    rmSync(job, { recursive: true, force: true });
  }
});
