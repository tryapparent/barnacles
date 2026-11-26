# Run the Barnacles dashboards locally

The collector's [Actions import](../../collector/README.md#run-the-actions-import) and [delivery and rollout imports](../../collector/README.md#import-t3-codex-and-github-delivery) can write to the same private `evidence.sqlite`. Build a second read-only snapshot for Grafana:

```sh
node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana" tryapparent/apparent
dashboard/run.sh "$job/grafana"
```

Open [Shipping review](http://localhost:3030/d/barnacles-shipping/shipping) or the [Rollout waterfall](http://localhost:3030/d/barnacles-trace/trace). Compose runs the project in the background. Set `BARNACLES_PORT` to override the loopback port. Use `dashboard/run.sh "$job/grafana" down` to stop it. To refresh after importing more evidence, prepare a new directory and activate it. See the [Dashboard deployment guide](../enablement/deploy/README.md) for separate update and rollback commands.

The launcher uses Grafana OSS 12.3.0, Tempo 3.1.1 in monolithic mode, SQLite data source 4.0.9, and Treemap 2.1.1. It starts a fresh Tempo instance and sends the prepared `tempo.ndjson` over loopback OTLP HTTP before starting Grafana. Both services store runtime data in temporary filesystems. Regenerating a snapshot for the same source identities produces the same trace and span IDs. A new launch replays once into empty storage, and a rejected replay stops startup.

Grafana exposes a loopback Viewer and mounts the derived database read-only with attachment disabled. The original evidence SQLite file, provider IDs, and rollout content stay in local source storage. The generated archive and snapshots contain sanitized operational timing for private local use. [Tempo monolithic deployment](https://grafana.com/docs/tempo/latest/reference-tempo-architecture/deployment-modes/) · [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/)

## Changed Code Analysis

Import a scan from a local Git checkout using the repository name selected in the dashboard snapshot. The same command works with a job directory that contains only Git evidence.

```sh
node collector/changed-code.ts "$job" /path/to/repository HEAD 1000 --save-as OWNER/REPO
node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana-changes" OWNER/REPO
dashboard/run.sh "$job/grafana-changes"
```

Choose **Changed Code Analysis** from Shipping review or open [the local dashboard](http://localhost:3030/d/barnacles-changed-code/changed-code-analysis). The table shows the top 25 paths and their commit counts. The coverage panel shows the revision, number of commits scanned, and any shallow history or scan limit. This view follows the imported Git revision. Refresh the evidence by saving another scan and preparing a fresh snapshot. The read-only dashboard snapshot includes the reported paths, so keep it local for private repositories.

## Read the evidence

- **Shipping review** shows verified Linux Main x86_64 releases, explicit T3 ownership coverage, and attributable cycle time. The dial compares two completed UTC weeks at snapshot time and reports insufficient coverage when either week lacks an attributable release. Weekly points describe the imported sample. Missing weeks have no plotted value.
- **Delivery cycle time** shows mean elapsed time and stage coverage as measured shipments out of the imported sample. Use **Cycle-time PR** to inspect thread start, first commit, PR open, first PR CI, merge, release dispatch, publication backed by verified access, and the separate access check. Elapsed time uses consecutive observed clocks in order. Overall intervals reuse the underlying stages. Reimport a PR and its verified release tag to collect CI and publishing workflow clocks for an older snapshot.
- **Timing breakdown** links from the operation treemap and ranked table. The 1h and 24h timing windows end at a fixed UTC cutoff. Choose a clock, operation, or workflow. Sum and union show clipped occupancy, and untimed and unplaced counts show missing clocks. The source freshness panel shows the observed bounds for each source.
- **Rollout waterfall** opens the latest trace with both a timed async cell and a reasoning event when available. Otherwise it opens the latest recorded trace. **Session coverage** counts timed intervals, intervals with incomplete clocks, and reasoning timestamps for the selected session. Zero means the snapshot has no observations of that kind. The waterfall nests a launch envelope and its confirmed terminal wait inside the observed async cell. Other envelopes retain their own intervals. Reasoning events attach to the session root as timestamps. The tables below the waterfall give their source lines and list missing clocks. The trace root spans the first and last included observations.
- **Operation categories** appear in each waterfall span name. A label such as **Rust build +2** means two more submitted categories appear in **Span attributes** under `barnacles.categories` and in **Completed spans**. The displayed duration belongs to the entire measured interval. Reimport an existing rollout and rebuild the snapshot to add categories to its traces.
- **Recorded time by operation** and **Operations ranked by time** use the selected window and clock. Combined categories stay in **Mixed**. Use **Operation** to find a specific operation.
- **Estimated category times** fit a non-negative slope per operation. Each comparison holds the rollout session and the other operation counts fixed, absorbing the baseline elapsed time into that comparison. The model uses comparisons with count variation and requires at least five supporting receipts and positive residual degrees of freedom. The table reports seconds per command, an approximate standard error, and the estimated total across supporting receipts. A dash marks insufficient evidence. Categories can use different samples, so these totals cannot be added or treated as observed time.

The evidence scope panel names the selected repository for GitHub CI and delivery. Codex timing covers all imported rollouts across projects, including rollouts without a repository link. The first slice uses Grafana's dark theme and native controls. The prototype's dither shader, typeface, and physical controls belong to the separate design study. The supported local snapshot currently covers one selected GitHub repository and the Linux Main x86_64 release surface.
