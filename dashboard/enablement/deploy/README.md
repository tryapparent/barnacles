# Plow deployment

The [dashboard guide](../../plow/README.md#deployment) documents the
Clanker Compose release, projected timeline feed, and Cloudflare ingress.

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
holds the private Session history study. The poller and dashboard feed refresh
continue to use the existing persistent evidence database. The collector
timer still uses `PLOW_COLLECTOR_REPOSITORY` and the existing access settings;
its previous compiler environment name remains accepted for compatibility.

## T3 OTLP intake

Use the [Clanker T3 OTLP runbook](t3-otlp.md) to apply and verify authenticated
trace intake from a release containing the durable receiver.

## Session history

Verify the existing private `/sessions` page and `/api/v1/sessions` through
the configured private URL. The Plow dashboard uses that URL for its Session
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
consistent backup of the input and refreshes the rolling 24-hour and seven-day
views every 15 minutes. Both end at the refresh’s UTC cutoff and cover
captured T3 thread creation and run activity in their respective windows.
The REST summary defaults to 24 hours. The dashboard requests the weekly
priorities with `?range=7d`. A closed
admission or run interval that crosses the boundary also qualifies. Thread
metadata edits alone do not qualify. The cohort includes threads with partial
source coverage. Code paths that discover new Codex links have their own
bounded read budget. The dashboard summary has no 50-thread limit.

Bend2 ranks completed, exactly linked CI findings in the window by distinct
threads affected and unique job occurrences. A shared job can affect several
threads. Its occurrence is counted once. The thread picker shows full-thread
diagnostic clocks. A missing source or clock limits what the summary can
observe. When available, put a private [outcome-delay ledger](../../../collector/README.md#measure-confirmed-outcome-delay)
at `outcomes/outcome-delays.json` under the receipts directory. Bend2 validates
and unions the original intervals before clipping them to each report window.
The API publishes only aggregated impact and coverage. Delay is unknown when
the ledger is absent or insufficient. An interrupted refresh leaves the last
committed results readable.

The summary API includes at most three `priorities`. Bend2 ranks patterns
with unique confirmed outcome delay first, by attributed milliseconds and
measured outcomes. Observed diagnostics fill any remaining slots. They are
ranked by distinct threads affected, then distinct events. A T3 admission
diagnostic measures the observed request-to-start intervals clipped to the
window. A CI diagnostic groups exactly linked failed or timed-out jobs by
repository, workflow ID and retained job label. Each job contributes once
across threads, with execution time accounted for only when its clocks are
available. These diagnostics do not estimate outcome delay. Each priority
includes a next step, its ranking basis, affected counts and timing coverage.
The list can be empty with insufficient evidence. The existing analysis
summary and thread detail continue to be available for existing clients.

For live analysis set `PLOW_ANALYSIS_HISTORY_DIR` to the existing T3
OTLP evidence volume's mountpoint and set `PLOW_ANALYSIS_T3_INSTANCE`
and `PLOW_ANALYSIS_CODEX_INSTANCE` to the exact stored source namespaces.
The worker uses the stock T3 poller's allowlisted run and provider
projections as its T3 input and uses the live GitHub and Codex databases
read-only. It loads seven days of projections for the configured T3 instance.
The same refresh publishes an anonymous activity feed to the Compose activity
volume for the dashboard and MCP. Only the refresh container writes to that
volume. The feed and rankings share a refresh cutoff.
It reuses the original Bend2 native-session check and leaves missing or
ambiguous binding evidence out of the trace join. A PR link supplies
repository context. The exact CI join still requires the original
query or watch receipt identifying the run, attempt, and head.

The collectors share metadata through the evidence volume. This
connection uses the existing T3 read credential on the history service
and requires no additional credential on the analysis worker. A
standalone analysis without the history volume can still use
`PLOW_ANALYSIS_T3_ORIGIN` and `PLOW_ANALYSIS_T3_TOKEN_PATH` for the
bounded network lookup. Point the token path to a mounted read-scoped
credential and keep it out of Git.

The existing collector release timer upgrades the two installed
analysis containers after the history service. It reads
`PLOW_ANALYSIS_DEPLOY_ENV` or the private
`${XDG_DATA_HOME:-$HOME/.local/share}/plow/analysis/compose.env`.
`PLOW_ANALYSIS_HISTORY_DIR` opts the analysis project into promotion.
Readiness requires a published refresh and the API's unauthorized-request
check. The existing analysis volume and loopback ingress are reused.
The refresh log reports the number of stored T3 projections, strong
bindings, sessions with spans, ambiguous bindings, and exact CI receipts
joined in each pass.

After approval for a private ingress, forward its HTTPS listener to the
configured loopback port with Tailscale Serve. The backend requires the
Serve-provided identity on every request and allows cross-origin reads from
`https://plow.tryapparent.com`. Configure the approved full
`https://…ts.net:PORT/api/v1/bottlenecks` URL as the
`PLOW_ANALYSIS_API_URL` setting in the private Plow frontend
environment file. The browser connects to that endpoint over the tailnet
and renders the analysis alongside the timeline served by the Clanker
dashboard.

Verify the protected ranking endpoint and the thread detail endpoint, then
open the Access-protected app while connected to the tailnet. Grant local
network access if the browser prompts. A new
configuration adds What to fix today after the timeline. The panel shows
the ranked priorities and their evidence, and it works independently of
the existing activity feed.
