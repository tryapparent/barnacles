const datasource = { uid: "barnacles", type: "frser-sqlite-datasource" };
const tempo = { uid: "barnacles-tempo", type: "tempo" };
const yellow = "#F2B826";
const green = "#4DAE79";
const ink = "#D3D8D2";
const timingPath = "/d/barnacles-timing/timing";
const tracePath = "/d/barnacles-trace/trace";
const changedCodePath = "/d/barnacles-changed-code/changed-code-analysis";
const shippingPath = "/d/barnacles-shipping/shipping";
const actionsPath = "/d/barnacles-actions/actions";

type Window = { from: number; to: number };
type ChangeScan = { revision: string; commitsScanned: number; truncated: boolean; shallow: boolean; hasPaths: boolean };
type Range = Window & { timingCutoff: number; rolloutCount: number; traceSessions: number; changedCode?: ChangeScan;
  defaultTrace?: Window & { session: number; traceId: string } };
type FieldProperty = { id: string; value: unknown };
type Override = { matcher: { id: string; options: string }; properties: FieldProperty[] };

const byName = (name: string, ...properties: FieldProperty[]): Override =>
  ({ matcher: { id: "byName", options: name }, properties });
const unit = (value: string) => ({ id: "unit", value });
const width = (value: number) => ({ id: "custom.width", value });
const link = (title: string, url: string) => ({ title, url });
const links = (...value: ReturnType<typeof link>[]) => ({ id: "links", value });
const prLinks = [
  byName("PR", width(72), links(link("Open the GitHub pull request", '${__data.fields["URL"]}'))),
  byName("URL", { id: "custom.hidden", value: true }),
];
const reduceOptions = { values: false, calcs: ["lastNotNull"] };

function data(id: number, type: string, title: string, grid: number[], query: string,
  options: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}, overrides: Override[] = [],
  timeColumns: string[] = [], description?: string) {
  const [x, y, w, h] = grid;
  return {
    id, type, title, description, gridPos: { x, y, w, h }, datasource,
    targets: [{ datasource, refId: "A", queryType: "table", rawQueryText: query, queryText: query, timeColumns }],
    options, fieldConfig: { defaults, overrides },
  };
}

function chart(id: number, title: string, grid: number[], fields: string, color: string, timeUnit: string,
  description: string) {
  return data(id, "timeseries", title, grid,
    `SELECT week AS time, ${fields} FROM weeks ORDER BY time`,
    { legend: { showLegend: false }, tooltip: { mode: "single" } },
    { unit: timeUnit, color: { mode: "fixed", fixedColor: color },
      custom: { drawStyle: "points", showPoints: "always", pointSize: 7, spanNulls: false, axisSoftMin: 0 } },
    [], ["time"], description);
}

function block(id: number, title: string, grid: number[], content: string) {
  const [x, y, w, h] = grid;
  return { id, type: "text", title, gridPos: { x, y, w, h }, options: { mode: "markdown", content } };
}

function board(uid: string, title: string, from: string, to: string, panels: object[],
  navigation: ReturnType<typeof link>[], variables: object[] = []) {
  return {
    uid, title, schemaVersion: 40, version: 1, editable: false, timezone: "utc", time: { from, to },
    panels, templating: { list: variables }, links: navigation.map((item) => ({ ...item, type: "link" })),
  };
}

function variable(name: string, label: string, query: string, value: string) {
  return { type: "query", name, label, datasource, query, definition: query, refresh: 1,
    current: { selected: true, text: value, value }, options: [] };
}

function scanSummary(repo: string, scan: ChangeScan) {
  const unit = scan.commitsScanned === 1 ? "commit" : "commits";
  const scope = `Scanned **${scan.commitsScanned.toLocaleString("en-US")} non-merge ${unit}** in \`${repo}\` at \`${scan.revision.slice(0, 12)}\`.`;
  const limitations = [
    scan.truncated ? "More commits are outside the scan limit." : "",
    scan.shallow ? "Shallow history. File changes at the checkout boundary are unavailable." : "",
  ].filter(Boolean);
  return [scope, limitations.join(" ")].filter(Boolean).join("\n\n");
}

function actionsDashboard(from: string, to: string, repository: string) {
  const family = "${job_family:sqlstring}";
  const job = "${job_instance:sqlstring}";
  const jobKey = "run_id || '/' || attempt || '/' || job_id";
  const instances = `FROM actions_wait_job_instances
    WHERE repository = '${repository}' AND (${family} = '*' OR ':' || job_label = ${family})`;
  const familyLink = link("Show instances of this job family",
    actionsPath + '?var-job_family=:${__value.raw:percentencode}&var-job_instance=*');
  const stepsLink = link("Show steps for this job instance",
    actionsPath + '?var-job_family=${job_family:percentencode}&var-job_instance=${__data.fields["Job key"]:percentencode}');
  const githubLink = link("Open verified job on GitHub",
    `https://github.com/${repository}/actions/runs/` + '${__data.fields["Run"]:percentencode}/job/${__data.fields["Job ID"]:percentencode}');
  const tableOptions = { showHeader: true, cellHeight: "sm" };
  const tableFields = { noValue: "Unknown", custom: { minWidth: 76 } };
  const wrap = { id: "custom.wrapText", value: true };
  const execution = byName("Execution", unit("ms"), width(86));
  const durations = [
    execution,
    byName("Only known running", unit("ms"), width(169)),
    byName("Queue", unit("ms"), width(80)),
  ];
  const coverageRows = (fields: [string, string][]) => fields.map(([label, column]) =>
    `SELECT '${label}' AS "Evidence", ${column} AS "Observed" FROM actions_wait_coverage`).join("\nUNION ALL\n");
  const actions = board("barnacles-actions", "Barnacles · Actions waits", from, to, [
    block(1, "Evidence scope", [0, 0, 15, 5],
      `**${repository}** · This view covers recorded workflow watcher receipts. “Only known running” counts time with one observed running job. Job durations can overlap. Establishing what held up a run requires dependency evidence.`),
    data(2, "table", "Snapshot window · UTC", [15, 0, 9, 5],
      `SELECT 'Start' AS "Bound", strftime('%Y-%m-%d %H:%M:%f', window_start_ms / 1000.0, 'unixepoch') AS "Time"
        FROM actions_wait_coverage
      UNION ALL
      SELECT 'End', strftime('%Y-%m-%d %H:%M:%f', window_end_ms / 1000.0, 'unixepoch')
        FROM actions_wait_coverage
      UNION ALL
      SELECT 'Source', CASE wait_source_present WHEN 1 THEN 'Watcher evidence available' ELSE 'Reimport Codex rollouts' END
        FROM actions_wait_coverage`,
      { showHeader: false, cellHeight: "sm" }, tableFields, [byName("Bound", width(58))], [],
      "The prepared evidence snapshot fixes these bounds."),
    data(3, "table", "Job family ranking", [0, 5, 24, 7],
      `SELECT job_label AS "Family", job_count AS "Jobs", execution_ms AS "Execution",
        only_known_running_ms AS "Only known running", queue_ms AS "Queue"
        FROM actions_wait_jobs ORDER BY rank`,
      tableOptions, tableFields,
      [byName("Family", { id: "custom.minWidth", value: 98 }, wrap, links(familyLink)),
        byName("Jobs", width(56)), ...durations], [],
      "Ranked by execution overlap. Select a family to filter Exact job instances below. Jobs counts instances. Execution and queue measure overlap with matched waits. Scroll sideways for more columns."),
    data(4, "table", "Wait and attempt coverage", [0, 12, 12, 8], coverageRows([
      ["Observed waits", "wait_count"], ["Waits with exact identity", "exact_wait_count"],
      ["Matched waits", "matched_wait_count"], ["Matched attempts", "matched_attempts"],
      ["Unmatched attempts", "unmatched_attempts"], ["Matched attempts with no job records", "jobless_attempts"],
    ]), { showHeader: false, cellHeight: "sm" }, tableFields,
      [byName("Evidence", wrap), byName("Observed", width(80))], [],
      "Zero observed waits means this window has no wait evidence. An exact identity names the repository, run, expected head SHA and attempt. A wait can have an exact identity without a matching attempt receipt."),
    data(5, "table", "Time within matched waits", [12, 12, 12, 8], coverageRows([
      ["Matched wait time", "matched_wait_ms"], ["Known job running", "running_ms"],
      ["Known queue only", "queue_only_ms"], ["Job clocks unknown", "unknown_job_ms"],
    ]), { showHeader: false, cellHeight: "sm" }, tableFields,
      [byName("Evidence", wrap), byName("Observed", unit("ms"), width(100))], [],
      "Matched wait intervals are counted once within each exact attempt. Time can overlap across different attempts. Unknown marks missing job clocks."),
    data(6, "table", "Exact job instances", [0, 20, 24, 9],
      `SELECT CAST(job_id AS TEXT) AS "Job ID", job_label AS "Job", attempt AS "Attempt",
        CAST(run_id AS TEXT) AS "Run", execution_ms AS "Execution",
        only_known_running_ms AS "Only known running", queue_ms AS "Queue",
        'Open job' AS "GitHub", head_sha AS "Head SHA", ${jobKey} AS "Job key"
        ${instances} ORDER BY run_id DESC, attempt DESC, job_id`,
      tableOptions, tableFields,
      [byName("Job ID", width(102), links(stepsLink)), byName("Job", wrap), byName("Attempt", width(76)),
        byName("Run", width(113)), ...durations, byName("GitHub", width(92), links(githubLink)),
        byName("Head SHA", width(360)), byName("Job key", { id: "custom.hidden", value: true })], [],
      "Select a job ID or use Job instance to show its steps. Scroll the table sideways for more columns on narrow screens."),
    data(7, "table", "Steps for selected job", [0, 29, 24, 8],
      `SELECT step_number AS "Step", step_label AS "Step name", execution_ms AS "Execution"
        FROM actions_wait_steps WHERE ${jobKey} = ${job} ORDER BY step_number`,
      tableOptions, tableFields,
      [byName("Step", width(62)), byName("Step name", wrap), execution], [],
      "Choose an exact job instance. If no steps appear, the snapshot has no step evidence for that selection."),
  ], [link("Shipping review", "/d/barnacles-shipping/shipping")], [
    variable("job_family", "Job family", `SELECT 'All job families' AS __text, '*' AS __value
      UNION ALL SELECT job_label, ':' || job_label FROM actions_wait_jobs ORDER BY __value`, "*"),
    variable("job_instance", "Job instance", `SELECT 'Choose a job' AS __text, '*' AS __value
      UNION ALL SELECT 'Job ' || job_id || ' · run ' || run_id || ' · attempt ' || attempt, ${jobKey}
      ${instances} ORDER BY __value`, "*"),
  ]);
  return Object.assign(actions, { timepicker: { hidden: true } });
}

const timingWindow = "${window:sqlstring}";
const windowLink = "?var-window=${window:percentencode}";
const workflowLink = link("Show operations for this workflow",
  timingPath + windowLink + "&var-clock=${clock:percentencode}&var-workflow=${__value.raw}");
const clockQuery = "SELECT DISTINCT clock FROM clock_totals ORDER BY clock";
const wrap = { id: "custom.wrapText", value: true };

function timingRange(cutoff: number, grid = [0, 0, 9, 3]) {
  return block(16, "Timing cutoff (UTC)", grid,
    new Date(cutoff).toISOString().replace("T", " ").replace(/(?:\.000)?Z$/, ""));
}

function freshness(y: number) {
  const utc = (column: string) => `strftime('%Y-%m-%d %H:%M:%S', ${column} / 1000.0, 'unixepoch')`;
  return data(17, "table", "Source freshness", [0, y, 24, 13],
    `SELECT source AS "Source", position ||
        COALESCE(char(10) || 'From ' || ${utc("first_ms")} || char(10) || 'To ' || ${utc("latest_ms")}, '') ||
        COALESCE(char(10) || 'Receipt ' || ${utc("receipt_ms")},
          CASE WHEN latest_ms IS NOT NULL THEN char(10) || 'Receipt unknown' ELSE '' END) AS "Evidence (UTC)"
      FROM source_bounds WHERE window = ${timingWindow} ORDER BY ordinal`,
    { showHeader: true, cellHeight: "sm" }, { custom: { minWidth: 64 } },
    [byName("Source", width(68)), byName("Evidence (UTC)", wrap)], [],
    "First and latest are timestamps in imported evidence. Actions receipts are attempt captures and release receipts are access checks. Codex and T3 lack capture clocks here. Bounds do not establish continuous coverage.");
}

function clockOccupancy(clock: string, grid = [9, 0, 15, 3]) {
  return data(18, "table", "Clock occupancy", grid,
    `SELECT total_seconds AS "Sum", union_seconds AS "Union", unmeasured AS "Untimed", unplaced AS "Unplaced"
      FROM clock_totals WHERE window = ${timingWindow} AND clock = ${clock}`,
    { showHeader: true }, { noValue: "—", custom: { minWidth: 54 } },
    [byName("Sum", unit("s"), width(52)), byName("Union", unit("s"), width(58)),
      byName("Untimed", width(72)), byName("Unplaced", width(78))], [],
    "Sum adds clipped span durations. Union counts overlapping time once across this clock. Untimed has a timestamp in the window and no usable duration. Unplaced has no usable timestamp in the entire import. CI queue, job execution and nested steps use separate clocks. Occupancy can overlap delivery elapsed time.");
}

export function dashboards(range: Range, repository: string) {
  const rolloutScope = range.rolloutCount
    ? `Codex timing covers all ${range.rolloutCount} imported ${range.rolloutCount === 1 ? "rollout" : "rollouts"} across projects.`
    : "No Codex rollouts imported.";
  const from = new Date(range.from * 1000).toISOString();
  const to = new Date((range.to + 1) * 1000).toISOString();
  const timestamps = ["PR opened", "Merged", "Published", "Access checked"];
  const cyclePR = "${cycle_pr:sqlstring}";
  const operationClock = "${operation_clock:sqlstring}";
  const overviewOperation = "${overview_operation:sqlstring}";
  const operationLink = link("Open operation breakdown",
    timingPath + windowLink + "&var-clock=${operation_clock:percentencode}&var-operation=${__data.fields[\"Name\"]:percentencode}");
  const windowVariable = variable("window", "Timing window", "SELECT window FROM timing_windows ORDER BY started_ms", "24h");
  const operations = [
    variable("operation_clock", "Clock", clockQuery, "Tool envelopes"),
    variable("overview_operation", "Operation", `SELECT 'All operations' AS operation
      UNION SELECT operation FROM operation_totals WHERE window = ${timingWindow} AND clock = ${operationClock} ORDER BY operation`, "All operations"),
  ];
  const shipping = board("barnacles-shipping", "Barnacles · Shipping review", from, to, [
    block(1, "Evidence scope", [0, 0, 9, 4],
      `Linux Main x86_64 and CI for **${repository}**. ${rolloutScope}`),
    data(2, "gauge", "Gardening ↔ Shipping", [0, 4, 9, 6], 'SELECT dial AS "Direction" FROM coverage',
      { reduceOptions, showThresholdLabels: false, showThresholdMarkers: false },
      { min: -1.3, max: 1.3, noValue: "Insufficient coverage", color: { mode: "thresholds" },
        mappings: [{ type: "value", options: { "-1": { text: "Gardening", color: yellow }, "1": { text: "Shipping", color: green } } },
          { type: "special", options: { match: "null", result: { text: "Insufficient coverage" } } }],
        thresholds: { mode: "absolute", steps: [{ value: null, color: yellow }, { value: 0, color: green }] } },
      [], [], "Direction comes only from the mean thread-to-release time in the latest two completed UTC weeks."),
    data(3, "marcusolsson-treemap-panel", "Recorded time by operation", [9, 4, 15, 6],
      `SELECT operation AS "Name", total_seconds AS "Total" FROM operation_totals
        WHERE window = ${timingWindow} AND clock = ${operationClock} AND has_area = 1
          AND (${overviewOperation} = 'All operations' OR operation = ${overviewOperation}) ORDER BY rank`,
      { tiling: "treemapSquarify", textField: "Name", sizeField: "Total" },
      { unit: "s", color: { mode: "fixed", fixedColor: "#BB8E4F" }, links: [operationLink] }, [], [],
      "Tile area shows recorded time in the selected window. Named waits use matched process receipts. Unidentified waits stay visible. Spans can overlap."),
    data(4, "table", "Cycle-time comparison", [0, 10, 9, 5],
      `SELECT delta_seconds AS "Change", prior_count AS "Prior PRs", recent_count AS "Recent PRs" FROM coverage`,
      { showHeader: true }, { noValue: "—", custom: { minWidth: 80 } }, [byName("Change", unit("s"))], [],
      "Counts are attributable shipped PRs in the two latest completed UTC weeks. A positive change points toward Gardening."),
    chart(5, "Shipped to users · weekly", [0, 21, 12, 6], 'shipped AS "Verified shipments"', green, "short",
      "Counts verified PRs in the imported sample by UTC week. Missing weeks are outside observed coverage."),
    chart(6, "Weekly cycle time", [12, 21, 12, 6], 'mean_seconds AS "Mean elapsed time"', yellow, "s",
      "Only PRs with explicit thread attribution contribute. The coverage panel shows linked PRs in the sample."),
    data(7, "stat", "Delivery coverage", [9, 0, 15, 4],
      'SELECT pr_count AS "PRs observed", shipped AS "Access verified", linked AS "Thread linked" FROM coverage',
      { reduceOptions, colorMode: "none", graphMode: "none", justifyMode: "center" },
      { color: { mode: "fixed", fixedColor: ink } }),
    data(10, "table", "Operations ranked by time", [9, 10, 15, 11],
      `SELECT operation AS "Name", total_seconds AS "Sum", union_seconds AS "Union", count AS "Spans", mean_seconds AS "Mean"
        FROM operation_totals WHERE window = ${timingWindow} AND clock = ${operationClock}
          AND (${overviewOperation} = 'All operations' OR operation = ${overviewOperation}) ORDER BY rank`,
      { showHeader: true, enablePagination: true, cellHeight: "sm" }, { noValue: "—", custom: { minWidth: 56 } },
      [byName("Name", { id: "custom.wrapText", value: true }, { id: "custom.minWidth", value: 150 }, links(operationLink)),
        byName("Sum", unit("s"), width(90)), byName("Union", unit("s"), width(86)),
        byName("Spans", width(70)), byName("Mean", unit("s"), width(72))], [],
      "Spans counts measured intervals in the window. Mixed commands share one measured duration. Open Timing breakdown for untimed spans and individual CI workflows."),
    timingRange(range.timingCutoff, [0, 27, 9, 3]),
    clockOccupancy(operationClock, [9, 27, 15, 3]),
    freshness(30),
    data(15, "table", "Estimated category times · snapshot", [0, 43, 24, 8],
      `SELECT name AS "Group", CASE WHEN seconds IS NOT NULL THEN printf('%.3g ± %.2g', seconds, error) END AS "s/cmd",
        CASE WHEN total < 60 THEN printf('%.2g s', total)
          WHEN total < 3600 THEN printf('%.2g m', total / 60)
          WHEN total IS NOT NULL THEN printf('%.2g h', total / 3600) END AS "Total",
        samples AS "Rows" FROM category_estimates ORDER BY name`,
      { showHeader: true }, { noValue: "—", custom: { minWidth: 48 } },
      [byName("Group", { id: "custom.wrapText", value: true }), byName("s/cmd", width(84)),
        byName("Total", width(56)), byName("Rows", width(52))], [],
      "Estimated seconds per command ± standard error. Total applies to the matched sample, and Rows counts its receipts. A dash means insufficient independent variation. Estimates use completed sequential shell receipts."),
    block(11, "Delivery elapsed time", [0, 51, 24, 3],
      "Choose a PR for details. Coverage shows measured shipments."),
    data(12, "table", "Elapsed time by stage", [0, 54, 12, 12],
      `SELECT name AS "Stage", mean_seconds AS "Mean", observed || ' / ' || (SELECT shipped FROM coverage) AS "Coverage"
        FROM delivery_stages ORDER BY ordinal`,
      { showHeader: true, enablePagination: true }, { noValue: "—", custom: { minWidth: 55 } }, [
        byName("Stage", { id: "custom.wrapText", value: true }),
        byName("Mean", unit("dthms"), width(86)), byName("Coverage", width(78)),
      ], [], "Coverage is shipments with both clocks in order out of all imported shipments. Overall intervals overlap the individual stages."),
    data(13, "table", "Milestones for selected PR", [12, 54, 12, 12],
      `SELECT name AS "Event", strftime('%Y-%m-%dT%H:%M:%fZ', observed_ms / 1000.0, 'unixepoch') AS "UTC",
        elapsed_seconds AS "Elapsed" FROM delivery_milestones
        WHERE CAST(pr AS TEXT) = ${cyclePR} ORDER BY ordinal`,
      { showHeader: true, enablePagination: true }, { noValue: "Unknown", custom: { minWidth: 70 } }, [
        byName("Event", { id: "custom.wrapText", value: true }),
        byName("UTC", unit("time:MM-DD HH:mm:ss"), width(113)),
        byName("Elapsed", unit("dthms"), width(84), { id: "noValue", value: "—" }),
      ], ["UTC"], "Elapsed is from the preceding milestone. First PR CI is the earliest linked workflow start observed. Shipped uses publication backed by an access check. The check time is listed separately."),
    data(8, "table", "Recently shipped", [0, 66, 24, 7],
      `SELECT pr AS "PR", cycle_seconds AS "Thread → release", pr_seconds AS "PR → release",
        published AS "Published", verified AS "Access checked", opened AS "PR opened", merged AS "Merged", url AS "URL"
        FROM releases ORDER BY published DESC`,
      { showHeader: true }, { noValue: "Unknown" },
      [...prLinks, byName("Thread → release", unit("s"), width(128)),
        byName("PR → release", unit("s"), width(112)), ...timestamps.map((field) => byName(field, width(161)))], timestamps),
    data(9, "table", "Open delivery threads", [0, 73, 24, 6],
      'SELECT pr AS "PR", status AS "T3 status", created AS "Thread started", url AS "URL" FROM work ORDER BY created DESC',
      { showHeader: true }, {}, prLinks, ["Thread started"],
      "Only imported T3 threads with an explicit owning link to an observed open pull request."),
  ], [link("Actions waits", actionsPath),
    link("Timing breakdown", timingPath + windowLink +
    "&var-clock=${operation_clock:percentencode}&var-operation=${overview_operation:percentencode}"),
    link("Rollout waterfall", tracePath), link("Changed Code Analysis", changedCodePath)], [
    windowVariable, ...operations,
    variable("cycle_pr", "Cycle-time PR", "SELECT CAST(pr AS TEXT) FROM releases ORDER BY published DESC, pr DESC", ""),
  ]);

  const clock = "${clock:sqlstring}";
  const workflow = "${workflow:sqlstring}";
  const operation = "${operation:sqlstring}";
  const timeFields = [byName("Mean", unit("s")), byName("Sum", unit("s")), byName("Union", unit("s"))];
  const timing = board("barnacles-timing", "Barnacles · Timing breakdown", from, to, [
    timingRange(range.timingCutoff),
    clockOccupancy(clock),
    freshness(3),
    data(2, "table", "Selected clock by workflow", [0, 16, 24, 5],
      `SELECT CAST(workflow AS TEXT) AS "Workflow", total_seconds AS "Sum", union_seconds AS "Union",
        count AS "Spans", mean_seconds AS "Mean", unmeasured AS "Untimed"
        FROM workflows WHERE window = ${timingWindow} AND clock = ${clock} ORDER BY rank`,
      { showHeader: true }, { noValue: "—", custom: { minWidth: 58 } },
      [...timeFields, byName("Workflow", links(workflowLink))],
      [], "Workflow 0 is local Codex evidence."),
    data(3, "table", "Operations ranked by summed time", [0, 21, 24, 11],
      `SELECT operation AS "Operation", total_seconds AS "Sum", union_seconds AS "Union",
        count AS "Spans", mean_seconds AS "Mean", unmeasured AS "Untimed"
        FROM timing_selection JOIN timing_details USING (window, clock, kind, rank)
        WHERE window = ${timingWindow} AND clock = ${clock}
          AND workflow_choice = ${workflow} AND operation_choice = ${operation}
        ORDER BY rank`,
      { showHeader: true, enablePagination: true },
      { noValue: "—", custom: { minWidth: 60 } }, [...timeFields, byName("Operation", wrap)],
      [], "Choose Mixed to see submitted command groups. Each group uses the clipped duration of its entire span. Union values for different rows can overlap."),
  ], [link("Shipping review", "/d/barnacles-shipping/shipping" + windowLink + "&var-operation_clock=${clock:percentencode}"),
    link("Rollout waterfall", tracePath)], [
    windowVariable,
    variable("clock", "Clock", clockQuery, "Tool envelopes"),
    variable("workflow", "Workflow", `SELECT '*' AS workflow
      UNION SELECT DISTINCT CAST(workflow AS TEXT) FROM workflows WHERE window = ${timingWindow} AND clock = ${clock} ORDER BY workflow`, "*"),
    variable("operation", "Operation", `SELECT 'All operations' AS operation
      UNION SELECT operation FROM timing WHERE window = ${timingWindow} AND clock = ${clock}
      UNION SELECT operation FROM mixed_groups WHERE window = ${timingWindow} AND clock = ${clock} ORDER BY operation`, "All operations"),
  ]);
  Object.assign(shipping, { timepicker: { hidden: true } });
  Object.assign(timing, { timepicker: { hidden: true } });

  const first = range.defaultTrace;
  const session = "${session:sqlstring}";
  const reasoningTime = "strftime('%Y-%m-%dT%H:%M:%fZ', observed / 1000.0, 'unixepoch')";
  const trace = board("barnacles-trace", "Barnacles · Rollout waterfall",
    first ? new Date(first.from).toISOString() : from, first ? new Date(first.to).toISOString() : to, [
      range.traceSessions ? data(1, "table", "Session coverage", [0, 0, 24, 5],
        `SELECT kind AS "Evidence", observed AS "Seen", missing AS "Untimed"
          FROM trace_coverage WHERE CAST(session AS TEXT) = ${session} ORDER BY ordinal`,
        { showHeader: true }, { noValue: "—", custom: { minWidth: 64 } },
        [byName("Seen", width(61)), byName("Untimed", width(80))], [],
        "Untimed spans have incomplete clocks. Reasoning events are timestamps on the session root.")
        : block(1, "Session coverage", [0, 0, 24, 5], "Import a Codex rollout and rebuild the snapshot to view a trace."),
      {
        id: 2, type: "traces", title: "Session trace", datasource: tempo,
        gridPos: { x: 0, y: 5, w: 24, h: 14 },
        description: "Estimated model wait measures the gap from a tool result to the next recorded reasoning when tool activity leaves the gap clear. It can include harness delays, network time, provider queueing and inference. Span attributes show the source lines and submitted categories.",
        targets: [{ datasource: tempo, refId: "A", queryType: "traceql", query: "${traceId}" }],
      },
      data(4, "table", "Completed spans", [0, 19, 24, 6],
        `SELECT operation AS "Operation", source_line AS "Line" FROM trace
          WHERE CAST(session AS TEXT) = ${session} AND started IS NOT NULL AND ended IS NOT NULL
          ORDER BY started, source_line, clock`,
        { showHeader: true }, {}, [byName("Line", width(72))]),
      data(3, "table", "Spans with missing clocks", [0, 25, 12, 5],
        `SELECT source_line || ' · ' || operation AS "Span",
          started / 1000.0 AS "Started", ended / 1000.0 AS "Ended" FROM trace
          WHERE CAST(session AS TEXT) = ${session} AND (started IS NULL OR ended IS NULL) ORDER BY started`,
        { showHeader: true }, { noValue: "Unknown", custom: { minWidth: 70 } }, [], ["Started", "Ended"]),
      data(5, "table", "Reasoning timestamps", [12, 25, 12, 5],
        `SELECT ${reasoningTime} AS "Observed UTC", source_line AS "Line"
          FROM trace_reasoning WHERE CAST(session AS TEXT) = ${session} ORDER BY observed, source_line`,
        { showHeader: true }, {}, [
          byName("Observed UTC", unit("time:YYYY-MM-DD HH:mm:ss.SSS")), byName("Line", width(72)),
        ], ["Observed UTC"],
        "Point events in the selected session with their rollout source lines. Reimport older rollouts to add reasoning coverage."),
    ], [link("Shipping review", "/d/barnacles-shipping/shipping")], [
      variable("session", "Session", "SELECT CAST(session AS TEXT) FROM trace_windows ORDER BY session", String(first?.session ?? 1)),
      { ...variable("traceId", "Trace ID", `SELECT COALESCE((SELECT trace_id FROM trace_windows
        WHERE CAST(session AS TEXT) = ${session}), '')`, first?.traceId ?? ""), hide: 2 },
    ]);
  Object.assign(trace, { timepicker: { hidden: true } });
  const scan = range.changedCode;
  const coverageHeight = scan?.truncated || scan?.shallow ? 6 : 4;
  const changedCode = {
    ...board("barnacles-changed-code", "Barnacles · Changed Code Analysis", from, to, [
      scan ? block(1, "Git scan coverage", [0, 0, 24, coverageHeight], scanSummary(repository, scan))
        : block(1, "No Git scan", [0, 0, 24, 5],
          `Run Changed Code Analysis with \`--save-as ${repository}\`, then rebuild the Grafana snapshot.`),
      ...(scan?.hasPaths ? [data(2, "table", "Files by commit count", [0, coverageHeight, 24, 17],
        `SELECT COALESCE(path, 'Base64: ' || path_base64) AS "File path", commits AS "Commits" FROM changed_files ORDER BY rank`,
        { showHeader: true, enablePagination: true }, { custom: { minWidth: 68 } },
        [byName("Commits", unit("none"), width(80), { id: "decimals", value: 0 })], [],
        "Up to 25 paths ranked by commits that touched them. Additions, edits, and deletions each count once per commit. Frequent edits can point to files worth investigating.")]
        : scan ? [block(2, "No file changes in this scan", [0, coverageHeight, 24, 4],
          scan.shallow || scan.truncated ? "Scan more history to look for file changes."
            : "Scan a revision with file changes to see a ranking.")] : []),
    ], [link("Shipping review", shippingPath)]),
    timepicker: { hidden: true },
  };
  return { shipping, timing, trace, "changed-code": changedCode, actions: actionsDashboard(from, to, repository) };
}
