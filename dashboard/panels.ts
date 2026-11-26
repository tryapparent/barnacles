const datasource = { uid: "barnacles", type: "frser-sqlite-datasource" };
const tempo = { uid: "barnacles-tempo", type: "tempo" };
const yellow = "#F2B826";
const green = "#4DAE79";
const ink = "#D3D8D2";
const timingPath = "/d/barnacles-timing/timing";
const tracePath = "/d/barnacles-trace/trace";

type Window = { from: number; to: number };
type Range = Window & { traceSessions: number; defaultTrace?: Window & { session: number; traceId: string } };
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
const timingLink = link("Open timing breakdown", timingPath + "?var-clock=${__value.raw}");
const workflowLink = link("Show operations for this workflow",
  timingPath + "?var-clock=${__data.fields.Clock}&var-workflow=${__value.raw}");
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
    `SELECT week AS time, ${fields} FROM weeks
     WHERE week >= ($__from / 1000) AND week <= ($__to / 1000) ORDER BY time`,
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

export function dashboards(range: Range) {
  const from = new Date(range.from * 1000).toISOString();
  const to = new Date((range.to + 1) * 1000).toISOString();
  const timestamps = ["PR opened", "Merged", "Published", "Access checked"];
  const cyclePR = "${cycle_pr:sqlstring}";
  const shipping = board("barnacles-shipping", "Barnacles · Shipping review", from, to, [
    block(1, "Linux Main · x86_64", [0, 0, 9, 3],
      "Verified AppImage releases in the imported sample."),
    data(2, "gauge", "Gardening ↔ Shipping", [0, 3, 9, 6], 'SELECT dial AS "Direction" FROM coverage',
      { reduceOptions, showThresholdLabels: false, showThresholdMarkers: false },
      { min: -1.3, max: 1.3, noValue: "Insufficient coverage", color: { mode: "thresholds" },
        mappings: [{ type: "value", options: { "-1": { text: "Gardening", color: yellow }, "1": { text: "Shipping", color: green } } },
          { type: "special", options: { match: "null", result: { text: "Insufficient coverage" } } }],
        thresholds: { mode: "absolute", steps: [{ value: null, color: yellow }, { value: 0, color: green }] } },
      [], [], "Direction comes only from the mean thread-to-release time in the latest two completed UTC weeks."),
    data(3, "marcusolsson-treemap-panel", "Where recorded time went", [9, 3, 15, 5],
      'SELECT clock AS "Clock", total_seconds AS "Duration" FROM time_map ORDER BY rank',
      { tiling: "treemapSquarify", textField: "Clock", sizeField: "Duration" },
      { unit: "s", color: { mode: "fixed", fixedColor: "#BB8E4F" }, links: [timingLink] },
      [byName("Duration", links(link("Open timing breakdown", timingPath + '?var-clock=${__data.fields["Clock"]}')))], [],
      "Area shows recorded duration. Clocks can overlap. CI steps are available in the breakdown."),
    data(4, "table", "Cycle-time comparison", [0, 9, 9, 5],
      `SELECT delta_seconds AS "Change", prior_count AS "Prior PRs", recent_count AS "Recent PRs" FROM coverage`,
      { showHeader: true }, { noValue: "—", custom: { minWidth: 80 } }, [byName("Change", unit("s"))], [],
      "Counts are attributable shipped PRs in the two latest completed UTC weeks. A positive change points toward Gardening."),
    chart(5, "Shipped to users · weekly", [0, 14, 12, 6], 'shipped AS "Verified shipments"', green, "short",
      "Counts verified PRs in the imported sample by UTC week. Missing weeks are outside observed coverage."),
    chart(6, "Weekly cycle time", [12, 14, 12, 6], 'mean_seconds AS "Mean elapsed time"', yellow, "s",
      "Only PRs with explicit thread attribution contribute. The coverage panel shows linked PRs in the sample."),
    data(7, "stat", "Delivery coverage", [9, 0, 15, 3],
      'SELECT pr_count AS "PRs observed", shipped AS "Access verified", linked AS "Thread linked" FROM coverage',
      { reduceOptions, colorMode: "none", graphMode: "none", justifyMode: "center" },
      { color: { mode: "fixed", fixedColor: ink } }),
    block(11, "Delivery cycle time", [0, 20, 24, 3],
      "Choose a PR for details. Coverage shows measured shipments."),
    data(12, "table", "Time by stage", [0, 23, 12, 12],
      `SELECT name AS "Stage", mean_seconds AS "Mean", observed || ' / ' || (SELECT shipped FROM coverage) AS "Coverage"
        FROM delivery_stages ORDER BY ordinal`,
      { showHeader: true, enablePagination: true }, { noValue: "—", custom: { minWidth: 55 } }, [
        byName("Stage", { id: "custom.wrapText", value: true }),
        byName("Mean", unit("dthms"), width(86)), byName("Coverage", width(78)),
      ], [], "Coverage is shipments with both clocks in order out of all imported shipments. Overall intervals overlap the individual stages."),
    data(13, "table", "Milestones for selected PR", [12, 23, 12, 12],
      `SELECT name AS "Event", strftime('%Y-%m-%dT%H:%M:%fZ', observed_ms / 1000.0, 'unixepoch') AS "UTC",
        elapsed_seconds AS "Elapsed" FROM delivery_milestones
        WHERE CAST(pr AS TEXT) = ${cyclePR} ORDER BY ordinal`,
      { showHeader: true, enablePagination: true }, { noValue: "Unknown", custom: { minWidth: 70 } }, [
        byName("Event", { id: "custom.wrapText", value: true }),
        byName("UTC", unit("time:MM-DD HH:mm:ss"), width(113)),
        byName("Elapsed", unit("dthms"), width(84), { id: "noValue", value: "—" }),
      ], ["UTC"], "Elapsed is from the preceding milestone. First PR CI is the earliest linked workflow start observed. Shipped uses publication backed by an access check. The check time is listed separately."),
    data(8, "table", "Recently shipped", [0, 35, 24, 7],
      `SELECT pr AS "PR", cycle_seconds AS "Thread → release", pr_seconds AS "PR → release",
        published AS "Published", verified AS "Access checked", opened AS "PR opened", merged AS "Merged", url AS "URL"
        FROM releases ORDER BY published DESC`,
      { showHeader: true }, { noValue: "Unknown" },
      [...prLinks, byName("Thread → release", unit("s"), width(128)),
        byName("PR → release", unit("s"), width(112)), ...timestamps.map((field) => byName(field, width(161)))], timestamps),
    data(9, "table", "Open delivery threads", [0, 42, 24, 6],
      'SELECT pr AS "PR", status AS "T3 status", created AS "Thread started", url AS "URL" FROM work ORDER BY created DESC',
      { showHeader: true }, {}, prLinks, ["Thread started"],
      "Only imported T3 threads with an explicit owning link to an observed open pull request."),
    data(10, "table", "Explore timing by clock", [9, 8, 15, 6],
      'SELECT clock AS "Clock", total_seconds AS "Duration" FROM time_map ORDER BY rank',
      { showHeader: true }, {}, [byName("Clock", links(timingLink)), byName("Duration", unit("s"))]),
  ], [link("Timing breakdown", timingPath), link("Rollout waterfall", tracePath)], [
    variable("cycle_pr", "Cycle-time PR", "SELECT CAST(pr AS TEXT) FROM releases ORDER BY published DESC, pr DESC", ""),
  ]);

  const clock = "${clock:sqlstring}";
  const workflow = "${workflow:sqlstring}";
  const timeFields = [byName("Mean", unit("s")), byName("Total", unit("s"))];
  const timing = board("barnacles-timing", "Barnacles · Timing breakdown", from, to, [
    block(1, "Recorded occupancy", [0, 0, 24, 3],
      "Choose a clock and workflow. Count × mean gives total recorded time. Clocks can overlap. CI steps are nested inside job execution."),
    data(2, "table", "By workflow", [0, 3, 24, 6],
      `SELECT clock AS "Clock", CAST(workflow AS TEXT) AS "Workflow", count AS "Count",
        mean_seconds AS "Mean", total_seconds AS "Total", unmeasured AS "Unmeasured"
        FROM workflows WHERE clock = ${clock} ORDER BY rank`,
      { showHeader: true }, {},
      [...timeFields, byName("Workflow", links(workflowLink)),
        byName("Clock", { id: "custom.hidden", value: true })]),
    data(3, "table", "Operations ranked by total time", [0, 9, 24, 14],
      `SELECT operation AS "Operation", count AS "Count", mean_seconds AS "Mean",
        total_seconds AS "Total", unmeasured AS "Unmeasured"
        FROM timing WHERE clock = ${clock} AND (${workflow} = '*' OR CAST(workflow AS TEXT) = ${workflow})
        ORDER BY rank`,
      { showHeader: true }, { noValue: "—", custom: { minWidth: 85 } }, [...timeFields, byName("Operation", width(310))]),
  ], [link("Shipping review", "/d/barnacles-shipping/shipping"), link("Rollout waterfall", tracePath)], [
    variable("clock", "Clock", "SELECT DISTINCT clock FROM timing ORDER BY clock", "CI execution"),
    variable("workflow", "Workflow", "SELECT '*' AS workflow UNION SELECT DISTINCT CAST(workflow AS TEXT) FROM timing ORDER BY workflow", "*"),
  ]);

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
        description: "The root groups the observed clocks and events. Async cells end at the observed terminal wait. Command labels describe submitted operations.",
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
  return { shipping, timing, trace };
}
