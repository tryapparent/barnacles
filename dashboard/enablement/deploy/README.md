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
different existing listener or a Funnel mapping. On hosts where Tailscale
requires elevated access, set `PLOW_COLLECTOR_SERVE_SUDO=1` to apply the
exact mapping with noninteractive sudo. Verify both routes from an
authorized tailnet client after applying.


## Analysis API

Run the version-controlled `analysis` Compose profile from verified release
source. Use a private environment file and the existing rootless Docker
context. Set `PLOW_ANALYSIS_FORGE_DIR` and `PLOW_ANALYSIS_CODEX_DIR` to the
directories holding the authorized source databases named `evidence.sqlite`.
Set `PLOW_ANALYSIS_RECEIPTS_DIR` to a private directory of the verified
binding envelopes described in the [collector guide](../../../collector/README.md#join-a-live-codex-session-to-t3-and-github).
Keep those envelopes available for replay. They can carry exact CI observations for
a subsequent poll to resolve.

Set `PLOW_ANALYSIS_USER` to the authorized tailnet login. The API binds to
a loopback host port selected by `PLOW_ANALYSIS_PORT`. The read-only API
mount contains the named analysis volume only. The refresh container takes a
consistent backup of the input and refreshes the bounded current scope every
15 minutes. Bend2 replays a thread when its projected evidence or rules change.
An interrupted refresh leaves the last committed results readable. The report marks a scope that exceeds its 50-thread limit.

To resolve native Codex bindings over the network for already imported T3
threads, supply `PLOW_ANALYSIS_T3_ORIGIN`, `PLOW_ANALYSIS_T3_INSTANCE`,
`PLOW_ANALYSIS_CODEX_INSTANCE`, and the container path
`PLOW_ANALYSIS_T3_TOKEN_PATH=/receipts/t3-read-token` with that private
read credential mounted from the receipts directory. Keep it out of Git.
Stock T3 metadata collection and exact CI receipts supply their original
evidence independently.

```sh
docker --context rootless compose --env-file "$private_env" --profile analysis \
  up -d --build analysis-refresh analysis-api
```

After approval for a private ingress, forward its HTTPS listener to the
configured loopback port with Tailscale Serve. The backend requires the
Serve-provided identity on every request and allows cross-origin reads from
`https://plow.tryapparent.com`. Configure the approved full
`https://…ts.net:PORT/api/v1/bottlenecks` URL as the
`PLOW_ANALYSIS_API_URL` secret in the Plow Worker deployment environment.
Cloudflare serves the frontend and the existing activity feed. The analysis
API answers directly from Clanker and uses no KV copy.

Verify the protected ranking endpoint and the thread detail endpoint, then
open the Access-protected app while connected to the tailnet. Grant local
network access if the browser prompts. A new
configuration adds the Bottlenecks section after the timeline. The analysis
section shows coverage and freshness, and it works independently of the
existing activity feed.
