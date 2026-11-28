# Codex traces in Grafana

Open `/d/plow-codex-traces/plow-codex-traces` on the same private Grafana instance as Plow Activity. Grafana searches the provisioned `plow-tempo` data source over the dashboard’s UTC time range. The default range is two hours. It lists up to 20 recent traces with a matching redacted `plow.codex` instrumentation scope. **Span status** matches any observed span. A trace can match both **OK** and **Error**. **Unset** matches spans for which the exporter recorded no outcome. **Any status** includes all three.

Select a **Trace ID** to open the native Grafana Traces panel with the same absolute UTC window. The provisioned dashboards give the Viewer access to both views. Select a span to see its recorded status and retained identities. Use **Find by trace ID** to paste an exact hexadecimal ID and press Enter. Exact retrieval also works for retained traces outside the selected range.

The view covers emitted OTLP spans received by Tempo. Retained fields include native trace and parent/span IDs, clocks, operation names, status codes, and allowlisted conversation, turn and call identities when present. The Alloy transport removes incoming resource and scope attributes, links, trace state, free-form status text and other private fields. The provisioned search uses the normalized instrumentation name `plow.codex`.

An empty search means no matching traces in that UTC range under the selected filter. Check **Any status**, widen the range, or check collection receipts. On the detail page, Grafana 12.3 reports that a trace ID is required while the field is blank. An absent exact ID produces Tempo’s not-found message. A backend outage produces a datasource error. The native waterfall header formats its start clock in the browser timezone. The dashboard range and recent table remain in UTC. Trace timings are exporter span clocks. A tool handler’s span can end at its first yield while the process continues. See the historical run view for evidence about tool and process clocks.

## Trace Viewer input

Grafana OSS 12.3.0 recognizes a bare hexadecimal value in a provisioned `traceql` target and sends a `traceId` backend query. The provisioned datasource disables time shifting for the exact lookup. This keeps the dashboard’s UTC window visible while Grafana sends `"from":"0","to":"0"` to the query API and omits Tempo time bounds. Tempo can return an empty v2 response for a bounded lookup even when the same retained ID exists and the search found it. API consumers should send `queryType:"traceId"` and those zero time values. For Grafana MCP, use the original UTC range for `search_tempo_traces` and omit `start` and `end` for `get_tempo_trace`. [Grafana 12.3.0 frontend lookup](https://github.com/grafana/grafana/blob/v12.3.0/public/app/plugins/datasource/tempo/datasource.ts#L373-L386) [Grafana 12.3.0 backend lookup](https://github.com/grafana/grafana/blob/v12.3.0/pkg/tsdb/tempo/trace.go)

Grafana’s native Tempo decoder emits zero rows for a batch with no resource attributes. The [Alloy transform](../collect/alloy/config.txt) clears incoming resource attributes and sets the server-owned `service.name` to `plow.codex` so the Trace Viewer receives the spans. Existing Tempo records without a resource attribute require a faithful re-export or a reader that supports empty resource attributes. [Grafana 12.3.0 decoder](https://github.com/grafana/grafana/blob/v12.3.0/pkg/tsdb/tempo/trace_transform.go#L84-L91)

## Activity and run links

Link Activity to `/d/plow-codex-traces/plow-codex-traces` as **Codex traces**. A link from a run with a verified trace ID can open its exact waterfall. Use the trace’s UTC clock window in epoch milliseconds as `from` and `to`.

```text
/d/plow-codex-trace/plow-codex-trace?var-traceId=11111111111111111111111111111111&from=1748951940000&to=1748952060000
```

When only conversation, turn or call identity is verified, keep the exact trace ID **Unknown**. An operator with Explore access can use that identity and its clock window to investigate, for example with `{ instrumentation:name = "plow.codex" && span.turn.id = "22222222-2222-2222-2222-222222222222" }`. A conversation can span multiple turns and traces. An exact link requires verified run-level identity, such as an explicit run-to-trace receipt, or a verified run-to-turn binding that maps to a unique native trace in Bend2. Matching timestamps or a session association alone does not establish that identity. A Viewer without a match can use the recent traces dashboard.

## Optional live fan-out

The pinned legacy Codex Collector authenticates loopback OTLP on its existing port, minimizes incoming spans and sends them to the existing authenticated SQLite evidence receiver. The [Collector overlay](../collect/alloy/codex-collector-fanout.yaml) fans out after the same authenticated, processed traces pipeline. The secondary pipeline restores the already-allowlisted event name to Alloy’s ingress marker so Alloy’s second redaction can retain it. The original sink receives the base pipeline’s output. Adopt the Collector through the [tracked Compose profile](../infra/lgtm/README.md#optional-codex-trace-fan-out).

Check `otelcol_receiver_accepted_spans_total{job="plow-collection-alloy",receiver=~".*codex_live",transport="http"}` in Mimir. A rising counter confirms Alloy accepted spans. Verify their trace IDs and span IDs in Tempo to establish how much reached storage. A missing counter leaves receipt unobserved.

The secondary exporter queues asynchronously in memory and retries for a bounded period. An unavailable Alloy sink within that bound leaves legacy writes available. If the secondary queue fills, enqueue can fail and the Collector may return a retryable error after writing the legacy copy. Legacy writes are idempotent. A process restart or prolonged outage can leave gaps in Tempo. There is no historical replay guarantee from the live branch. The source exporter keeps using its existing authenticated listener.

## Historical coverage

Replay requires a bounded retained native OTLP export with its original IDs and clocks, or a decision to treat a verified legacy evidence projection as a partial replay. The SQLite span and event tables retain trace, span and parent IDs, clocks and allowlisted attributes. They do not preserve the complete original OTLP envelope, including span kind or discarded resource metadata. Codex rollout JSONL can corroborate turn and call identities. It cannot fill absent native trace coordinates or establish complete trace coverage.

## Verification

Run the loopback proof with Docker Compose, Node 22, curl, jq, ripgrep and OpenSSL. Use the verified existing legacy release source directory with its pinned Bend compiler and Node dependencies available, as required by its receiver. The proof uses generated credentials, a temporary SQLite evidence store and the repository’s existing LGTM stack. The test Collector listens on IPv4 loopback and neither path uses the active services.

```sh
bash verify/codex-traces.sh /path/to/verified/legacy/release/source
```

The proof builds the checked-out Grafana image and starts the tracked Collector profile with generated credentials. It checks convergence on reapply, Collector authentication, the original evidence write plus the Tempo copy, Alloy receipts, all four search filters, Viewer exact lookup, empty search, an absent trace and a Tempo outage. It replays an older synthetic native trace twice and checks the original clocks and parent link in Tempo, then verifies that the original write still succeeds while Alloy is stopped. Grafana MCP 2.3.0 uses a short-lived Viewer token against the isolated Grafana API. Proof files stay in the printed private job directory.

The dashboard JSON uses Grafana’s native provisioning format. The overlay uses the Collector’s native YAML merge format. The verification shell and Node files are test drivers for synthetic OTLP and Grafana/MCP wire I/O. These surfaces are parsed by their host runtimes and add no run-to-trace correlation policy.
