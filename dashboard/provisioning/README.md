# Run the Barnacles dashboards locally

The collector's [Actions import](../../collector/README.md#run-the-actions-import) and [delivery and rollout imports](../../collector/README.md#import-t3-codex-and-github-delivery) can write to the same private `evidence.sqlite`. Build a second read-only snapshot for Grafana:

```sh
node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana" tryapparent/apparent
dashboard/run.sh "$job/grafana"
```

Open [Shipping review](http://localhost:3030/d/barnacles-shipping/shipping) or the [Rollout waterfall](http://localhost:3030/d/barnacles-trace/trace). The process runs in the foreground. Set `BARNACLES_PORT` to override the loopback port. Stop it with Ctrl+C. To refresh after importing more evidence, prepare a new directory and restart against it.

The launcher uses Grafana OSS 12.3.0, Tempo 3.1.1 in monolithic mode, SQLite data source 4.0.9, and Treemap 2.1.1. It starts a fresh Tempo instance and sends the prepared `tempo.ndjson` over loopback OTLP HTTP before starting Grafana. Both services store runtime data in temporary filesystems. Regenerating a snapshot for the same source identities produces the same trace and span IDs. A new launch replays once into empty storage, and a rejected replay stops startup.

Grafana exposes a loopback Viewer and mounts the derived database read-only with attachment disabled. The original evidence SQLite file, provider IDs, and rollout content stay in local source storage. The generated archive and snapshots contain sanitized operational timing for private local use. [Tempo monolithic deployment](https://grafana.com/docs/tempo/latest/reference-tempo-architecture/deployment-modes/) · [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)

## Read the evidence

- **Shipping review** shows verified Linux Main x86_64 releases, explicit T3 ownership coverage, and attributable cycle time. The dial compares two completed UTC weeks at snapshot time and reports insufficient coverage when either week lacks an attributable release. Weekly points describe the imported sample. Missing weeks have no plotted value.
- **Timing breakdown** links from the treemap and the clock table. Choose a clock, then select a workflow in the table or through the filter. CI steps appear in their own clock. Counts, mean, total, and unmeasured rows keep nested clocks and coverage visible.
- **Rollout waterfall** queries Tempo for the selected session. Its root bounds cover the earliest and latest observations included in the trace. The waterfall nests a launch envelope and its confirmed terminal wait inside the observed async cell. Other envelopes retain their own intervals. Reasoning events attach to the root with their recorded timestamps. SQLite tables show the operation list, reasoning timestamps, and missing clocks below the waterfall. The root duration is observed coverage of the session, and the trace contributes no new delivery-cycle measurements.

The first slice uses Grafana's dark theme and native controls. The prototype's dither shader, typeface, and physical controls belong to the separate design study. The supported local snapshot currently covers one selected GitHub repository and the Linux Main x86_64 release surface.
