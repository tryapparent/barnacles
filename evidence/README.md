# Evidence

SQLite holds exact source identities, observations, and read views. The table describes each source and its intended coverage. Apply each bounded import in a transaction. Replaying the same source observations must preserve row counts and derived results. Keep collection time, observation time, and source event time distinct.

## Published dashboard snapshot

Evidence owns the versioned read contract. Version 1 carries an immutable `dashboard.sqlite`, a matching replayable `tempo.ndjson`, and a `snapshot.json` manifest containing `formatVersion`, `generation`, UTC `createdAt`, and `coverage`. Coverage includes the dashboard window endpoints in Unix seconds, the timing cutoff in Unix milliseconds, and counts for PRs observed, releases shipped, releases linked, rollouts, and trace sessions. The local preparation command also builds `review-policy.mjs` for Harbor. It publishes the directory only after generating all files. Keep the previous generation for rollback. Prepare a new generation from the original evidence database to migrate directories created before manifests existed.

Keep existing fields and semantics compatible within a format version. For a breaking change, add Dashboard support for both versions before switching the Evidence publisher. Harbor reads the derived SQLite file. The writable database stays with the import commands.

[`loadEvidence`](storage/load.ts) accepts one typed batch from a source. Its variants preserve the differences between a T3 thread snapshot, a Codex rollout, a GitHub Actions attempt, and a GitHub delivery observation. The loader dispatches to the matching SQLite transaction. The [shared interval type](projection/intervals.ts) gives Actions and Codex a common timing input with source identity, a distinct clock kind, and nullable UTC millisecond endpoints. T3 execution clocks remain in the source records until a timing consumer needs them. Point observations, ownership links, and delivery proofs retain their own shapes.

| Record | Identity and payload |
| --- | --- |
| Thread and run | T3 environment + thread ID, plus run ID for run clocks. Store start, status and known work origin. |
| Delivery link | T3 thread identity + GitHub repository and PR number, with explicit link provenance. A thread can represent several PRs. Preserve ambiguous ownership for review. |
| Pull request | GitHub host + repository + PR number. Store observed commit, open, review, and merge milestones with their sources. |
| Actions timing | Repository + run ID + attempt, with head SHA checked against attempt metadata. Use job ID and step number inside the attempt. Preserve clock kind, timestamps, parent and coverage. Retain earlier-attempt attribution for uniquely matched carried jobs. |
| Release and access | Repository + release ID, asset ID, channel, source SHA and publication time. Keep each asset access check with its observation time and result. |
| Rollout spans | Source instance + stable session and call IDs, with separate clock kinds for tool envelopes and observed processes. Preserve parent links where supported. |
| Git change scan | Explicit repository name + resolved revision, with commit count, truncation and shallow coverage. Keep the top paths in the order produced by Bend2. Each successful import atomically replaces the previous scan for that repository. |
| Import coverage | Source scope, requested window and cutoff, collection time, and gaps such as capped, unavailable, or partial input. |

## Actions tables

[action_attempts, action_jobs, and action_steps](storage/actions.sql) retain the exact GitHub keys and normalized clocks in UTC Unix seconds. Attempt rows carry expected head SHA, workflow ID, source status, conclusion, update time, observation time, and captured job count. Jobless attempts and reruns have an unknown attempt-level start. Job rows retain provider creation time, measured endpoints, and a flag for execution timestamps predating job creation. Step intervals are retained when the measured job execution bounds contain them. Missing measured endpoints are SQL NULL. The importer re-reads the selected attempt, so it cannot reconstruct earlier queue or active-job snapshots. A successful window import emits its inventory and capture counts in the CLI receipt. Retain the receipt alongside the private database when comparing sample coverage.

Run `node evidence/report-actions.ts "$job/evidence.sqlite" OWNER/REPO` for occupancy by workflow, clock, and operation. The report and dashboard snapshot use the same Bend2 timing policy for grouping, counting, missing-clock coverage, and ranking. The TypeScript host feeds raw clock endpoints and writes the ranked rows. `unmeasured_count` counts rows without a completed measured span, including skipped or inapplicable clocks. Query one clock at a time for totals. The underlying tables retain IDs for drilldown. Older databases may still carry the historical `action_occupancy` view.

## T3, rollout, and delivery tables

[Source tables](storage/sources.sql) store T3 runtime snapshots and explicit PR links, Codex session and call identities, GitHub PR milestones, release IDs and source SHAs, and separate asset probes. T3 and Codex clocks use UTC Unix milliseconds. GitHub uses UTC Unix seconds. A Codex span has a stable call ID and the source line where the call began. An observed async cell also points to its terminal wait call. `codex_spans` exposes both clocks and preserves unknown endpoints. `open_delivery_threads` uses explicit owning links with an observed open PR and unsettled T3 status.

`codex_reasoning` stores an observation timestamp keyed by collector instance, session, and source line. These points have no duration and are excluded from span counts and occupancy. Databases imported before this table was added have no reasoning coverage until the corresponding rollouts are reimported.

`codex_reasoning_inputs` links a reasoning observation to the preceding tool result's call identity when the importer observes them in sequence. The dashboard derives a positive gap only with a paired tool end and no overlapping or potentially open tool activity. Malformed records and orphan outputs suppress estimates for that rollout. Older snapshots can still render their original spans and reasoning events.

`codex_commands` and `codex_categories` store allowlisted command labels and distinct submitted operation categories by instance, session, and call ID. The Tempo projection hashes source keys into stable trace and span IDs, and exports observed timestamps, source line numbers, clock names, and safe labels. Categories attach to the existing span, so several categories can share one observed interval. Imports that predate categories retain their original labels until reimported. Exact source identities stay in this SQLite schema.

`codex_command_mixes` stores repeated operation counts and the matched inner shell receipt duration using the same call identity. It supplies evidence for estimation and does not alter the trace clock. Reimport a rollout to populate this table.

## Delivery attribution

[`delivery.ts`](delivery/delivery.ts) joins independent source rows by explicit owner, repository, and PR number. [Bend2](sources.bend) selects the earliest verified publication available in the local sample. The [delivery stage policy](projection/metrics.bend) defines which observed endpoints form each interval. Run `npm run verify -- evidence` for the report CLI regression through SQLite.

Each row of `github_release_observations` binds the PR merge SHA, release source SHA, publication time, asset, verification result, and matched publishing workflow clocks observed together. A later failed probe preserves the earlier successful observation. Replaying identical evidence preserves the row count. `github_pr_ci` retains the observed first PR workflow start and its run ID.

Legacy databases keep their original rows. The report can use a legacy proof when a release has one retained access observation, the asset IDs agree, and the clocks are consistent. Multiple legacy observations can share overwritten release metadata, so their shipping clocks stay unknown until a fresh import confirms the release. Legacy dispatch stays unknown because it was stored separately from the probe. Reimport with the explicit release tag to collect a bound observation.

## Coverage contract

`rolloutCoverage(db)` and the `rollout-coverage` CLI read two optional tables. An absent table returns JSON `null`. Older sessions have no quality row until reimported. The receipt inventory answers for attempted files, so it cannot count files that were never selected or clocks in omitted bytes.

- `codex_rollout_imports` has the latest admission receipt by `instance, source_key`. Count `admitted` and `admitted_fork_suffix` as accepted. Other statuses identify unavailable, nonregular, empty, and oversized files, read failures, missing or invalid metadata, metadata conflicts, and unproven forks. `complete_lines` counts delimiters observed, including rejected lines. `inherited_lines` counts the confirmed prefix following the child header, including the parent header. `unassigned_lines` counts decodable records before session metadata. `malformed_lines` and `oversized_lines` count complete records, and `cutoff_lines` (0 or 1) and `cutoff_bytes` describe an undelimited tail. Unread files have zero observed lines and unknown record counts. Fork receipts retain the parent ID and the zero-based history start ordinal. For a rejected receipt these fields can describe a tentative header.
- `codex_rollout_quality` describes the stored snapshot by `instance, session_id`, with the admitting `source_key`. The receipt for that key can be newer than the snapshot. `first_observed_ms` and `last_observed_ms` bound valid source envelope timestamps seen in admitted records. They do not specify a requested window or guarantee continuous coverage. Missing start and end counts describe tool envelopes. `missing_async_end` counts observed launches without a usable terminal clock. These omissions can overlap. `rolloutCoverage(db)` also returns the existing `orphan_count` per session. The legacy `codex_rollouts.malformed_count` summarizes pairing gaps across malformed, oversized, cutoff, and unassigned records.
- `mix_candidates` counts calls whose submitted sequential syntax qualifies for receipt matching, including single-category calls. `mix_receipts` counts accepted whole-group receipts. `mixed_calls` counts retained calls with multiple categories, and `mixed_without_receipt` counts those lacking a usable receipt. Keep the envelope or async duration on its original clock and the inner shell duration on the separate receipt. None of these counts supports allocating elapsed time to individual commands.

In `deliveryReport(db, policy)`, each row retains the existing clocks and adds `coverage`:

- `thread_link` is `verified`, `no_link`, `no_owning_link`, `ambiguous_owner`, or `thread_clock_conflict`. Ownership uses explicit T3 `created` or `agent` links to the PR. `release_link` is `verified`, `no_release_proof`, `release_unverified`, or `no_proof_for_current_merge`. Verified release proof requires the selected surface, merge SHA ancestry, publication, and a recorded access check. Access check time is an observation clock.
- `endpoints` reports `observed` or `missing` for each milestone. `stages` reports `observed`, `missing_start`, `missing_end`, `missing_both`, or `clock_conflict`. For a display scoped to a verified publication cohort, select those rows before aggregating status counts. A missing milestone can reflect a bounded collection, an unavailable source, or unresolved lineage.
- `thread_clock_kind` labels creation-to-milestone elapsed. Where the display has a selection start, `policy.delivery_thread_window(created, windowStart)` can flag threads that predate it. Their elapsed duration can include idle time. `active_thread_work`, `rollout_delivery_lineage`, `landed_ci_lineage`, `human_blocking`, and `critical_path` remain `unknown`. A PR workflow start and a publishing dispatch do not establish landed CI success or explain delivery delays.

## Read views

- **Shipped changes.** Count distinct eligible PRs once for the selected surface when the verified release SHA equals or descends from the relevant merge SHA. Keep repository and surface in the attribution. A release can contain multiple changes. If coverage begins after the first possible release, label the endpoint as first observed.
- **Cycle time.** Use thread creation through release publication when a recorded access check supports that release. Store verification time separately because a later probe cannot establish when access first became possible. Keep PR-to-release evidence when the thread link is missing. A research thread or a thread with unresolved ownership supplies no delivery duration.
- **Occupancy.** Derive count, mean duration, and total for each operation and clock. Aggregate comparable leaves. Avoid adding parent execution to its nested steps, or treating concurrent occupancy as elapsed delivery time.
- **Direction.** Compare mean cycle time across adjacent completed weeks in UTC for the same surface. Show the signed difference and both sample counts. Longer moves toward Gardening, flat or shorter toward Shipping. Missing samples produce an unknown direction.

Prometheus can later carry bounded service metrics. Exact thread, PR, SHA, and command identities belong in local evidence.

### Wait drilldown fields

- `codex_wait_coverage(instance, session_id)` marks rollouts imported with wait attribution. Join to `codex_rollouts` for malformed and orphan counts. An absent marker means unknown coverage.
- `codex_wait_attribution` has one row per wait call, keyed by `(instance, session_id, call_id)`. Join to `codex_calls` on that key for the wait's source line and clock. `cell_id` is the literal target and `cell_status` explains linkage. `cell_launch_call_id` is available for `linked_cell`.
- `codex_process_receipts` has one row per submitted process operation considered for attribution. Join on the same instance and session using `codex_wait_attribution.cell_launch_call_id = codex_process_receipts.call_id`. The row describes the **cell owner's** operation. Several interim waits can share it. `result_call_id` and `receipt_source_line` identify the selected tool response, which can be a later terminal wait. Receipt kind distinguishes a valid receipt from absent or unsupported payloads.
- `process_handle` is scoped to the rollout and may be recycled. `process_launch_call_id` identifies the linked generation, while `process_status` describes the outcome or the reason attribution is missing. `process_category` is an allowlisted label for the submitted command. Receipt kind, seconds, echoed handle, and exit code retain only the bounded structured fields.
- `repository`, `run_id`, `head_sha`, and `attempt` carry the exact submitted watcher identity when established. Run and attempt are decimal strings. `poll_started_ms` and `poll_result_ms` are populated only for a linked read-only poll with a consistent structured running or exit receipt and exact watcher identity. They use an observation envelope in UTC milliseconds, which has different bounds from the inner tool receipt's elapsed seconds.

## Local process timing

`codex_kernel_captures` records one scoped Linux scheduler capture per `(instance, session_id, call_id)`. Its SHA-256 identifies the original observer output. The private row stores the rollout source line and exact call start for binding checks plus a derived span tree. Embed neither raw events nor rollout content in a prepared result.

Bend2 orders events by monotonic time, follows parentage at fork, and pairs executable spans from exec through replacement exec or exit. A shell that replaces its image with Git can therefore close its shell span before the command root ends. Unrecognized executables use a generic label. A missing root exit yields a null root duration. Executable spans missing an endpoint contribute to an unfinished count. Durations and offsets are in microseconds, relative to the observed root. These clocks can overlap and measure elapsed occupancy. They do not tell us how long shell built-ins, threads without an exec, or internal program phases took.

Snapshot preparation checks the saved binding against the current rollout call and selects up to eight captures at or before the snapshot cutoff. Recent captures appear first. The API exposes only the call timestamp, relative timings, executable labels, and per-capture span relationships. See [the collector procedure](../collector/README.md#capture-one-local-command).
