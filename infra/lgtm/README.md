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

## Private Clanker deployment

Deploy a pinned source revision from a durable release directory. Preserve Git file modes with `git archive REV | tar -xp -C RELEASE_DIRECTORY` so nonroot containers can read the mounted configuration. Set a private, persistent runtime directory as `PLOW_LGTM_WORKDIR`. Seed its `spool/codex.jsonl` and `spool/t3.jsonl` with bounded, allowlisted records. Keep the directory mode at 0700. Leave the old stack and unrelated Serve routes in their own projects.

```sh
export PLOW_LGTM_WORKDIR=/private/plow/runtime
export PLOW_TAILNET_VIEWER=viewer@example.invalid
export PLOW_TAILNET_HTTPS_PORT=19480
export PLOW_GRAFANA_PORT=19481
export PLOW_TAILNET_SUDO=true
bash infra/lgtm/deploy.sh
```

The deployment publishes Grafana on the configured loopback port in the `plow-grafana` Compose project. Its dedicated Tailscale Serve HTTPS endpoint forwards the authenticated tailnet identity to Grafana. Grafana admits only preprovisioned identities. The script creates or confirms the requested Viewer and leaves the random bootstrap administrator credential in the private runtime directory. Choose ports unused by other services. It keeps Loki, Tempo, Mimir, and Alloy on loopback. Follow the returned URL from a device signed in as the Viewer.

Reapply with the same runtime directory and environment to retain the volumes and the Viewer. To stop serving just this endpoint, use `tailscale serve --https="$PLOW_TAILNET_HTTPS_PORT" off`. To stop the Compose project while preserving telemetry, run `docker compose -p plow-grafana stop` from the deployed release directory with the same runtime environment. Verify Grafana's authenticated `/api/user` returns the intended read-only identity and query the imported run with its original time range.

The [GitHub collector deployment](../../collect/github/README.md#compose-deployment) adds continuous polling and historical backfill when supplied with a repository-scoped credential. Use `bash infra/lgtm/deploy.sh --github-only` for worker-only activation or set `PLOW_GITHUB_ENABLED=true` to include it when reapplying the whole stack.

### Host and capture aliases

Set these independent mappings in the same private Compose environment used for reapply. Use stable, non-sensitive aliases. For production, set a unique host alias for each measured host in the Mimir deployment and keep one writer per alias. Preserve the alias for the same host across container recreation.

| Measured or captured source | Compose input | Published alias |
| --- | --- | --- |
| Linux Docker host supplying the read-only `/proc/stat` and `/proc/meminfo` binds | `PLOW_HOST_ALIAS`, defaults to `loopback-fixture` for local candidates | Mimir `plow_host` and `instance` on the allowlisted node metrics |
| Configured Codex sessions and archives | `PLOW_CODEX_SCOPE` | Codex capture and health scope |
| Configured T3 endpoint | `PLOW_T3_SCOPE` | T3 capture and health scope |

Host aliases use 1–64 ASCII letters, digits, underscores or hyphens and start with a letter or digit. The host scrape drops samples with an invalid alias. The Compose binds refer to the machine running the Docker daemon. On Clanker, verify the daemon host, compare the CPU counters and RAM total with that host's procfs, and check fresh samples under the configured alias. `PLOW_HOST_PROCFS` points Alloy at the directory holding those two files and is set by Compose.

Capture scope identifies an input. T3 may report remote work, and Codex archives may have been copied from elsewhere. Equal aliases or overlapping timestamps cannot establish the execution host. Run context requires a verified source and execution host plus a UTC run window covered by that host's samples. Plow currently displays the host series separately. Keep private alias values and any source attestations outside Git.

New samples carry `plow_host_source="host-proc"`. Existing samples remain queryable in Mimir under their original labels. The host charts require the explicit procfs source, so they start when the new scrape first writes samples. The existing Mimir writer and Loki and Tempo routing continue unchanged.

### Optional Codex trace fan-out

The `codex-trace-fanout` Compose profile adopts an existing standalone Codex Collector. Its pinned image adds Alloy as a second destination after the legacy authenticated input and redaction pipeline. The original Codex listener, evidence receiver, and credentials are reused.

Set these inputs in the private deployment environment. Set `PLOW_TEMPO_ALLOY_PORT` to a free fixed IPv4 loopback port distinct from the source and evidence ports. Reapply the LGTM stack without enabling the profile to publish Alloy on that port. Confirm the mapping with `docker compose -p plow-grafana port alloy 4318`.

- `PLOW_CODEX_TRACE_BASE_CONFIG` is the absolute path to the exact legacy `otelcol.yaml` from a verified, retained release. Keep this pinned at every reapply.
- `PLOW_CODEX_TRACE_ENV_FILE` is the absolute path to a private mode-0600 env file containing `PLOW_CODEX_OTLP_TOKEN`, `PLOW_OTLP_EVIDENCE_TOKEN`, and the existing `PLOW_CODEX_OTLP_PORT` and `PLOW_OTLP_EVIDENCE_PORT` values. Inject credentials through the existing secret store.
- `PLOW_LGTM_RESTART=unless-stopped` enables restart after a host reboot or process failure.

Validate the merged configuration before changing who owns the source port. Run these commands with the same Compose files, project and environment used for the LGTM deployment.

```sh
docker compose -p plow-grafana run --rm --no-deps codex-trace-fanout \
  validate --config=/etc/plow.yaml --config=/etc/plow-fanout.yaml
```

The overlay preserves the original `otlp_http` exporter in the traces pipeline. Check the pinned base exporter list before changing the base version. At the authorized cutover, stop the standalone Collector, retain its configuration for rollback, then start the tracked service with `docker compose -p plow-grafana up -d --no-deps codex-trace-fanout`. Only one Collector can bind the original port. The evidence receiver stays running. Check a fresh authenticated Codex export in both sinks and compare the exact span identity and clocks. Reapply the same command on future releases, or persist `COMPOSE_PROFILES=codex-trace-fanout` with these inputs in the deployment environment after adoption. To roll back, remove the profile from that environment, stop the Compose service with `docker compose -p plow-grafana --profile codex-trace-fanout stop codex-trace-fanout`, and restart the original Collector on its existing port.

See the [Codex trace guide](../../grafana/traces.md) for the Viewer routes, receipt metric and coverage limits.

[Collection Health](../../grafana/collection-health.md) uses a separate Loki tenant for allowlisted progress reports and the existing Mimir data source for Alloy self-metrics.
Activity reads evidence in bounded windows up to eight days. The single-node
candidate splits Loki range reads by day. Hourly query splitting multiplied
each panel's source reads into hundreds of subqueries and delayed short
run-detail reads during range changes. The query split is independent of the
hourly event streams used for late historical inserts.
