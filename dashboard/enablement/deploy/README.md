# Plow deployment

The [Worker guide](../../plow/README.md#deployment) documents the verified
Cloudflare Worker release and private feed publisher.

After verification passes on main, the collector release job publishes an
attested source archive and its exact revision. The collector runs with
host-local configuration and publishes a derived SQLite snapshot. See the
[collector guide](../../../collector/README.md#poll-github) for the command.

## Collector delivery from GitHub Actions

Use the existing user timer and deployment service for source-only collector
releases. The launcher checks the exact main revision and GitHub build
attestation. It polls once on an SQLite backup, verifies the candidate snapshot,
then switches the collector's `current` link under the deployment lock. It
restarts only the poller. If the new poller does not publish a healthy snapshot
or the private Session history endpoints fail their health check, it restores
the previous release.

For an existing installation whose bundled dashboard still serves Session
history, run `dashboard/run.sh collector-cutover` once from verified source.
Set `PLOW_COLLECTOR_ROOT`, `PLOW_COLLECTOR_PORT`, and
`PLOW_COLLECTOR_PROXY_USER` to the existing deployment settings. Set
`PLOW_BEND_BUNDLE` to the existing verified compiler bundle. The installer
pins the last bundled release using the `history` link and writes systemd
drop-ins for the two existing services. It retains the port and access
configuration, verifies both history endpoints, and installs the updated
launcher at the path already used by the timer. It keeps the previous
launcher as `collector-deploy.previous.sh`. Reapplying the same configuration
does not restart the history process.

Keep the release targeted by `history` in place. Its `snapshot` directory
holds the private Session history study. The poller and feed publisher
continue to use the existing persistent evidence database. The collector
timer still uses `PLOW_COLLECTOR_REPOSITORY` and the existing access settings;
its previous compiler environment name remains accepted for compatibility.

## T3 OTLP intake

Use the [Clanker T3 OTLP runbook](t3-otlp.md) to apply and verify authenticated
trace intake from a release containing the durable receiver.

## Session history

Verify the existing private `/sessions` page and `/api/v1/sessions` through
the configured private URL. The Plow Worker uses that URL for its Session
history link. Confirm the configured endpoint before retiring its serving
process. With authorization to restore the existing route, set
`PLOW_COLLECTOR_HISTORY_HOST` to the serving unit's configured private host
and port, then run `dashboard/run.sh collector-history-ingress` using the
same collector port and proxy identity as the cutover. The command targets
only that node's exact tailnet hostname and HTTPS port. It refuses a
different existing listener or a Funnel mapping. Verify both routes from
an authorized tailnet client after applying.
