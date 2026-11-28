# Plow Grafana datasource

Self-managed Grafana runs the backend and loads the single-field query editor. The backend reads Loki and runs the Bend2 policy CLI. Use datasource type `plow-agent-observability-datasource` in provisioning and set a fixed UID for dashboards and MCP panel queries. The query target is `{"refId":"A","runId":"fixture-run"}`. The editor also accepts a dashboard variable that resolves to one run ID.

## Provisioning

| Setting | Provisioning location | Value |
| --- | --- | --- |
| Loki base URL | `jsonData.lokiUrl` | For example, `http://loki:3100`. Include a reverse proxy prefix when applicable. |
| Loki tenant | `jsonData.lokiTenant` | One tenant ID, sent in `X-Scope-OrgID`. For single-tenant Loki use `fake`. |
| Loki bearer credential | `secureJsonData.lokiBearerToken` | Optional when Loki is reachable through a trusted internal route. |
| Policy executable | `PLOW_POLICY_COMMAND` in the Grafana server environment | Absolute path to an executable installed in the same image, for example `/opt/plow/bin/analyze-run`. |

The Grafana server operator controls the executable. The query supplies only a run ID. Provision the backend with a dedicated Loki read credential and restrict the Loki endpoint through the deployment network policy. The datasource rejects HTTP redirects.

## Plugin and image build

From this directory, with Go 1.26.5 or newer:

```sh
go test ./...
node --check module.js

install -d "$PLOW_PLUGIN_OUT"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "$PLOW_PLUGIN_OUT/gpx_plow_linux_amd64" .
install -m 0644 plugin.json module.js "$PLOW_PLUGIN_OUT/"
```

For arm64 use `GOARCH=arm64` and the suffix `_linux_arm64`. Copy those three files into the image's Grafana plugin directory under `plow-agent-observability-datasource/`. The frontend uses Grafana's SystemJS exports for React and Grafana UI and requires no npm build. The unsigned loopback candidate needs `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=plow-agent-observability-datasource`. See the [Grafana plugin backend guide](https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins).

The runtime image must install the executable referenced by `PLOW_POLICY_COMMAND` and its runtime dependencies. The backend invokes the executable directly with zero arguments. It sends one UTF-8 JSON document on stdin and closes stdin. It expects one JSON document on stdout and exit status zero. Nonzero exit, malformed output, timeout, and oversized stdout return distinct errors. Stderr and upstream HTTP bodies never appear in data frames.

Build the current policy ahead of time from the repository root with Node 22.18 or newer and the provisioned compiler bundle:

```sh
node --experimental-transform-types analyze/policy/main.ts --compile "$PLOW_POLICY_OUT"
```

Use an existing output directory and include the resulting `run.mjs` in the image alongside the CLI. An executable wrapper can set its location explicitly:

```sh
#!/bin/sh
export PLOW_POLICY_MODULE=/opt/plow/policy/run.mjs
exec /usr/local/bin/node --disable-warning=ExperimentalWarning --experimental-transform-types /opt/plow/policy/main.ts
```

Install a Node runtime compatible with the Grafana image and use its absolute executable path. Packaged queries need only Node, `main.ts`, and `run.mjs`. They do not compile or fetch dependencies. The build still depends on the repository's `tooling/bend.ts` and its verified compiler bundle. For a standalone build, carry forward or replace that compiler wiring and supply the compiler bundle through `PLOW_BEND_BUNDLE`. The plugin has no dependency on the old dashboard, SQLite, or the custom MCP server.

To exercise the real policy through the Go query entry point, run `PLOW_TEST_POLICY_COMMAND=/absolute/path/to/wrapper go test -v ./...` from this directory. Without that environment variable the test suite uses a synthetic policy executable to verify the wire contract.

Input and output follow the [policy directory](../policy/). The backend preserves JSON null for unknown interval clocks and durations.

## Loki requests and coverage

Both reads use `GET /loki/api/v1/query_range` and the selected Grafana range, capped at seven days. Loki entry timestamps correspond to the source clock so the same time range finds the run record and its evidence. The plugin extracts `run.id` under `plow_source="t3_history"` for `history:"1"` or under `plow_source="t3"` for fixture and one-run imports. It reads `sessionId` under `plow_source="codex_history"`. History accepts stock T3 run IDs up to 512 characters. The legacy run and session identifiers use 1–128 letters, digits, dots, underscores, hyphens, or colons, starting with a letter or digit. Each history read requests up to 2,000 entries. The legacy run lookup requests up to 100. A datasource request accepts up to eight targets and has a 12-second deadline. Each Loki call and policy invocation has a four-second timeout and a 4 MiB reply cap. See the [Loki HTTP API reference](https://grafana.com/docs/loki/latest/reference/loki-http-api/#query-logs-within-a-range-of-time).

Bend2 resolves history revisions before selecting the run. Missing, running,
unbound, unreadable, and conflicting T3 history returns empty intervals and
an explicit coverage gap. The result also reports a gap when the run window
contains no observed Codex tool events. A legacy run lookup with conflicting
copies, warnings, or a saturated cap fails the query. The plugin forwards
decodable session events, including replay copies, for Bend2 to assess.
Malformed session records, Loki query warnings, a saturated session cap, and
a range that clips the run appear as partial source coverage. Successful
source coverage describes this bounded read. Source retention and delivery
to Loki are independent of the query.

| Frame | Columns |
| --- | --- |
| `intervals` | `callId`, `kind`, `startMs`, `endMs`, `durationMs` |
| `findings` | `callId`, `reason` |
| `coverage` | `runId`, `events`, `paired`, `unknown`, `sourceComplete`, `sourceGaps` |

The policy can report unknown intervals even when the bounded read completed. Table panels can use the frame names to choose which rows to display. Grafana MCP consumes the same panel query response.

## Activity reads

Set `PLOW_ACTIVITY_SUMMARIES=1` in the Grafana server environment to enable
precomputed Activity overview reads. The same Loki endpoint serves tenant
`plow-activity`. Set `secureJsonData.activitySummaryBearerToken` if this tenant
uses a separate read credential. Otherwise the datasource uses its configured
Loki bearer credential.

The four overview views share a bounded backward read from the exact
`{plow_source="activity_summary",period="24h"|"7d"}` stream. The read considers
the 12 most recently published entries in the last 24 hours. Each entry is
limited to 128 KiB. Its Loki timestamp must match the envelope publication
clock at millisecond precision. The revision is a hex SHA-256 digest. The
version 1 report uses the existing Activity fields for categories, operations,
buckets, findings and source coverage.

Bend2 selects the greatest UTC minute cutoff at or before the requested end.
For that cutoff it selects the latest publication, including corrections
published after the selected end. Conflicting revisions at the winning cutoff
and publication clock yield an unavailable snapshot. An eligible snapshot
outside the bounded page is unavailable. Freshness uses the report's measured
T3 watermark, with more than 15 minutes of lag marked stale and an absent
watermark marked unknown. The source input cutoff and publication clock remain
visible separately. Malformed entries and Loki warnings mark the read partial.
Matching queries reuse the selection for five seconds per period and cutoff
minute. The overview reports missing snapshots or query errors through Grafana
and retries on refresh. It issues only summary reads in this mode.

### Raw Activity detail and default mode

Both Activity periods retain eight days of source context before the Grafana cutoff. This covers the weekly view, a lagging collection checkpoint, and the prior runs needed to measure gaps. The Bend2 policy selects the checkpoint, clips the analysis, resolves revisions, and computes every view from the same records.

T3 history and GitHub CI evidence are read in UTC day slices. Each page requests up to 2,000 entries. A full forward page establishes a complete prefix strictly before its last timestamp. The next page starts at that timestamp so it can read any entries tied there. If a page cannot advance or exceeds 4 MiB, the datasource bisects the slice up to six times. Each slice has the same maximum number of requests as six full bisections, and slices share four concurrent readers. The evidence budget is 8 MiB per slice and 32 MiB or 50,000 rows per snapshot. A slice that would exceed the snapshot budget is omitted. The separate T3 and Codex checkpoint queries read the latest 32 receipts each. The tenant and authentication headers and four-second Loki timeout apply throughout. Activity stops scheduling source reads after seven seconds and reports the remaining gaps with the evidence already read. Bend2 builds the report within the 12-second request deadline.

For the canonical T3 command-execution receipt, Bend2 supplies a LogQL projection. It excludes observations after the requested cutoff and removes the observation field from eligible receipts with an explicit numeric revision. This lets Loki collapse identical receipts at the same source timestamp before applying its entry limit. Older and conflicting revisions stay distinct. Receipts with a different shape, including ones that fall back to the observation clock for their revision, pass through unchanged. Bend2 still resolves the returned evidence by identity, revision and cutoff. Other sources, checkpoint queries and run lookup use their own selectors.

The datasource reuses the result for five seconds within the same instance, exact cutoff, period and operation. Each panel renders its own frames from that report. Frame warnings name the source and distinguish Loki warnings, reply limits, slice limits and omitted snapshot slices. Malformed evidence has its own warning. Coverage keeps the collection checkpoint status visible alongside these read warnings. A transport or Loki serving failure returns a downstream datasource error. An empty successful read produces empty evidence with the policy's missing-checkpoint and nullable-clock states.

Activity timeline spans carry only the two clocks and operation label needed by the Grafana SDK. The compact CLI encoding keeps the report under the shared 4 MiB output limit at higher evidence volumes. An oversized policy result returns a plugin error.

## One-shot Activity refresh

Build the standalone producer from the repository root. Use the pinned Bend2
bundle and build dependencies for the checkout. The commands below use a private
directory on a host with Node 22 and the Go toolchain from `go.mod`.

```sh
export PLOW_PRODUCER_OUT=$(mktemp -d /tmp/apparent-dev-plow-refresh-XXXXXX)
mkdir "$PLOW_PRODUCER_OUT/policy"
node analyze/policy/main.ts --compile "$PLOW_PRODUCER_OUT/policy"
(
  cd analyze/datasource
  CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags=-X=main.buildMode=activity-refresh \
    -o "$PLOW_PRODUCER_OUT/plow-activity-refresh" .
)
export PLOW_POLICY_COMMAND="$PWD/infra/lgtm/policy.sh"
export PLOW_POLICY_CLI="$PWD/analyze/policy/main.ts"
export PLOW_ACTIVITY_MODULE="$PLOW_PRODUCER_OUT/policy/activity.mjs"
```

Run `plow-activity-refresh` with the following environment. The policy wrapper must set `PLOW_ACTIVITY_MODULE` to the compiled `activity.mjs`. The producer defaults to the current UTC minute boundary. Pass `--cutoff-ms` with an earlier UTC minute boundary to refresh that cutoff after a backfill.

| Setting | Purpose |
| --- | --- |
| `PLOW_POLICY_COMMAND` | Absolute path to the compiled policy wrapper |
| `PLOW_ACTIVITY_SOURCE_URL` | Raw Loki base URL with any proxy prefix |
| `PLOW_ACTIVITY_SOURCE_TENANT` | Raw evidence tenant |
| `PLOW_ACTIVITY_SOURCE_TOKEN` | Optional raw Loki read token |
| `PLOW_ACTIVITY_SINK_URL` | Summary Loki base URL with any proxy prefix |
| `PLOW_ACTIVITY_SINK_TOKEN` | Optional summary Loki write token |

For an isolated standalone stack, point both URLs at its loopback Loki and
set the source tenant to the tenant holding its synthetic evidence. Invoke
`"$PLOW_PRODUCER_OUT/plow-activity-refresh"` once to populate both presets and
set `PLOW_ACTIVITY_SUMMARIES=1` on the candidate Grafana server. Reapply by
running the same executable with the same tenant and URLs. Pass the original
cutoff for an explicit correction. An external scheduler would run this same
command with one active invocation at a time, a cadence shorter than the
15-minute freshness threshold, and the environment above. Where Loki uses an
auth proxy, grant the producer raw-tenant query and summary-tenant push
credentials and give Grafana a separate summary-tenant query credential.

One refresh reads the existing bounded raw snapshot, then runs Bend2 for both presets. The refresh has a two-minute deadline, with up to 90 seconds for policy execution. Each successful preset produces a single JSON line of at most 128 KiB in tenant `plow-activity`, labeled `plow_source="activity_summary"` and `period="24h"` or `period="7d"`. The version 1 envelope carries `period`, `cutoffMs`, `publishedMs`, `revision`, and `report`. Its Loki timestamp is the publication clock, and `report.cutoff` retains the measured source watermark. The revision is a hex SHA-256 digest of the encoded `{period,cutoffMs,report}` content. Replaying the same content preserves the revision and gets a fresh publication clock.

A completed partial read can publish with its coverage gaps. Read and policy failures produce no new envelopes. Each preset is written independently, and a rejected write leaves the preceding successful envelope available. A failed refresh returns a nonzero exit status and reports the error on stderr. The command performs no cleanup of previous envelopes.

Set `PLOW_TEST_POLICY_COMMAND` to a compiled wrapper and optionally `PLOW_TEST_REFRESH_BINARY` to the standalone producer, then run `go test -v -run TestActivityRefresh ./...`. The test uses isolated Loki HTTP fixtures to exercise page splitting, overview parity at retained-shaped volume, same-cutoff backfill, replay, source warnings and rejected refreshes.
