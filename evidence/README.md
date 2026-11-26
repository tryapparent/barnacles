# Evidence

SQLite holds exact source identities, observations, and read views. The table describes each source and its intended coverage. Apply each bounded import in a transaction. Replaying the same source observations must preserve row counts and derived results. Keep collection time, observation time, and source event time distinct.

[`loadEvidence`](storage/load.ts) accepts one typed batch from a source. Its variants preserve the differences between a T3 thread snapshot, a Codex rollout, a GitHub Actions attempt, and a GitHub delivery observation. The loader dispatches to the matching SQLite transaction. The [shared interval type](projection/intervals.ts) gives Actions and Codex a common timing input with source identity, a distinct clock kind, and nullable UTC millisecond endpoints. T3 execution clocks remain in the source records until a timing consumer needs them. Point observations, ownership links, and delivery proofs retain their own shapes.

| Record | Identity and payload |
| --- | --- |
| Thread and run | T3 environment + thread ID, plus run ID for run clocks. Store start, status and known work origin. |
| Delivery link | T3 thread identity + GitHub repository and PR number, with explicit link provenance. A thread can represent several PRs. Preserve ambiguous ownership for review. |
| Pull request | GitHub host + repository + PR number. Store observed commit, open, review, and merge milestones with their sources. |
| Actions timing | Repository + run ID + attempt, with head SHA checked against attempt metadata. Use job ID and step number inside the attempt. Preserve clock kind, timestamps, parent and coverage. Retain earlier-attempt attribution for uniquely matched carried jobs. |
| Release and access | Repository + release ID, asset ID, channel, source SHA and publication time. Keep each asset access check with its observation time and result. |
| Rollout spans | Source instance + stable session and call IDs, with separate clock kinds for tool envelopes and observed processes. Preserve parent links where supported. |
| Import coverage | Source scope, requested window and cutoff, collection time, and gaps such as capped, unavailable, or partial input. |

## Actions tables

[action_attempts, action_jobs, and action_steps](storage/actions.sql) retain the exact GitHub keys and normalized clocks in UTC Unix seconds. Attempt rows carry expected head SHA, workflow ID, source status, conclusion, update time, observation time, and captured job count. Job rows retain provider creation time, measured endpoints, and a flag for execution timestamps predating job creation. Step intervals are retained when the measured job execution bounds contain them. Missing measured endpoints are SQL NULL. The importer re-reads the selected attempt, so it cannot reconstruct earlier queue or active-job snapshots.

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

## Read views

- **Shipped changes.** Count distinct eligible PRs once for the selected surface when the verified release SHA equals or descends from the relevant merge SHA. Keep repository and surface in the attribution. A release can contain multiple changes. If coverage begins after the first possible release, label the endpoint as first observed.
- **Cycle time.** Use thread creation through release publication when a recorded access check supports that release. Store verification time separately because a later probe cannot establish when access first became possible. Keep PR-to-release evidence when the thread link is missing. A research thread or a thread with unresolved ownership supplies no delivery duration.
- **Occupancy.** Derive count, mean duration, and total for each operation and clock. Aggregate comparable leaves. Avoid adding parent execution to its nested steps, or treating concurrent occupancy as elapsed delivery time.
- **Direction.** Compare mean cycle time across adjacent completed weeks in UTC for the same surface. Show the signed difference and both sample counts. Longer moves toward Gardening, flat or shorter toward Shipping. Missing samples produce an unknown direction.

Prometheus can later carry bounded service metrics. Exact thread, PR, SHA, and command identities belong in local evidence.
