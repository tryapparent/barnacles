# Dashboard

Grafana is the first renderer. Provision it against read-only SQLite views. The initial dashboard should show the Gardening ↔ Shipping gauge beside observed time by category, then shipment and cycle-time trends, shipped changes, and open delivery threads. Show the selected surface, observation window, and coverage gaps.

Use built-in gauge, time-series, and table panels. Evaluate the [SQLite data source](https://grafana.com/grafana/plugins/frser-sqlite-datasource/) and [Treemap panel](https://grafana.com/grafana/plugins/marcusolsson-treemap-panel/) in the local build. Link categories to workflows and operations. Give the ranked table the same drilldown links so navigation works by keyboard. Keep SQLite attachment disabled and mount only the derived evidence database for Grafana.

The [local provisioning guide](provisioning/README.md) describes the pinned Grafana and Tempo setup, evidence coverage, and launch commands.

**Changed Code Analysis** opens from Shipping review and ranks repository paths by the number of non-merge commits that touched them. The view reports the scanned revision and any limits on its Git history. [Add a Git scan to the local snapshot](provisioning/README.md#changed-code-analysis).

## Operation timings

The Shipping review opens on **Tool envelopes**. Use **Clock** to switch the
treemap and ranked table to async cells, CI queue, CI job execution, or CI steps
when that evidence is present. Tile area shows total recorded duration within
the selected clock. The table shows measured span count, mean duration, and
total for each operation. Select an operation to see its workflow and missing
clocks in **Timing breakdown**.

The snapshot builds `operation_totals` from the same rollout and Actions spans
used by the detailed views. A single-category span keeps its category name.
A mixed command contributes its elapsed duration once to **Mixed**. Select
**Mixed** to see the submitted category groups and their whole-span durations.
The waterfall retains the submitted category names for each span. CI job and step
names can repeat across workflows, and the overview combines their counts and
durations within each clock. Nested and overlapping spans are cumulative
recorded time. The category model and estimated model-wait spans have their
own displays.

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
