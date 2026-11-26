# Evidence

SQLite holds exact Actions source identities, observations, and an occupancy view. The following table also describes the planned records for later importers. Apply each bounded import in a transaction. Replaying the same source observations must preserve row counts and derived results. Keep collection time, observation time, and source event time distinct.

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

[action_attempts, action_jobs, and action_steps](actions.sql) retain the exact GitHub keys and normalized clocks in UTC Unix seconds. Attempt rows carry expected head SHA, workflow ID, source status, conclusion, update time, observation time, and captured job count. Job rows retain provider creation time, measured endpoints, and a flag for execution timestamps predating job creation. Step intervals are retained when the measured job execution bounds contain them. Missing measured endpoints are SQL NULL. The importer re-reads the selected attempt, so it cannot reconstruct earlier queue or active-job snapshots.

The `action_occupancy` view groups measured durations by repository, workflow, clock, and operation. `unmeasured_count` counts rows without a completed measured span, including skipped or inapplicable clocks. Query one clock at a time for totals. The underlying tables retain IDs for drilldown.

## Read views

- **Shipped changes.** Count distinct eligible PRs once for the selected surface when the verified release SHA equals or descends from the relevant merge SHA. Keep repository and surface in the attribution. A release can contain multiple changes. If coverage begins after the first possible release, label the endpoint as first observed.
- **Cycle time.** Use thread creation through release publication when a recorded access check supports that release. Store verification time separately because a later probe cannot establish when access first became possible. Keep PR-to-release evidence when the thread link is missing. A research thread or a thread with unresolved ownership supplies no delivery duration.
- **Occupancy.** Derive count, mean duration, and total for each operation and clock. Aggregate comparable leaves. Avoid adding parent execution to its nested steps, or treating concurrent occupancy as elapsed delivery time.
- **Direction.** Compare mean cycle time across adjacent completed weeks in UTC for the same surface. Show the signed difference and both sample counts. Longer moves toward Gardening, flat or shorter toward Shipping. Missing samples produce an unknown direction.

Prometheus can later carry bounded service metrics. Exact thread, PR, SHA, and command identities belong in local evidence.
