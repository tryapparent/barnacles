# Loopback Grafana fixture stack

From the repository root, run the end-to-end fixture check with Docker Compose, Node 22, curl, jq and OpenSSL.

```sh
bash infra/lgtm/check.sh
```

The check creates a private temporary workspace and a unique Compose project, validates Alloy, loads the two redacted sources via Loki OTLP, queries the packaged Grafana data source, verifies a redacted OTLP span in Tempo and a host metric in Mimir, reapplies Compose, and recreates Alloy before replaying one event. It compares the exact Grafana query response with the same request from Grafana MCP using a short-lived Viewer service account. It checks the OTLP receipt counter to verify the saved file positions, and compares the normalized evidence before and after replay. It removes the test containers and volumes and prints the path to the private API responses.

To keep a candidate for inspection, start a fresh project with a fixed name of your choice.

```sh
export PLOW_LGTM_WORKDIR=$(mktemp -d /tmp/apparent-dev-plow-lgtm-XXXXXX)
project_id=${PLOW_LGTM_WORKDIR##*-}
compose() { docker compose -p "plow-lgtm-${project_id,,}" "$@"; }

node --experimental-transform-types collect/fixture.ts "$PLOW_LGTM_WORKDIR"
openssl rand -hex 24 > "$PLOW_LGTM_WORKDIR/grafana-password"
chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"

compose up -d --build --wait --wait-timeout 90
compose port grafana 3000
compose port loki 3100
```

Grafana, Loki, Tempo, Mimir and the Alloy OTLP receiver get dynamic IPv4 loopback ports. Alloy reaches Loki’s OTLP endpoint over the Compose network and sends the tenant header `X-Scope-OrgID: plow-fixture`. The header selects a tenant and local network isolation limits direct access. Grafana uses a generated password for its local `admin` account. The secret file is readable inside the Grafana container and lives under the private job directory on the host.

Grafana's database, Loki's filesystem and WAL, Tempo blocks, Mimir data, and Alloy's file offsets and pending OTLP queue use separate named volumes. Reapply the same project with the same spool and volume names. Stop it with `compose down` to retain the volumes.

Loki uses TSDB schema v13 and native OTLP ingestion. This fixture stack admits old source timestamps and queries the ingesters across the historical time range. The single-binary filesystem configuration needs both `querier.query_ingesters_within: 0s` and `ingester.query_store_max_look_back_period: -1ns` for immediate queries against old unflushed entries. The test uses one narrow source window. Plan a separate bounded backfill policy before using real inputs. [Loki ingestion limits](https://grafana.com/docs/loki/latest/configure/loki-limits/)

## Plugin and Grafana MCP

The Grafana image builds the [data source plugin](../../analyze/datasource/) and compiles the Bend2 rule before the stack starts. The image allows this single unsigned plugin for the loopback candidate. Open the [run breakdown dashboard](../../grafana/) using the displayed Grafana port.

Grafana MCP v2.3.0 does not include the Plow data source in its `run_panel_query` allowlist. The fixture uses Grafana MCP’s read-only `grafana_api_request` with `POST /api/ds/query` and the same target and time range as the dashboard. It compares the resulting data frames with Grafana’s direct result. The stack publishes no standalone MCP server. Outside the fixture, set up a Viewer account and choose the allowed tools for the Grafana instance.
