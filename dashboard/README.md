# Dashboard

Grafana is the first renderer. Provision it against read-only SQLite views. The initial dashboard should show the Gardening ↔ Shipping gauge beside observed time by category, then shipment and cycle-time trends, shipped changes, and open delivery threads. Show the selected surface, observation window, and coverage gaps.

Use built-in gauge, time-series, and table panels. Evaluate the [SQLite data source](https://grafana.com/grafana/plugins/frser-sqlite-datasource/) and [Treemap panel](https://grafana.com/grafana/plugins/marcusolsson-treemap-panel/) in the local build. Link categories to workflows and operations. Give the ranked table the same drilldown links so navigation works by keyboard. Keep SQLite attachment disabled and mount only the derived evidence database for Grafana.

The [local provisioning guide](provisioning/README.md) describes the pinned Grafana and Tempo setup, evidence coverage, and launch commands.

## Codex waterfall

Import a permitted rollout with `node collector/import-sources.ts "$job" rollout local-codex "$rollout"`.
Prepare the local view with `node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana" OWNER/REPO`.
Start Grafana with `dashboard/run.sh "$job/grafana"` and open `/d/barnacles-trace/trace`.

Choose a **Session** and select a span to see its clock, source line, and any recognized command.
Open the recorded session window's **Events** to inspect reasoning observations. Their durations are unknown.
The tables below the waterfall show completed operations, timestamped reasoning, and spans with missing clocks. Reimport older rollouts to add command details.
