# Codex traces in Grafana

Open `/d/plow-codex-traces/plow-codex-traces` on the same private Grafana instance as Plow Activity. Grafana searches the provisioned `plow-tempo` data source over the dashboard’s UTC time range. The default range is two hours. It lists up to 20 recent traces with a matching redacted `plow.codex` instrumentation scope. **Span status** matches a status on any observed span. A trace can match both **OK** and **Error**. Select a **Trace ID** to open the native Grafana Traces panel over the selected range. Provisioned dashboards give the tailnet Viewer access to both views. Select a span to see its recorded status and retained identities. Use **Find a Trace ID** to paste a hexadecimal ID and press Enter. For an older trace, set the detail dashboard’s range to include its span clocks.

The view covers emitted OTLP spans received by Tempo. Retained fields include native trace and parent/span IDs, clocks, operation names, status codes, and allowlisted conversation, turn and call identities when present. The Alloy transport removes incoming resource and scope attributes, links, trace state, free-form status text and other private fields. The provisioned search uses the normalized instrumentation name `plow.codex`.

Missing spans or empty searches can reflect exporter configuration, partial instrumented coverage, ingest availability, retention, or the selected filters and range. Trace timings are exporter span clocks. In particular, a tool handler’s span can end at its first yield while the process continues. See the historical run view for evidence about tool and process clocks.

## Trace Viewer input

Grafana OSS 12.3.0’s native Tempo trace decoder emits zero rows for a batch with no resource attributes. The [Alloy transform](../collect/alloy/config.txt) clears incoming resource attributes and sets the server-owned `service.name` to `plow.codex` so the Trace Viewer receives the spans. Existing Tempo records without a resource attribute require a faithful re-export or a reader that supports empty resource attributes. [Grafana 12.3.0 decoder](https://github.com/grafana/grafana/blob/v12.3.0/pkg/tsdb/tempo/trace_transform.go#L84-L91)

## Activity and run links

Link Activity to `/d/plow-codex-traces/plow-codex-traces` as **Codex traces**. A link from a run with a verified trace ID can open its exact waterfall. Use the trace’s UTC clock window in epoch milliseconds as `from` and `to`.

```text
/d/plow-codex-trace/plow-codex-trace?var-traceId=11111111111111111111111111111111&from=1748951940000&to=1748952060000
```

When only conversation, turn or call identity is verified, keep the exact trace ID **Unknown**. An operator with Explore access can use that identity and its clock window to investigate, for example with `{ instrumentation:name = "plow.codex" && span.turn.id = "22222222-2222-2222-2222-222222222222" }`. A conversation alone can span multiple turns and traces. Require a verified unique mapping in Bend2 before claiming an exact run match. A Viewer without a match can use the recent traces dashboard. Historic JSONL can corroborate identities where its schema supports them. Trace coordinates originate from native OTLP.

## Optional live fan-out

The pinned legacy Codex Collector authenticates loopback OTLP on its existing port, minimizes incoming spans and exports them to the existing authenticated SQLite evidence receiver. The [Collector overlay](../collect/alloy/codex-collector-fanout.yaml) fans out after the **same** authenticated, processed traces pipeline. The secondary pipeline restores the already-allowlisted event name to Alloy’s ingress marker so Alloy’s second redaction can retain it. The original sink receives the base pipeline’s output. Add it only to the separate legacy Collector deployment. Preserve the base config, image, host-network mode, env file, credentials and receiver. The Alloy input must remain bound to the host’s IPv4 loopback.

1. Set `PLOW_TEMPO_ALLOY_PORT` to the same free, fixed numeric value for the Grafana Compose deployment and the legacy Collector. The Compose mapping binds only to IPv4 loopback and defaults to an ephemeral port when fan-out is disabled.
2. Mount the overlay read-only at `/etc/plow-fanout.yaml` and add `--config=/etc/plow-fanout.yaml` after `--config=/etc/plow.yaml` on the Collector command. Before applying, validate the merged config with Collector 0.166.0 against the exact proposed base and environment. The overlay replaces the traces exporter array and explicitly retains `otlp_http`. Recheck that list if the legacy base adds or renames exporters.
3. Verify fresh Codex OTLP arriving at both outputs and retrieve one observed trace by exact ID on the private Grafana route. Compare the span identity and clock window to the legacy evidence. If routing needs to be reverted, remove the second config argument and overlay mount from the owning deployment and reapply the original service definition.

The secondary exporter queues asynchronously in memory and retries for a bounded period. An unavailable Alloy sink within that bound leaves legacy writes available. If the secondary queue fills, enqueue can fail and the Collector may return a retryable error after writing the legacy copy. Legacy writes are idempotent. A process restart or prolonged outage can leave gaps in Tempo. There is no historical replay guarantee from the live branch. The source exporter keeps using its existing authenticated listener.

## Verification

Run the loopback proof with Docker Compose, Node 22, curl, jq, ripgrep and OpenSSL. Use the verified existing legacy release source directory with its pinned Bend compiler and Node dependencies available, as required by its receiver. The proof uses generated credentials, a temporary SQLite evidence store and the repository’s existing LGTM stack. The test Collector listens on IPv4 loopback and neither path uses the active services.

```sh
bash verify/codex-traces.sh /path/to/verified/legacy/release/source
```

The proof checks Collector authentication, the original evidence write plus the Tempo copy, exact Grafana trace search and lookup, synthetic canary removal, and the original write while Alloy is stopped. Grafana MCP 2.3.0 uses a short-lived Viewer token against the isolated Grafana API. Proof files stay in the printed private job directory.

The dashboard JSON uses Grafana’s native provisioning format. The overlay uses the Collector’s native YAML merge format. The verification shell and Node files are test drivers for synthetic OTLP and Grafana/MCP wire I/O. These surfaces are parsed by their host runtimes and add no run-to-trace correlation policy.
