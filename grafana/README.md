# Plow historical runs in Grafana

The loopback stack provisions the `plow-run-breakdown` dashboard and the `plow-agent-observability` datasource instance. The datasource type matches the plugin ID `plow-agent-observability-datasource`. It queries the `plow-fixture` Loki tenant over the Compose network.

Open `/d/plow-run-breakdown/plow-historical-runs`. The Run ID textbox defaults to `fixture-run` and supplies `$runId` to query A on panel 1. The date selector defaults to two UTC minutes around the fixture's original clocks. Use that same window when invoking the panel from Grafana MCP.

Use the native table's selector to switch between intervals, findings, and coverage. The fixture includes a two-second tool call and a call with a missing result. Unobserved timestamps and durations are shown as **Unknown**. The findings table explains the missing result. Coverage describes the bounded source read.

The [datasource plugin](../analyze/datasource/) interpolates the textbox variable, reads bounded Loki evidence, invokes the compiled Bend2 policy, and encodes its output as Grafana data frames. Follow the [loopback candidate instructions](../infra/lgtm/README.md) to run the integrated stack.

## Dashboard palette

The Compose deployment defaults to the Plow theme. Its canvas is Ink (`#1A130D`), its panels and shell use lighter Ink-toned surfaces, its text uses Cream (`#FFF4DF`), and its primary controls use Meadow (`#6A934F`). The dashboard headings use Young Serif and the native charts, tables, and controls keep Grafana’s interface font. Plow uses 12 px of native panel padding and 36 px panel titles. Collection Health gives the guidance and tables more vertical room. Existing personal theme preferences take precedence. Select **Plow** in Profile preferences or set `PLOW_GRAFANA_THEME=gildedgrove` to change the deployment default.

Grafana 12.3 validates theme IDs against a built-in server list. The image reuses its experimental `debug` ID as **Plow** in the theme picker. Gilded Grove, Zen, and other regular presets are still available. The Docker build validates the exact Grafana asset before replacing the theme definition and writes a new content-addressed filename and integrity hashes. On upgrade, revalidate that patch against the new image and confirm the default, a saved preference, and a switch back to a stock theme in Grafana.

Activity is the default home from both the private Grafana root and the Access gateway. Activity links to Collection Health and Codex traces, and each Plow view links back to Activity. Open run and trace detail from the relevant overview to carry its selected identity and time range.

Expand **Starred** in the Grafana sidebar to switch between Activity, Collection Health, and Plow Codex traces. The deployment seeds these favorites once for the shared Plow Viewer. Viewers can change the shared favorites after setup.

The Plow dashboard header pairs Ink with the [original cream wordmark](assets/plow-cream.png) and uses Meadow (`#6A934F`) for its outline.

Use [named field overrides and value mappings](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/configure-value-mappings/) for table colors. Original Cream highlights elapsed values and a complete source read. Wet Earth marks unknown elapsed values, findings, and a partial source read. The labels carry the evidence state and Grafana supplies contrasting text on each fill in both themes. Keep Meadow for graphics. Complete describes the bounded source read, and the findings and unknown calls describe gaps in the evidence it returned.

The dashboards use a common Ink and Cream header with a Meadow outline. Meadow highlights measured activity and receipt rates. Amber marks waiting time, muted violet shows CI execution, and red marks failures or collector problems. Timelines and tables keep the corresponding labels. Grafana supplies the charts, controls, navigation and theme selection. [Shell branding](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/configure-custom-branding/) requires Grafana Enterprise or a supported paid Grafana Cloud account.

### Plow typography and Collection Health artwork

The signed Business Text panel renders the Plow headings in Young Serif and the Collection Health coverage guidance in Source Serif 4. The heading component preserves each dashboard’s panel ID and uses semantic text and an image with alternate text. It renders independently of the evidence queries. The templates use scoped styles with Grafana’s default HTML sanitization.

Collection Health panel 2 uses **The Long Field**, the original image from the Plow landing page. The horizon stays visible behind the cream wordmark and heading in both the dashboard and the focused panel. The tracked Dockerfile verifies the plugin archive by SHA-256 and copies the original artwork, fonts and font licenses from the [Plow brand site assets](../public/assets/). Grafana serves the assets from its own origin in both the root and subpath deployments. The tracked cream PNG is the original from the [Plow brand guide](../public/brand.md).

## Activity

Open `/d/plow-activity/activity`. Use **Last 24h** or **Last 7 days** to move
the Grafana UTC viewport and select the matching analysis window. The
latest successful live T3 capture checkpoint anchors the analysis. The
coverage panel displays the cutoff, the oldest observed T3 clock, and gaps.
The datasource assembles one bounded snapshot for matching panels. It reads
evidence over eight days, including carry-in, and requests recent checkpoint
receipts separately. A capped or warned read is partial. A failed source call
returns a downstream error. An older carry-in beyond the read bound is unknown.

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
