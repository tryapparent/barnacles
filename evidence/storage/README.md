# Evidence write admission

[Admission policy](admission.bend) checks the incoming revision against the existing row inside the SQLite write transaction. Equal revisions replay. T3 rejects older snapshots, Codex rejects shorter rollouts, and delivery rejects older PR snapshots. GitHub Actions rejects a changed SHA, either clock moving backward, or an attempt leaving completed status.

[The host adapter](actions.ts) passes two unsigned words for each JavaScript number. The pinned Bend2 host interface supports U32, F32 and nonnegative Nat host numbers up to 2^53. Two words preserve the full number ordering, including adjacent revision clocks in Unix milliseconds. Bend2 compares the words and returns the admission decision. The host executes the corresponding SQL writes. Primary keys make exact release observation duplicates idempotent. T3 runs persist across snapshots while PR links are replaced with the latest link set. Codex replaces the rollout's subordinate records as a unit.

[Delivery report policy](../delivery/report.bend) retains the first qualifying release per channel, ordered by publication time, verification time, observation identity and dispatch time. It keeps channels in first-observed order and emits an unreleased row if none qualify. Legacy reads fetch the release, its identified asset check and its sibling checks. Bend2 requires exactly one check and a matching asset for a legacy proof. It also derives owners and elapsed times and preserves unknown clocks.

Run `npm run verify -- evidence` to compile both policies and exercise SQLite with synthetic replays, rejection cases and legacy release rows.

## Live Codex traces

The [Codex OTLP boundary](../../collector/codex/README.md) uses [its own admission policy](codex-otel.bend). It preserves nanosecond timestamps as canonical decimal strings and treats a span as an immutable observation identified by the configured instance, trace ID and span ID. Parent IDs may reference spans not yet observed. Event rows retain the selected event time and optional provider-reported duration. Exact repeats reuse the existing row. A conflict rolls back every write in the request. Rollout facts and live telemetry keep their own provenance.

## Live T3 Code traces

The [T3 OTLP intake](../../collector/t3-otel/README.md) writes a separate SQLite database. The `t3_otel_spans` primary key is the configured source instance, trace ID and span ID. The writer keeps an optional parent span ID even if that span has never been observed. Source clocks are exact decimal Unix nanosecond strings. The first committed observation keeps a writer-side Unix millisecond ingest clock. Identical normalized evidence leaves the existing row and its ingest clock intact, even when sent in a different batch. A conflicting observation rolls back the entire incoming write transaction. An admitted operation or command type records source evidence for that span. It establishes no run, notification, process exit or delivery outcome.

## Stock T3 command history

The [Compose history reader](../../collector/t3-otel/README.md#read-history-from-stock-t3)
adds `t3_history_commands` and `t3_history_progress` to the same evidence
volume. A command key is the trusted source instance, T3 thread ID and
T3 turn item ID. Rows retain the source snapshot sequence, optional run
ID, T3 provider thread and turn IDs, strong Codex item ID, status, and
optional exit code. IDs from the T3 provider projection have T3's scope.
The millisecond clocks are T3 item lifecycle fields. In particular,
`t3_completed_ms` is the time T3 recorded completion. Runtime
calculations require separate process evidence.

An older snapshot cannot overwrite a newer command observation. Identical
evidence at the same source sequence is replayable. A conflict at the same
sequence rolls back the page, including its cursor update. Keep a stable
instance label for the lifetime of one T3 event store and use a new label
when replacing it with independently sequenced data.

`t3_history_backfill` stores the observed time frontier and thread
revision for each instance and thread in discovery mode. The writer
updates it in the same transaction as the older-page cursor and command
rows. Existing cursors remain resumable. Previously saved state without
a time frontier uses the thread's inventory date until the next page
supplies item clocks.

## Live session links

`t3_live_codex_links` associates a scoped native session with its T3 thread
and retains the provider reference ID. `t3_live_codex_span_links` records the
exact span coordinates selected by Bend2. The join copies only those
normalized spans and events from the read-only trace database, preserving
their clocks and fingerprints. An explicit conversation ID on the span or
one of its events establishes membership. Conflicting conversation IDs leave
the span out. Other spans can still arrive or remain unbound.

`t3_ci_observations` retains explicit query or watch receipts. A row in
`t3_ci_links` confirms that the imported repository, run, attempt, and tested
SHA match the receipt. GitHub jobs and attempts are stored once even when
many threads reference them. The receipt alone supplies no clock for result
delivery, agent pickup, or a blocked milestone.

Run the [one-session join](../../collector/README.md#join-a-live-codex-session-to-t3-and-github)
again after missing evidence arrives. Identical replays preserve one row per
identity. A conflicting replay of an existing span fingerprint or observation
ID aborts the destination transaction. A missing attempt or mismatched SHA
leaves the observation available with no verified link. The command reports
the accepted and conflicting span counts and the CI link status.
