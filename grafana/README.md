# Plow historical runs in Grafana

The loopback stack provisions the `plow-run-breakdown` dashboard and the `plow-agent-observability` datasource instance. The datasource type matches the plugin ID `plow-agent-observability-datasource`. It queries the `plow-fixture` Loki tenant over the Compose network.

Open `/d/plow-run-breakdown/plow-historical-runs`. The Run ID textbox defaults to `fixture-run` and supplies `$runId` to query A on panel 1. The date selector defaults to two UTC minutes around the fixture's original clocks. Use that same window when invoking the panel from Grafana MCP.

Use the native table's selector to switch between intervals, findings, and coverage. The fixture includes a two-second tool call and a call with a missing result. Unobserved timestamps and durations are shown as **Unknown**. The findings table explains the missing result. Coverage describes the bounded source read.

The [datasource plugin](../analyze/datasource/) interpolates the textbox variable, reads bounded Loki evidence, invokes the compiled Bend2 policy, and encodes its output as Grafana data frames. Follow the [loopback candidate instructions](../infra/lgtm/README.md) to run the integrated stack.

## Dashboard palette

The built-in Grafana OSS Canvas header pairs Wet Earth (`#392820`) with the [original cream wordmark](assets/plow-cream.png) and uses Meadow (`#6A934F`) for its outline. Original Cream (`#FFF4DF`) text on Wet Earth reaches 12.85:1 contrast.

Use [named field overrides and value mappings](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/configure-value-mappings/) for table colors. Original Cream highlights elapsed values and a complete source read. Wet Earth marks unknown elapsed values, findings, and a partial source read. The labels carry the evidence state and Grafana supplies contrasting text on each fill in both themes. Keep Meadow for graphics. Complete describes the bounded source read, and the findings and unknown calls describe gaps in the evidence it returned.

The dashboard uses Grafana's native controls, typography, and theme preference. [Shell branding](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/configure-custom-branding/) requires Grafana Enterprise or a supported paid Grafana Cloud account.

### Canvas asset

Grafana 12.3 resolves the Canvas image filename relative to its public build directory. Mount `grafana/assets/plow-cream.png` read-only at `/usr/share/grafana/public/build/plow-cream.png` or copy it to that path in the Grafana image. From `infra/lgtm/compose.yaml`, the bind mount is:

```yaml
- ../../grafana/assets/plow-cream.png:/usr/share/grafana/public/build/plow-cream.png:ro
```

The PNG is the byte-for-byte original from the Plow brand guide.

Grafana 12.3 includes both static Canvas elements in the tab order. The wordmark is an unnamed stop and the caption is announced as a button. The outline is a frame style and adds no stop. The dashboard's Run ID, time range, and table selector use Grafana's native keyboard controls.
