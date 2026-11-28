# Plow historical runs in Grafana

The loopback stack provisions the `plow-run-breakdown` dashboard and the `plow-agent-observability` datasource instance. The datasource type matches the plugin ID `plow-agent-observability-datasource`. It queries the `plow-fixture` Loki tenant over the Compose network.

Open `/d/plow-run-breakdown/plow-historical-runs`. The Run ID textbox defaults to `fixture-run` and supplies `$runId` to query A on panel 1. The date selector defaults to two UTC minutes around the fixture's original clocks. Use that same window when invoking the panel from Grafana MCP.

Use the native table's selector to switch between intervals, findings, and coverage. The fixture includes a two-second tool call and a call with a missing result. Unobserved timestamps and durations are shown as **Unknown**. The findings table explains the missing result. Coverage describes the bounded source read.

The [datasource plugin](../analyze/datasource/) interpolates the textbox variable, reads bounded Loki evidence, invokes the compiled Bend2 policy, and encodes its output as Grafana data frames. Follow the [loopback candidate instructions](../infra/lgtm/README.md) to run the integrated stack.

## Canvas header

The built-in Grafana OSS Canvas panel uses Wet Earth (`#392820`), the [original cream wordmark](assets/plow-cream.png), and a Meadow divider (`#6A934F`). Cream text on Wet Earth reaches 12.85:1 contrast. The dashboard uses native Grafana controls, typography, and table formatting in both themes.

Grafana 12.3 resolves the Canvas image filename relative to its public build directory. Mount `grafana/assets/plow-cream.png` read-only at `/usr/share/grafana/public/build/plow-cream.png` or copy it to that path in the Grafana image. From `infra/lgtm/compose.yaml`, the bind mount is:

```yaml
- ../../grafana/assets/plow-cream.png:/usr/share/grafana/public/build/plow-cream.png:ro
```

The PNG is the byte-for-byte original from the Plow brand guide.

Grafana 12.3 includes static Canvas elements in the keyboard tab order, including the decorative shapes. The dashboard's Run ID, time range, and table selector use Grafana's native keyboard controls.
