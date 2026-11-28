# Greenfield Plow on Grafana Architecture Plan

## Value stream

Plow has one value stream, **agent observability**. It turns evidence from a coding-agent run into an explanation a developer or agent can use to decide what to investigate next. The first useful outcome is an evidence-backed answer to “What slowed down this run?” delivered in Grafana and through Grafana MCP.

Collection, analysis, dashboards, and deployment are responsibilities within that stream. A typical feature such as identifying long tool waits should have one owner from source evidence through the finding a user sees. Adding another telemetry source does not create another stream.

## Proposed greenfield repository

```text
ARCHITECTURE.md
compose.yaml
collect/
  alloy/
  t3/
analyze/
  policy/
  datasource/
grafana/
  dashboards/
  provisioning/
verify/
infra/
  lgtm/
```

| Location | Owns |
| --- | --- |
| `collect/alloy/` | Host collection config, disclosure controls, source identities, and OTLP routing. Use Alloy for retained Codex JSONL, live spans, and host metrics. |
| `collect/t3/` | A small T3 protocol adapter for historical cursors, checkpoints, run clocks, and native session bindings. Emit normalized evidence to Alloy. Native OTLP can use Alloy directly wherever T3 exports the required facts. |
| `analyze/policy/` | The Plow algorithm written in Bend2. Own call/result pairing, run attribution, replay identity, coverage, overlap policy, and bottleneck ranking. |
| `analyze/datasource/` | A Grafana backend data source plugin. Its thin host code reads bounded Loki, Tempo, and Mimir queries, invokes the compiled policy, and returns Grafana data frames. Ship this as the Grafana integration for Plow’s analysis. |
| `grafana/` | Plow dashboards, data source provisioning, and named panel queries that Grafana MCP can run. Provision dashboard and MCP access through Grafana. |
| `verify/` | Synthetic evidence and end-to-end tests for the stream, including the rendered panel and the matching MCP result. |
| `compose.yaml` and `infra/lgtm/` | Compose is the deployment entry point. Infra owns runtime topology, pinned images, configuration, storage, network policy, and secret references. It contains no evidence or ranking rules. |

Grafana-native means Grafana owns query execution, dashboards, and agent access. Loki, Tempo, and Mimir are the durable telemetry stores. The Plow-specific logic runs behind Grafana’s backend plugin interface. The target starts with **self-managed Grafana** so we can install the Plow plugin directly. Grafana Cloud would require publishing the plugin through its catalog or using a different integration. The plugin SDK’s Go host code requires an explicit exact-path exception under the current repository rules. Keep the product decisions in Bend2. [Grafana plugin backend](https://grafana.com/developers/plugin-tools/key-concepts/backend-plugins) · [Grafana Cloud plugin constraints](https://grafana.com/docs/grafana-cloud/observe-and-act/connect-externally-hosted/data-sources-in-cloud/)

## Data flow

```text
Saved Codex rollout events ──→ Alloy ──→ Loki
T3 API → T3 history adapter ─→ Alloy ──→ Loki
Live Codex OTLP spans ───────→ Alloy ──→ Tempo
Host CPU / RAM ──────────────→ Alloy ──→ Mimir

Grafana dashboard ──┐
Grafana MCP ────────┴─→ Grafana query → Plow data source plugin
                                             ↓
                                  Read Loki / Tempo / Mimir
                                             ↓
                                     Bend2 finds delays
                                             ↓
                             Findings, coverage, source links
```

Preserve workspace, source, session, run, and event identities where supported. In Loki, keep per-run, per-session, and per-call identifiers in structured metadata. Preserve original source timestamps separately from ingestion time. Validate the historical backfill against the configured Loki age and stream ordering limits. Keep prompts, arguments, command output, and raw rollouts on the source host. Use scoped credentials and tenant-aware queries. Attribute host metrics only to the verified host and measurement window. [Alloy routing](https://grafana.com/docs/alloy/latest/collect/opentelemetry-to-lgtm-stack/) · [Loki structured metadata](https://grafana.com/docs/loki/latest/get-started/labels/structured-metadata/) · [Loki ingestion limits](https://grafana.com/docs/loki/latest/configure/loki-limits/)

## Build order

1. **Prove the evidence input.** Start a fresh self-managed Grafana candidate through Compose. Replay one synthetic Codex rollout through Alloy into Loki alongside a synthetic T3 run and session binding. Prove private fields are dropped, original clocks survive, and replay preserves identity. The earlier Alloy v1.22.0 proof sent four filtered historical events to a local OTLP receiver and picked up one new event after restart. Loki ingestion and secure delivery still need verification. Add the smallest T3 reader needed to verify the route with one authorized historical run.
2. **Prove the analysis in Grafana.** Add one Plow data source query and one run breakdown panel. Verify a known two-second tool interval, a missing result shown as unknown, and the same output after duplicate replay at a fixed source cutoff. Reject ambiguous run assignments. Exercise the actual panel and compare it with the same data source query through Grafana MCP. The pinned MCP release handles the Plow plugin through its read-only Grafana API tool. [Grafana MCP panel queries](https://grafana.com/docs/grafana/latest/ai-tools/mcp/guides/run-a-dashboard-panel-query/)
3. **Extend the same user journey.** Add Tempo overlap reconciliation, Mimir host context, and then a seven-day bottlenecks view. Distinguish elapsed gaps, admission waits, provider execution, and observed CI activity. Unclassified elapsed time describes coverage. Treat overlap with high host utilization as context.
4. **Keep the greenfield tree small.** The target tree consists of the new Grafana path. The former React dashboard, SQLite evidence path, custom MCP server, and deployment wiring are available in Git history. Carry forward proven decisions and synthetic fixtures selectively. There are no users, compatibility requirements, or data to migrate.

Pin dependency images and plugin builds. Track dashboards, data source configuration, volumes, access policies, and secret references. The first implementation should supply one reproducible command that starts the loopback candidate and exercises the fixture through the real data source. Verify that reapplying Compose preserves the candidate’s data and creates no duplicate resources.

The implemented loopback stack is documented in [the verification guide](infra/lgtm/README.md). Tempo and Mimir ingestion are exercised separately from the historical run calculation. Live/history reconciliation, host attribution in the analysis, and weekly ranking remain future stages.
