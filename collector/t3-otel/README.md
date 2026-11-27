# Durable T3 Code trace intake

Run one Compose project per trusted T3 server instance. The project runs a traces-only OTLP HTTP Collector and a single SQLite writer. It uses the [Codex Collector's pinned Contrib build and HTTP bearer pattern](../codex/otelcol.yaml) with its own receiver, exporter, credentials, volumes and Bend2 evidence policy. Host ingress binds to loopback. The SQLite writer accepts the Collector's backend credential on a private Compose network and has no published port.

## Configure a candidate

From the repository root, export these settings or put them in a private Compose environment file and pass it with `--env-file`.

| Setting | Value |
| --- | --- |
| `PLOW_T3_INSTANCE` | Stable operator-assigned ID, up to 128 ASCII letters, digits, colons, underscores or hyphens, starting with a letter or digit |
| `PLOW_T3_OTLP_PORT` | Free loopback host port, default `4319` |
| `PLOW_T3_INGRESS_SECRET_FILE` | Absolute path to a file containing a single T3 client bearer |
| `PLOW_T3_BACKEND_SECRET_FILE` | Absolute path to a file containing a single Collector-to-writer bearer |

Generate two distinct random secrets of at least 32 URL-safe characters and use credentials unique to the instance. Store each in a private directory outside the checkout. The bind-backed Compose secrets preserve host file permissions. Set each file to mode `0400` with ownership readable by container UID `10001`, taking Docker's user namespace mapping into account. The backend expects 32–256 ASCII letters, digits, underscores or hyphens. The settings contain file paths and the trusted instance label. Pass token values only through their files and the T3 exporter's private configuration.

```sh
docker compose -p plow-t3-candidate -f collector/t3-otel/compose.yaml config -q
docker compose -p plow-t3-candidate -f collector/t3-otel/compose.yaml up -d --build
docker compose -p plow-t3-candidate -f collector/t3-otel/compose.yaml ps -a
```

The candidate build verifies the compiler against the repository's pins and compiles [the Bend2 policy](../../evidence/storage/t3-otel.bend) on writer startup. The init service prepares mode-`0700` data directories on the project-scoped local volumes. The writer opens SQLite with mode `0600`. Keep the same Compose project name, volumes and instance ID across upgrades. Use a fresh project and fresh volumes for a different instance. Recreate with `up -d --build` or `down` followed by `up -d`. Removing volumes erases stored observations and pending work. Keep both volumes private and monitor free space on their Docker host.

## Connect a T3 instance

Set these variables in the T3 **server** environment. The URL is the full traces endpoint. Set the bearer using the T3 server's secret configuration.

```sh
T3CODE_OTLP_PROTOCOL=http/json
T3CODE_OTLP_TRACES_URL=http://127.0.0.1:4319/v1/traces
T3CODE_OTLP_HEADERS=authorization=Bearer%20<INGRESS_TOKEN>
```

The literal loopback URL applies to a same-host candidate. A remote server needs an approved encrypted route to the T3 listener, with the trace path and Authorization header preserved. Use a separate upstream for T3 in the existing Collector routing scheme and keep any existing Codex endpoint and bearer scoped to Codex. Leave the T3 logs and metrics export URLs unset. The intake uses authenticated HTTP only and needs no access to client files, state databases or provider rollouts.

## Admission and recovery

The Collector selects `service.name=t3code-server` and the observed operations `orchestrationV2.dispatch.once`, `orchestrationV2.dispatch.withReceipt`, `orchestrationV2.dispatch.threadCreate`, `server.startup` and `server.shutdown`. It drops events, links, trace state, status text and unapproved resource, scope and span attributes before queuing. The allowed span attributes are UUID-shaped T3 thread and command IDs and the exact command types `thread.create` and `thread.archive`. The Collector overwrites any incoming instance label with the configured label before the queue, and the writer checks the binding using Bend2. The writer validates coordinates and clocks and makes replay decisions in Bend2.

Ingress success acknowledges a filtered batch accepted by the Collector's file-backed queue. Filtered requests with no retained spans can also succeed. The queue fsyncs writes, has a capacity of 256 requests and uses one consumer with no exporter-side batch merging. Transient backend failures retry with backoff for as long as the batch is pending. A full queue or storage failure can prevent admission. The backend commits a request atomically, returns 400 for malformed evidence and 409 for conflicting evidence, and rolls back all eligible siblings in either case. These permanent rejections happen after the Collector acknowledgement and are visible as fixed messages in writer logs. Check those logs for permanent rejections or SQLite write failures. Payloads, IDs, credentials and source paths are excluded from diagnostics.

Read `t3_otel_spans` in the evidence volume's `data/evidence.sqlite` using a read-only connection. [The storage contract](../../evidence/storage/README.md#live-t3-code-traces) defines row identity and clocks.

## Verify

- Run `npm run verify -- collector` to exercise the compiled T3 and Codex policies through the HTTP writer with synthetic requests. The assertions cover separate auth and signals, instance binding, exact replay, same-batch and existing-row conflicts, invalid sibling rollback, redaction and ingest-clock preservation.
- For an isolated Compose proof, send a synthetic idle create and archive from a disposable native T3 server. Check the stored instance, trace, span, parent, thread and command IDs, command types and clock fields. Exercise the ingress with a wrong bearer and wrong signal. Send a canary in free-text fields and unapproved attributes, then check that the SQLite file, sending queue and diagnostics omit it.
- Stop only the candidate's evidence service and send a valid batch. With the receiver stopped, inspect the queue volume read-only for a known synthetic allowed ID and the absence of the canary. Restart and recreate the Collector while the receiver stays stopped. Start the receiver, submit identical replay, and check the SQLite rows and first ingest clocks. Recreate the project without deleting its volumes and compare the rows again.

The native exercise covers thread creation and archive. PR watch notification, notification-to-run linkage, provider input acceptance and real provider turns require additional evidence. Historical backfill, cross-source joins, outcome metrics and dashboards are separate work.
