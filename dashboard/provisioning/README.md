# Run the Barnacles dashboards locally

The collector's [Actions import](../../collector/README.md#run-the-actions-import) and [delivery and rollout imports](../../collector/README.md#import-t3-codex-and-github-delivery) can write to the same private `evidence.sqlite`. Build a second read-only snapshot for Grafana:

```sh
node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana" tryapparent/apparent
dashboard/run.sh "$job/grafana"
```

Open [Shipping review](http://localhost:3030/d/barnacles-shipping/shipping). The process runs in the foreground. Set `BARNACLES_PORT` to override the loopback port. Stop it with Ctrl+C. To refresh after importing more evidence, prepare a new directory and restart Grafana against it.

The launcher uses Grafana OSS 12.3.0, SQLite data source 4.0.9, and Treemap 2.1.1. It exposes a local Viewer, mounts the derived database read-only with attachment disabled, and discards Grafana state at shutdown. The source SQLite file, provider IDs for T3 and Codex, and rollout content are outside the container. The snapshot still contains local operational timing. Keep it private. [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/) · [SQLite plugin](https://grafana.com/grafana/plugins/frser-sqlite-datasource/) · [Treemap plugin](https://grafana.com/grafana/plugins/marcusolsson-treemap-panel/)

## Read the evidence

- **Shipping review** shows verified Linux Main x86_64 releases, explicit T3 ownership coverage, and attributable cycle time. The dial compares two completed UTC weeks at snapshot time and reports insufficient coverage when either week lacks an attributable release. Weekly points describe the imported sample. Missing weeks have no plotted value.
- **Timing breakdown** links from the treemap and the clock table. Choose a clock, then select a workflow in the table or through the filter. CI steps appear in their own clock. Counts, mean, total, and unmeasured rows keep nested clocks and coverage visible.
- **Rollout waterfall** opens around the first confirmed async cell. The selected window shows up to 24 completed spans. The next table keeps spans with missing terminal observations visible. The sessions table focuses the time window for another imported session.

The first slice uses Grafana's dark theme and native controls. The prototype's dither shader, typeface, and physical controls belong to the separate design study. The supported local snapshot currently covers one selected GitHub repository and the Linux Main x86_64 release surface.
