# Retained Codex trace replay

The one-shot CLI reads the verified legacy Codex OTLP SQLite projection for a single source instance. It writes only the selected traces to an explicitly supplied Tempo destination. Dry-run is the default and requires only the source and a private JSON manifest. There is no scheduled job or deployment profile.

The pinned live Collector emits through the original SQLite receiver and the optional Tempo fan-out. The inspected archive had the receiver's span and event tables and no separate native-export file. A native export, if retained elsewhere, should go through the existing OTLP redaction path using its original envelope. This CLI is for the SQLite schema only. It does not derive trace coordinates from rollouts or import Tempo block files.

## Manifest and dry-run

Keep the manifest, source and checkpoint files private. Use a read-only snapshot of the verified source when possible. Select exact trace IDs for one instance from the source evidence. Use decimal Unix nanoseconds as strings and record the independently verified first possible live fan-out clock in `liveSinceNs`.

```json
{
  "instance": "fixture",
  "fromNs": "1748951940000000000",
  "toNs": "1748952070000000000",
  "liveSinceNs": "1748952080000000000",
  "traceIds": ["11111111111111111111111111111111"]
}
```

```sh
node collect/trace-replay/main.ts --source "$archive" --manifest "$manifest"
```

The window is half-open, at most 24 hours, and ends at or before the cutover. Each run admits up to 32 distinct native trace IDs. The SQLite reader uses the composite keys and takes one read transaction. Each candidate has a limit of 512 spans and 2,048 events. A trace with a retained span or event outside the window is skipped in full. The CLI reports the ordinal and counts for each candidate. A source-absent result means that exact ID was unavailable for the specified instance.

## Apply and recovery

Use one checkpoint directory per Tempo destination. Create it with mode 0700 and retain it for the replay and any recovery. Use direct Tempo OTLP and exact-query endpoints owned by the same Tempo instance and bound to IPv4 loopback in the CLI's network namespace. The existing Tempo config enables both listeners in its own container. Alloy's asynchronous relay is for live traffic. Replay needs the direct recipient so an HTTP response and a follow-up exact lookup describe the same write, and the historical provenance stays attached.

```sh
node collect/trace-replay/main.ts --source "$archive" --manifest "$manifest" \
  --apply --quiescent --query "$tempo_query" --ingest "$tempo_otlp" --checkpoint "$checkpoint"
```

Before using `--quiescent`, confirm that no other writer, including a live queue or native archive replay, can submit any selected trace ID during this run. Use finished, historical traces from before fan-out, and account for delayed exports. A clock window alone cannot rule out an old span previously queued for export. Tempo's exact lookup and ingest are separate operations, so writer exclusion is required for the selected IDs. The private checkpoint writer lock serializes CLI processes sharing the checkpoint.

Replay looks up the entire exact trace ID before each send. Any previously stored trace under that ID is skipped, even if Tempo contains just one live span. The tool stores a pending checkpoint before POST, then requires a successful receipt and exact lookup of the expected span identities and provenance before marking it done. The checkpoint binds the endpoints and keeps a digest of the redacted payload. Confirmed replays are skipped on subsequent runs. Changes to the redacted source payload stop the run.

After an ambiguous failure, rerun the same manifest against the same checkpoint. A complete replay found by exact lookup confirms the pending item without another POST. A conflicting or incomplete trace stops recovery. If a pending trace is absent, use `--retry-pending` only after confirming Tempo is healthy and that the earlier request finished without leaving a delayed write. A lookup failure or partial result stops before POST. Successful earlier items remain checkpointed if a later item fails.

## Coverage and wire format

The source is an allowlisted projection of spans that reached the legacy receiver. Transport adds normalized service and scope names, plus the server-owned resource attributes `plow.replay.source=legacy-sqlite` and `plow.replay.coverage=partial`. Original trace, span and parent IDs and nanosecond clocks are preserved. A retained parent ID can refer to an unavailable span. Allowlisted span and event names, identities, event facts and recorded nonzero status codes survive. The transport omits absent or unretained span kind, resource metadata, links, flags, status text and other envelope fields. A retained zero status stays unset. It provides no denominator for full historical coverage.

The [Bend2 policy](policy.bend) owns evidence bounds, validation, redaction, coverage, and replay decisions. The [host adapter](main.ts) handles the SQLite and OTLP codecs, pinned compiler, HTTP, and checkpoints. The synthetic [test](main.test.ts) covers the command path, including occupied trace IDs and ambiguous responses. The optional test against Tempo confirms a stored partial trace with exact parent and span IDs, nanosecond clocks and absent span kind. The [pinned Tempo response schema](https://github.com/grafana/tempo/blob/v2.10.2/pkg/tempopb/tempo.proto#L45-L67) defines the exact query result and its partial status.

## Verification

```sh
node --test collect/trace-replay/main.test.ts
```

For standalone verification, use the Tempo image digest in [the tracked Compose spec](../../infra/lgtm/compose.yaml) with [the tracked Tempo config](../../infra/lgtm/tempo.yaml). Bind ports 3200 and 4318 to disposable IPv4 loopback host ports and use fresh container storage. Run the same test with `PLOW_REPLAY_TEST_QUERY` and `PLOW_REPLAY_TEST_INGEST` set to those two isolated origins. The test writes synthetic data to the destination.
