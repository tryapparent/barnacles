# Dashboard

Grafana is the first renderer. Provision it against read-only SQLite views. The initial dashboard should show the Gardening ↔ Shipping gauge beside observed time by category, then shipment and cycle-time trends, shipped changes, and open delivery threads. Show the selected surface, observation window, and coverage gaps.

Use built-in gauge, time-series, and table panels. Evaluate the [SQLite data source](https://grafana.com/grafana/plugins/frser-sqlite-datasource/) and [Treemap panel](https://grafana.com/grafana/plugins/marcusolsson-treemap-panel/) in the local build. Link categories to workflows and operations. Give the ranked table the same drilldown links so navigation works by keyboard. Keep SQLite attachment disabled and mount only the derived evidence database for Grafana.

For an initial waterfall, try [Grafana's trace-file import](https://grafana.com/docs/grafana/latest/datasources/jaeger/query-editor/) with sanitized timestamps, display labels, and parent IDs. Add a trace backend if file import cannot support the intended workflow. Keep the waterfall on one time axis and retain nested and overlapping spans.

Document the exact Grafana and plugin versions, local launch and import commands, and UI verification when the first provisioned build lands.

## Codex waterfall

Import a permitted rollout with `node collector/import-sources.ts "$job" rollout local-codex "$rollout"`.
Prepare the local view with `node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana" OWNER/REPO`.
Start Grafana with `dashboard/run.sh "$job/grafana"` and open `/d/barnacles-trace/trace`.

Select a session under **Imported sessions** and use the time picker to inspect later activity. Purple lines mark
when Codex recorded reasoning. **Reasoning timestamps** lists the same events by timestamp and source line.
Their durations are unknown. Reimport older rollouts to pick up the marker and label changes.
