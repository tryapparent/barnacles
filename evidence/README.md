# Evidence

SQLite will hold exact source identities, observations, and read views for the dashboard. Apply each bounded import in a transaction. Replaying the same source observations must preserve row counts and derived results. Keep collection time, observation time, and source event time distinct.

| Record | Identity and payload |
| --- | --- |
| Thread and run | T3 environment + thread ID, plus run ID for run clocks. Store start, status and known work origin. |
| Delivery link | T3 thread identity + GitHub repository and PR number, with explicit link provenance. A thread can represent several PRs. Preserve ambiguous ownership for review. |
| Pull request | GitHub host + repository + PR number. Store observed commit, open, review, and merge milestones with their sources. |
| Actions timing | Repository + run ID + attempt, with head SHA checked against attempt metadata. Use job ID and step number inside the attempt. Preserve clock kind, timestamps, parent and coverage. Retain earlier-attempt attribution for uniquely matched carried jobs. |
| Release and access | Repository + release ID, asset ID, channel, source SHA and publication time. Keep each asset access check with its observation time and result. |
| Rollout spans | Source instance + stable session and call IDs, with separate clock kinds for tool envelopes and observed processes. Preserve parent links where supported. |
| Import coverage | Source scope, requested window and cutoff, collection time, and gaps such as capped, unavailable, or partial input. |

## Read views

- **Shipped changes.** Count distinct eligible PRs once for the selected surface when the verified release SHA equals or descends from the relevant merge SHA. Keep repository and surface in the attribution. A release can contain multiple changes. If coverage begins after the first possible release, label the endpoint as first observed.
- **Cycle time.** Use thread creation through release publication when a recorded access check supports that release. Store verification time separately because a later probe cannot establish when access first became possible. Keep PR-to-release evidence when the thread link is missing. A research thread or a thread with unresolved ownership supplies no delivery duration.
- **Occupancy.** Derive count, mean duration, and total for each operation and clock. Aggregate comparable leaves. Avoid adding parent execution to its nested steps, or treating concurrent occupancy as elapsed delivery time.
- **Direction.** Compare mean cycle time across adjacent completed weeks in UTC for the same surface. Show the signed difference and both sample counts. Longer moves toward Gardening, flat or shorter toward Shipping. Missing samples produce an unknown direction.

Prometheus can later carry bounded service metrics. Exact thread, PR, SHA, and command identities belong in local evidence.
