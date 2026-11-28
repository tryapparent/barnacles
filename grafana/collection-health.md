# Collection Health

Open `/d/plow-collection-health/collection-health` in the Plow Grafana instance. The dashboard uses native OSS tables, time series, logs and stats. Its wordmark, header colors and typography follow Run Breakdown.

T3 reports each successful page read even while its scan is running. The full-scan cutoff used by Activity remains a separate clock. The top table shows the latest envelope in the selected range per collector, scope and lane. T3, Codex history and GitHub can each report live and backfill independently. An empty table or missing lane means Grafana found no report in that range. Widen the range to look for an older report. A Grafana query error identifies a serving problem separately. Compare report age with the producer's configured cadence. The dashboard preserves the last reported status and applies no inferred health threshold. A successful empty poll may report `Idle` with a recent last success and zero ingested records. The newest source clock can be much older.

Coverage and progress shows the oldest source time actually scanned. Scanned and eligible refer to source units and are comparable within the same report and unit. Ingested refers to records. Unknown clocks and counts remain unknown. `Complete` means the worker exhausted available authorized history. A gap can still limit coverage. View health report history from the latest-report panel to inspect exact clocks, counts and gap codes. The history panel displays up to 100 reports. Retrying and blocked history counts status reports per interval, including reports about the same incident.

Alloy self-scrape requires a sample in the last 45 seconds at the selected range end. No recent sample can mean Alloy or the Mimir path is unavailable. The health exporter queue covers just the health Loki writer. Live Codex OTLP spans count receiver activity since Alloy started, and are independent of the Codex history collector. The receipt-rate chart uses the same sampled receiver counter. Receiver activity has no source completeness denominator and does not establish delivery to Tempo.

## Host context

The bottom of Collection Health shows CPU non-idle and RAM in use by [configured host alias](../infra/lgtm/README.md#host-and-capture-aliases). Both plots use the dashboard's selected UTC range. CPU uses a one-minute idle-counter rate across logical CPUs and includes I/O wait and steal time in the non-idle share. RAM uses Linux's available memory estimate. Both require samples within 15 seconds of each plotted time. Empty charts can indicate a time range before host collection or a gap in the scrape. Run attribution remains unknown.

## Status spool contract

Publish append-only JSONL or atomic immutable chunks matching `/spool/health/*.jsonl`. Choose a unique prefix for each writer. Use an operator-selected, stable, non-sensitive `scope` alias of up to 64 letters, numbers, spaces, underscores or hyphens, starting with a letter or number. Keep source IDs, repositories, paths, raw errors, URLs and private content out of the spool. Each worker owns its source decisions and validates its own allowlisted `gapCode`. Gap codes are short tokens using letters, digits, underscores or hyphens.

| Field | Value |
| --- | --- |
| `kind`, `schemaVersion` | `collector_health`, integer `1` |
| `collector` | `t3`, `codex_history`, `github` |
| `scope`, `lane` | Safe alias, `live` or `backfill` |
| `status` | `working`, `idle`, `retrying`, `blocked`, `complete` |
| `observedMs` | Positive UTC epoch milliseconds for the report itself |
| `lastSuccessMs`, `newestSourceMs`, `oldestScannedMs` | Source clocks in UTC epoch milliseconds or null |
| `scannedUnits`, `eligibleUnits`, `ingestedRecords` | Counts or null |
| `scanProgress` | Producer-calculated share of eligible units scanned, rounded down to one decimal. Empty when no positive denominator is known. |
| `unit` | `thread`, `session`, `page`, `attempt`, or `record`. Required when a scanned or eligible count is supplied. |
| `gapCode` | Optional worker-allowlisted token |

Use a single writer for each collector, scope and lane stream. Emit distinct `observedMs` values for different snapshots within that stream. Backfill snapshots use the current observation clock even if their source watermarks are historical. Loki indexes these envelopes in one health stream. Its normal out-of-order acceptance window applies to delayed snapshots across all writers. Replaying the identical snapshot preserves its selection and does not advance its time. Replay outside the acceptance window requires an isolated rebuild or a separate operator-controlled migration.

The Alloy module projects the status envelope fields, guards their wire types and routes them over OTLP with `observedMs` as Loki's event time. Source clocks and counts stay in the JSON body. Loki queries retrieve the newest encoded envelope in each series in the dashboard time range, keeping all fields from that one snapshot. Grafana formats the fields and displays the reported values. Source coverage and gap decisions belong to the producing workers and their Bend2 policies.

## Compose integration

The [Compose service](../infra/lgtm/compose.yaml) mounts the [health module](../collect/alloy/collection-health.txt). The [Alloy entry point](../collect/alloy/config.txt) instantiates its receiver and self-scrape. The existing read-only spool mount covers the health subdirectory. Keep the Alloy storage volume for file positions and the export queue.

The provisioned native Loki datasource is pinned to `plow-collection-health`. Keep Loki tenant authentication enabled. Use the existing Grafana provisioning mounts and keep the raw-evidence tenant off this native datasource. The self-metrics fragment uses the existing Mimir writer. It adds no listener or host port.

The exact-path exceptions cover the native Grafana JSON and datasource schema, the Alloy transport and self-scrape module, and thin synthetic Docker/Grafana verification. Grafana and Alloy consume their own provisioning formats. The test fixture describes reported values and checks rendered query outputs.

## Verify

Run `GOMAXPROCS=2 bash verify/collection-health.sh` with the baseline Compose Grafana image built. The check uses a new Compose project with loopback ports and a private spool. It compares the actual provisioned dashboard query frames, tests tenant isolation and replay across an Alloy restart, and requests the same frames through Grafana MCP. Loki execution-time statistics vary by request and are excluded from the parity comparison. The snapshot read gives empty numeric labels the display value `Unknown` before Grafana converts them. That preserves missing values alongside real zeroes. The optional command arguments run a local verification command before isolated cleanup. The script appends the private evidence directory and Grafana base URL to that command.

The [GitHub collector](../collect/github/README.md) publishes reports for both lanes when enabled. Missing reports can indicate a disabled or unavailable producer.
