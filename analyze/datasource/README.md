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

Both reads use `GET /loki/api/v1/query_range` and the selected Grafana range, capped at seven days. Loki entry timestamps must correspond to the source clock so the same time range finds the run record and its evidence. The plugin extracts `run.id` from JSON under `plow_source="t3"` and `sessionId` under `plow_source="codex_history"`. Run and session IDs are 1–128 characters and use letters, digits, dots, underscores, hyphens, or colons, starting with a letter or digit. The two queries request up to 100 run records and 2,000 session events respectively. A datasource request accepts up to eight targets and has a 12-second deadline. Each Loki call and policy invocation has a four-second timeout and a 4 MiB reply cap. See the [Loki HTTP API reference](https://grafana.com/docs/loki/latest/reference/loki-http-api/#query-logs-within-a-range-of-time).

The CLI accepts a single run record. Identical copies of its input fields can populate that slot once. Conflicting copies or a run lookup with warnings or a saturated cap fail the query because the plugin cannot assemble an unambiguous input. The plugin forwards each decodable session event, including replay copies, for Bend2 to assess. Malformed session records, Loki query warnings, a saturated session cap, and a range that clips the run appear as partial source coverage. Successful source coverage describes this bounded read. The datasource cannot verify upstream retention or records that never reached Loki.

| Frame | Columns |
| --- | --- |
| `intervals` | `callId`, `kind`, `startMs`, `endMs`, `durationMs` |
| `findings` | `callId`, `reason` |
| `coverage` | `runId`, `events`, `paired`, `unknown`, `sourceComplete`, `sourceGaps` |

The policy can report unknown intervals even when the bounded read completed. Table panels can use the frame names to choose which rows to display. Grafana MCP consumes the same panel query response.
