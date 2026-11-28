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

## Activity

Open `/d/plow-activity/activity`. Use **Last 24h** or **Last 7 days** to move
the Grafana UTC viewport and select the matching analysis window. The
latest successful live T3 capture checkpoint anchors the analysis. The
coverage panel displays the cutoff, the oldest observed T3 clock, and gaps.
The datasource reads at most 5,000 entries per evidence source over eight
days, including carry-in, and separate bounded latest coverage receipts.
A capped read stays partial. An older carry-in beyond the read bound is
unknown.

Where time went adds disjoint intervals for each thread. Overlapping
threads contribute independently. Provider time takes precedence over
admission on the same thread. Use the table selector to choose Operations.
Category and operation links filter the threads shown in the timeline.
Between recorded runs requires a completion and a later request. Bounded
gaps with missing clocks are visible separately. Agent work share is the
mean of measured per-thread provider shares. The last day uses six four-hour
buckets and the last week uses seven daily buckets. Empty buckets remain
null.

CI occupancy lives on separate attempt and job lanes. An exact T3 link can
bind on repository, run, attempt and SHA, or on the GitHub attempt's explicit
PR identity and a unique T3 owning PR association. Jobs require the matching
exact attempt. Reruns stay separate. Missing attempt completion stays
unknown. What to fix keeps confirmed outcome delay, observed admission, and
failed-job execution separate. A confirmed outcome requires independent
clock evidence. Source coverage shows the absence of a confirmed outcome
feed.

Exact run drilldown opens the existing historical-run dashboard with the
measured full-run bounds. The Activity dashboard and historical runs share
a tracked provisioned JSON bundle, unpacked at image build time into native
dashboard files. Any additional independently authored dashboard can use a
separate file provider pointing at its provisioned directory.

Run `node --test analyze/policy/main.test.ts` for source-clock edge cases,
replay, nullable buckets, provider and admission overlap, unrelated CI, and
exact detail links. `bash infra/lgtm/check.sh` exercises both dashboard
query contracts through Grafana and Grafana MCP.
