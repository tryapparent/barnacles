# Live Codex traces

Plow can receive native OTLP/HTTP traces from an opted-in Codex client. OpenTelemetry Collector authenticates the sender and minimizes the payload before forwarding it to the Plow evidence receiver. The receiver commits the allowed span and event facts to the existing private SQLite evidence store. Node 22.18 or later and the pinned upstream Collector run on the Plow host. The client uses Codex's exporter.

## Run a local receiver

Use a private job directory and two distinct secrets from your runtime's secret store. Set `PLOW_OTLP_EVIDENCE_TOKEN` to a secret of at least 32 characters in the environment of both processes. Set `PLOW_CODEX_OTLP_TOKEN` in the Collector environment and share that separate token with the authorized Codex client. Run from the repository root.

```sh
job=$(mktemp -d /tmp/apparent-dev-plow-codex-otel-XXXXXX)
node collector/codex/otel.ts "$job" pilot-codex
```

In another terminal on the same Linux host, run the pinned Collector. It uses the host network to reach the evidence receiver on loopback.

```sh
image=otel/opentelemetry-collector-contrib:0.166.0@sha256:3e18fe04181de50bdd72e23ad4a4d6214b54351e63d496f1c58127cc4541ad7f
docker run --rm --network host \
  -e PLOW_CODEX_OTLP_TOKEN -e PLOW_OTLP_EVIDENCE_TOKEN \
  -e PLOW_CODEX_OTLP_PORT -e PLOW_OTLP_EVIDENCE_PORT \
  -v "$PWD/collector/codex/otelcol.yaml:/etc/plow.yaml:ro" \
  "$image" --config=/etc/plow.yaml
```

The listeners default to `127.0.0.1:4318` for the Collector and `127.0.0.1:4320` for the evidence receiver. Override them with `PLOW_CODEX_OTLP_PORT` and `PLOW_OTLP_EVIDENCE_PORT`. The instance argument is server configuration. Run a separately credentialed Collector and evidence receiver for each isolated workspace and give each workspace its own evidence directory. For an authorized remote deployment, put a TLS proxy in front of the Collector's trace endpoint and keep the evidence receiver on loopback. This configuration supplies one receiver credential per instance.

## Configure Codex

Add these settings to the intended Codex profile. For localhost testing, use the local Collector URL. For remote collection, use the HTTPS URL from the Plow operator. Replace the illustrative header with the Collector token and keep that credential private.

```toml
[otel]
exporter = "none"
metrics_exporter = "none"
log_user_prompt = false

[otel.trace_exporter.otlp-http]
endpoint = "http://127.0.0.1:4318/v1/traces"
protocol = "json"

[otel.trace_exporter.otlp-http.headers]
Authorization = "Bearer <collector-token>"
```

## Evidence and coverage

The Collector removes resource and scope attributes, schema URLs, span links, trace state and free-form status text. It retains exact span coordinates. Unrecognized span names become `codex.span` so their parent links survive. The retained attributes are format-checked conversation, turn and tool-call identifiers, plus numeric reported event duration and a success flag on selected events. Prompts, arguments, output, paths, thread names and arbitrary event names are excluded. The evidence receiver applies the Bend2 admission policy to the projected fields again before writing.

Inspect `codex_otel_spans` and `codex_otel_span_events` in `$job/evidence.sqlite`. Span start, span end and event observation are distinct provider-reported nanosecond clocks. Reported event duration is separate. In particular, a Codex handler or tool result can stop timing at the first yield while the process continues. Terminal process time remains unknown from this import. Parent spans may arrive later or be absent from the sender's coverage. OTLP push has no historical backlog guarantee. Existing rollout import remains available for local history and corroborated async completion. No delivery join or timeline projection is established by an OTLP identifier alone.

The receiver commits each valid request in one SQLite transaction. An identical replay is idempotent. An invalid observation or a conflicting replay aborts the request, retaining the previous evidence. An unavailable SQLite writer returns a retryable response. The upstream Collector retries transient failures within its configured bound and keeps no persistent export queue. Stop-and-restart retention depends on the sender, so absence of a span does not establish absence of activity.

## Verify

Run `npm run verify -- collector` or the focused `node --test collector/codex/otel.test.ts`. The test runs the evidence receiver and compiled Bend2 policy over loopback, checks unauthorized and wrong-signal requests, and verifies exact clocks, replay, rollback and omission of synthetic private content. To validate the Collector configuration, run the Docker command above with `validate` before `--config=/etc/plow.yaml`. The native 0.171.0 Codex exporter and Collector 0.166.0 were exercised with a synthetic loopback provider. Other Codex builds and remote tenant provisioning need their own acceptance checks.
