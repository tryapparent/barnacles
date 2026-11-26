# Dashboard

Grafana is the first renderer. Provision it against read-only SQLite views. The initial dashboard should show the Gardening ↔ Shipping gauge beside observed time by category, then shipment and cycle-time trends, shipped changes, and open delivery threads. Show the selected surface, observation window, and coverage gaps.

Use built-in gauge, time-series, and table panels. Evaluate the [SQLite data source](https://grafana.com/grafana/plugins/frser-sqlite-datasource/) and [Treemap panel](https://grafana.com/grafana/plugins/marcusolsson-treemap-panel/) in the local build. Link categories to workflows and operations. Give the ranked table the same drilldown links so navigation works by keyboard. Keep SQLite attachment disabled and mount only the derived evidence database for Grafana.

The [local provisioning guide](provisioning/README.md) describes the pinned Grafana and Tempo setup, evidence coverage, and launch commands.

**Changed Code Analysis** opens from Shipping review and ranks repository paths by the number of non-merge commits that touched them. The view reports the scanned revision and any limits on its Git history. [Add a Git scan to the local snapshot](provisioning/README.md#changed-code-analysis).

## Operation timings

Shipping review and Timing breakdown use **Timing window** to choose the final
**1h** or **24h** before the displayed UTC cutoff. The cutoff defaults to
snapshot preparation time. To replay a historical interval against the retained
evidence, pass an ISO UTC cutoff as the fourth argument to `dashboard/prepare.ts`.
Delivery elapsed time, weekly release trends, and category estimates use the
full imported snapshot.

Use **Clock** to switch between tool envelopes, async cells, CI job queue,
CI job execution, and CI steps. Sum adds all measured durations clipped to the
selected window. Union counts overlap once within the displayed clock and group.
Unions from different groups or clocks can overlap. CI steps are nested within
jobs. These clocks measure observed occupancy. Delivery elapsed time measures the
time between milestones and can include idle time.

The timing intervals are half-open. A nonzero span must intersect the window
for positive time. A zero-length span counts when its timestamp is inside the
window. An incomplete or reversed span contributes to **Untimed** when its
start is in the window, or when only its end is available and that end is in
the window. Spans with neither timestamp appear under **Unplaced** for their
clock across the whole import. Missing duration stays unknown.

**Source freshness** shows first and latest recorded timestamps for imported
Codex calls, cells and reasoning, sampled Actions attempts and jobs, imported
T3 threads and runs, and verified publications for the delivery surface.
The latest Actions capture and release access check appear as receipts.
The retained Codex and T3 schemas have no capture clock. Bounds describe the
observed sample and may contain gaps. They can extend outside the selected window.

Select an operation to open **Timing breakdown** with its window and clock.
A mixed command contributes its clipped duration once to **Mixed**. Select
**Mixed** to see its submitted category groups. The waterfall retains the
submitted category names for each span. The category model and estimated
model-wait spans have their own displays.

## Actions waits

From Shipping review, open **Actions waits** to see how much observed workflow watcher time overlaps each GitHub job family. Select a family, then a job ID, to see individual steps and open the exact GitHub job. The view uses the 24 hours ending at the prepared snapshot cutoff. It shows matching coverage, time in measured execution or queue, and time without known job clocks. [Capture exact attempts and reproduce the view](../evidence/actions-wait.md).

## Codex waterfall

Import a permitted rollout with `node collector/import-sources.ts "$job" rollout local-codex "$rollout"`.
Prepare the local view with `node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana" OWNER/REPO`.
Start Grafana with `dashboard/run.sh "$job/grafana"` and open `/d/barnacles-trace/trace`.

Choose a **Session** and select a span to see its clock, source line, and any recognized command.
Open the recorded session window's **Events** to inspect reasoning observations. Their durations are unknown.
**Estimated model wait** shows the gap from a tool result to an immediately following reasoning item when retained tool activity leaves the gap clear. The gap can include harness delays, network time, provider queueing and inference. Select the span for the source lines. Estimates appear only in the waterfall and are excluded from measured totals. Reimport older rollouts and rebuild the snapshot to add estimates.
The tables below the waterfall show completed operations, timestamped reasoning, and spans with missing clocks. Reimport older rollouts to add command details.

## Snapshot policy

The snapshot runs the compiled Bend2 projections in `evidence/projection/`. The
shipping policy groups observed releases by UTC week, counts missing clocks per
delivery stage, and assembles milestones. The trace policy joins optional labels
and reasoning provenance by the source instance and session, projects parent
spans and model-wait estimates, and ranks the default session. Timing detail
selectors are projected before Grafana binds the selected clock, workflow, and
operation. They preserve the existing **Mixed** drilldown and workflow filters.

The existing host paths `evidence/projection/snapshot.ts`,
`evidence/projection/timing.ts`, `evidence/projection/trace.ts`, and
`evidence/report-actions.ts` read SQLite, pass decoded rows and opaque state to
Bend2, and encode rows and JSON for consumers. The raw trace read uses the
existing `codex_spans` storage view. The Actions and T3 reads resolve foreign
keys to retrieve recorded workflow and thread fields. The dashboard adapter
keeps Grafana provisioning and parameter binding in `dashboard/panels.ts` and
OTLP encoding in `dashboard/trace.ts`.

Run `npm run verify -- evidence dashboard` to exercise the compiled policies
through snapshot preparation and the Actions report CLI with synthetic evidence.
The dashboard fixture covers Mixed selectors, incomplete clocks, a reasoning-only
session, and a source without optional trace metadata.
