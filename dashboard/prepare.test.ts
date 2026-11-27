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
import { dashboards } from "./panels.ts";

async function verifyCompose(initial: string, next: string, traceId: string) {
  const env = { ...process.env, COMPOSE_PROJECT_NAME: `plow-smoke-${process.pid}`, PLOW_PORT: "0" };
  const compose = (...args: string[]) => execFileSync("docker", ["compose", ...args], { env, encoding: "utf8" }).trim();
  const deploy = (snapshot: string, action?: string, image?: string) => execFileSync("dashboard/run.sh",
    action ? [snapshot, action] : [snapshot], {
      env: { ...env, PLOW_GRAFANA_IMAGE: image ?? "" }, stdio: "inherit", timeout: 150_000,
    });
  const readContainer = (service: string, format: string) =>
    execFileSync("docker", ["inspect", "--format", format, compose("ps", "-q", service)], { encoding: "utf8" }).trim();
  const grafanaSnapshot = () => readContainer("grafana",
    '{{range .Mounts}}{{if eq .Destination "/plow/dashboard.sqlite"}}{{.Source}}{{end}}{{end}}');
  const ready = async (version: string, repository: string, pullRequests: number) => {
    const base = `http://${compose("port", "grafana", "3000")}`;
    const read = async (path: string, options?: RequestInit) => {
      const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, path);
      return response.json();
    };
    assert.equal((await read("/api/health")).version, version);
    for (const uid of ["plow", "plow-tempo"]) {
      assert.equal((await read(`/api/datasources/uid/${uid}/health`)).status, "OK");
    }
    const shipping = await read("/api/dashboards/uid/plow-shipping");
    const scope = shipping.dashboard.panels.find(({ id }: { id: number }) => id === 1);
    assert.ok(scope.options.content.includes(repository));
    const coverage = await read("/api/ds/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "now-1h", to: "now", queries: [{
        datasource: { uid: "plow", type: "frser-sqlite-datasource" }, refId: "A",
        queryType: "table", queryText: "SELECT pr_count FROM coverage",
      }] }),
    });
    assert.deepEqual(coverage.results.A.frames[0].data.values, [[pullRequests]]);
    const trace = await read(`/api/datasources/proxy/uid/plow-tempo/api/traces/${traceId}`);
    const body = JSON.stringify(trace);
    assert.ok(body.includes(traceId) || body.includes(Buffer.from(traceId, "hex").toString("base64")));
    assert.ok(body.includes("Git inspection +1"));
  };

  Object.assign(env, { PLOW_SNAPSHOT_DIR: initial, PLOW_GRAFANA_UID: "0", PLOW_GRAFANA_GID: "0" });
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
      const config = JSON.parse(readFileSync(join(out, "dashboards/shipping.json"), "utf8"));
      assert.equal(config.uid, "plow-shipping");
      assert.ok(config.links.some(({ url }: { url: string }) => url.startsWith("/d/plow-changed-code/")));
      const changes = JSON.parse(readFileSync(join(out, "dashboards/changed-code.json"), "utf8"));
      assert.equal(changes.timepicker.hidden, true);
      assert.match(changes.panels[0].options.content, /5 non-merge commits.*synthetic\/example.*aaaaaaaaaaaa/);
      assert.match(changes.panels[0].options.content, /outside the scan limit.*Shallow history/);
      assert.deepEqual(db.prepare(changes.panels[1].targets[0].rawQueryText).all().map(Object.values),
        [["src/frequent.ts", 4], ["Base64: /w==", 2]]);
      assert.equal(JSON.parse(readFileSync(join(out, "dashboards/actions.json"), "utf8")).uid, "plow-actions");
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
      if (process.env.PLOW_COMPOSE_SMOKE === "1") {
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
    assert.ok(!legacyPayload.includes("plow.submitted_command"));
  } finally { rmSync(job, { recursive: true, force: true }); }
});

test("Actions dashboard reads ranked overlap, coverage and exact job steps from the snapshot contract", () => {
  const parent = process.env.PLOW_TEST_DIRECTORY;
  assert.ok(parent, "Set PLOW_TEST_DIRECTORY to a private job directory");
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
    assert.equal(shipping.links[0].url, "/d/plow-actions/actions");
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
