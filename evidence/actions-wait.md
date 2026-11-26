# Actions jobs during observed waits

[The attribution policy](projection/actions-wait.bend) projects already imported evidence into the SQLite snapshot. Each report has one configured repository and one half-open UTC millisecond window. All four output tables carry `window_start_ms` and `window_end_ms`. The optional final argument to `writeSnapshot` supplies the window as `{ start, end }` in milliseconds. The default is the 24 hours ending at the snapshot cutoff.

## Read boundary

The snapshot reads `actions_wait_facts` as a table or view in the input evidence database. The adapter supplies one row per observed watcher envelope with these fields.

| Field | Meaning |
| --- | --- |
| `repository` | Configured repository supported by the source observation. Only rows for the requested repository enter the report. |
| `run_id`, `head_sha`, `attempt` | Normalized exact attempt key as a positive integer run ID, full lowercase SHA, and positive integer attempt. Unknown components may be NULL. |
| `identity_exact` | Integer 1 when the source positively identifies all four key components. Use 0 for observed waits with known repository but unresolved attempt identity. |
| `started_ms`, `ended_ms` | Observed envelope start and end, with NULL for an unknown clock. |

The rollout collector’s process receipts already retain `repository`, `run_id`, `head_sha`, `attempt`, `poll_started_ms` and `poll_result_ms`. The evidence store exposes its confirmed watcher envelopes through this view using the observed poll endpoints and the collector’s exact-identity decision. Receipts without observed repository scope cannot contribute to a repository’s denominator. The coverage row therefore describes the wait envelopes available to this adapter. Keep source instance, session and call identities, line numbers, handles and raw text in the input evidence. The projection reads the Actions attempt, job and step tables already used by the snapshot. Their imported clock endpoints are converted from seconds to milliseconds.

An older input database without `actions_wait_facts` yields an empty report with `wait_source_present = 0` in the coverage row. An existing relation sets the flag to 1 even when it supplies zero waits. The flag describes schema availability. Import coverage remains a separate source fact.

## Reproduce from existing rollout evidence

Use a private job directory. Import the permitted rollout files into its `evidence.sqlite` first. See [collector usage](../collector/README.md).

```sh
node collector/import-actions.ts "$job" "$repo" --from-waits "$from" "$to" 20
node dashboard/prepare.ts "$job/evidence.sqlite" "$job/dashboard" "$repo" "$to"
dashboard/run.sh "$job/dashboard"
```

Use a 24-hour interval ending at `$to` to match the dashboard window. The capture reports the number of exact attempts missing before import and the number captured. The Bend2 plan prioritizes attempts named by the most observed envelopes and breaks ties by exact identity. The 20-attempt cap applies per invocation. Replay the same bounded command to capture remaining attempts or check completeness. Each attempt must match the repository, run, SHA, and attempt against GitHub before an atomic batch write. Missing or changing inventories abort the batch. Previously captured attempts are retained. Use the collector's exact-attempt command to refresh a previously captured attempt or diagnose an individual read failure. There are no background imports.

## Output

- `actions_wait_coverage` counts source envelopes with positive overlap in the report window. `exact_wait_count` counts the subset with an exact source identity, and `matched_wait_count` counts those with an imported attempt matching all four components. `matched_attempts` and `unmatched_attempts` count distinct exact identities. `jobless_attempts` counts matched attempts with no recorded job rows. Envelopes with missing endpoints or zero overlap contribute no count to the window.
- Durations in coverage use the union of clipped wait intervals per matched attempt. `running_ms` covers time with any measured job execution. `queue_only_ms` covers time with measured queue and no measured execution. `unknown_job_ms` covers the remaining matched wait time. The three sum to `matched_wait_ms`. Different attempts may overlap in wall time.
- `actions_wait_jobs` counts distinct job instances with positive execution or queue overlap and groups them by the imported job label. Rank starts at 1, sorted by descending execution overlap and then ascending label. Queue overlap is retained independently, including when another job is running. An aggregate sums the available clocks and is NULL when none of its contributing instances has that clock.
- `actions_wait_job_instances` includes all imported jobs on matched attempts. Zero means a measured clock missed the observed wait. NULL means the clock was unavailable as a positive interval. The only-known-running clock measures overlap when exactly one measured job execution on that attempt is active. A job link can be assembled from the configured repository and verified run and job IDs on this row.
- `actions_wait_steps` reports imported steps under their owning job, with execution clipped to both the job clock and the union of observed waits. Its run, attempt and job keys refer to the job instance within this single-repository snapshot. The output carries the job's observed attempt context through those keys.

Temporal overlap describes observed concurrent activity. Missing job clocks limit the only-known-running measure, and establishing a workflow gate requires independently evidenced dependency data.
