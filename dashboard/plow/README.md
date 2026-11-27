# Plow session activity

[Plow session activity](https://plow.tryapparent.com/app) reads a private projection of the
collector's T3 evidence. It displays the ten newest imported threads with at
least one measured interval. Run time measures elapsed provider time. Admission
time runs from request to provider start. Unknown endpoints remain unmeasured,
and failures appear only when the source records a failed run with a measured
end. The observation timestamp comes from the selected thread records.
Time summary and Timeline share a UTC viewport. The summary clips each thread's
disjoint evidence intervals to that viewport, then sums and ranks them across
threads. Different threads can overlap on the clock. A category opens its
operation breakdown below the category tiles. Selecting an operation shows
only threads with matching spans in the visible UTC range and outlines those
spans on the same clock. Matching rows close up inside the fixed-height
timeline viewport. Selecting the operation again clears the
filter. Changing the time range updates the matches while preserving the
selected operation.

**Agent work share** averages each measured thread’s provider-run time divided
by its classified provider-run plus admission-wait time. Bend2 groups threads
in creation order into batches of ten. It keeps up to five complete batches
and skips the unfinished batch in the chart. Unknown clocks retain their
thread positions. A batch without classified time appears as a gap. The ten
detailed timeline traces and their visible-range filters are separate from
historical batches.

React renders the dashboard shell and operation summary with the shared
[shadcn controls](../web/controls.tsx). The timeline renderer handles the
custom UTC geometry, scrolling, and brush interaction. Vite bundles the UI
into the origin-served page with the existing fonts and field artwork. The
Batch data disclosure uses [UI SDK Collapsible](https://ui-sdk.dev/docs/react/components/collapsible)
with the shared shadcn button.

The pinned Bend2 compiler builds the interval, grouping, ranking, and timeline
policies under `policy/`. The registered host paths provide HTML, embedded
fonts, DOM and browser input adapters, build packaging, Chromium verification,
the Node HTTP adapter, and the Docker Compose and Cloudflare API wiring those runtimes require. The projection reuses the collector database and publishes only
timing intervals, generic clock labels, and an observation timestamp. It
omits thread identifiers, titles, prompt text, links, and unlinked Codex
and GitHub records. Generated files and live data stay out of Git and build
artifacts. When configured, the Session history link opens Plow’s private tailnet view.

## Build and verify

Run from the repository root with Node 22.18 or later and Chrome installed.

```sh
npm ci --ignore-scripts
plow_build_dir=$(mktemp -d /tmp/apparent-dev-plow-build-XXXXXX)
npm exec -- tsc -p dashboard/web/tsconfig.json
node dashboard/plow/build.ts "$plow_build_dir"
PLOW_SCREENSHOTS=1 node dashboard/plow/smoke.mjs "$plow_build_dir"
```

The smoke check serves the built page over loopback HTTP with signed fixture
tokens. It checks Access denial, response headers, and Chrome at 320, 390,
640, 728, 1120, 1440, and 1920 pixels. It exercises compact thread filtering
and stable page regions during keyboard operation, zoom, pan, and inspection.
It also checks the empty and unavailable feed states. Screenshots are optional.

## Deployment

The dashboard runs as the `plow-dashboard` service in the root Compose file.
It binds to Clanker's loopback on port 3033 by default and mounts only the built
page module, its JWT verification dependency, and a private projected feed.
The feed is generated from the existing evidence SQLite database through
Bend2. Projection runs read-only and atomically replaces the last usable feed
after verification. The origin checks the Cloudflare Access JWT signature,
issuer, audience, and expiry before returning dashboard content.

The user timer builds the dashboard from the same attested main revision
activated by the [collector release](../enablement/deploy/README.md). Both
use the collector's deployment lock. Compose starts the dashboard only
after a feed exists and checks it before recording the active revision.
If a replacement fails its Compose health check, the launcher restores the
previous dashboard release. The timer refreshes the feed every 15 minutes
and applies a new release when the collector's current revision changes.

Set these inputs in `~/.config/plow-frontend/compose.env`, mode 0600.

| Input | Purpose |
| --- | --- |
| `PLOW_ACCESS_TEAM` | Existing Cloudflare Access team name |
| `PLOW_ACCESS_AUDIENCE` | Audience tag of the existing Plow Access application |
| `PLOW_EVIDENCE_DATABASE` | Absolute evidence SQLite path |
| `PLOW_BEND_BUNDLE` | Absolute path of the verified installed Bend2 compiler bundle |
| `PLOW_FRONTEND_STATE` | Private application state directory for the built release and projected timeline |
| `PLOW_FRONTEND_PORT` | Optional loopback port, defaults to 3033 |
| `PLOW_SESSION_HISTORY_URL` | Optional private HTTPS URL ending in `/sessions` |

Install the generated units from the verified source in the existing collector
release layout. Run these commands as the Clanker deployment user.

```sh
plow_source="$HOME/.local/share/barnacles/harbor/current/source"
plow_units="$HOME/.config/systemd/user"
for unit in service timer; do
  node "$plow_source/dashboard/plow/deploy.ts" --unit "$unit" > "$plow_units/plow-frontend.$unit"
done
systemctl --user daemon-reload
systemctl --user start plow-frontend.service
systemctl --user enable --now plow-frontend.timer
curl -fsS -o /dev/null http://127.0.0.1:3033/_health
```

For an isolated candidate, build the page into a private job directory and
set `PLOW_FRONTEND_ASSETS` to the build directory and `PLOW_FRONTEND_FEED`
to a directory containing `timeline.json`. Set `PLOW_RELEASE` to the candidate
SHA, the same Access variables as above, and an unused loopback port. Run
`docker compose -p plow-dashboard-candidate up -d --wait plow-dashboard` from
the candidate source. Check `/_health` for 204 and an unauthenticated request
to `/app` for 403. A repeat should converge on the same container.

### Cloudflare ingress

Cloudflare keeps the existing DNS record, HTTPS, and Access application.
The checked-in ingress command verifies that Access covers `/app` and
`/app/*`. It moves exactly `/app` and `/app/` to the Docker origin in the
existing Plow Tunnel and requires Access validation on the Tunnel. Other
paths continue to the public site on 3032. The command verifies the new
route by reading it back, removes the superseded Worker route, and verifies
the signed-out redirects and public routes. It restores the legacy routing
if the cutover fails.

Set `PLOW_CF_ACCOUNT`, `PLOW_CF_ZONE`, `PLOW_CF_TUNNEL`, and
`PLOW_CF_ACCESS_APP` to the existing resource IDs. Inject a credential file
through `PLOW_CF_TOKEN_FILE`. It needs permission to read the Access
application, edit the Plow Tunnel configuration, and manage the zone's Worker
route. Supply the same Access and origin settings as the Compose service.

```sh
node dashboard/plow/deploy.ts --ingress status
node dashboard/plow/deploy.ts --ingress apply
```

To verify authenticated ingress during cutover, also set
`PLOW_CF_SMOKE_ACCESS=1` and `PLOW_RELEASE` to the active dashboard revision.
With Access policy and service token write permission, the command creates
a 10-minute service token scoped to this application, checks both paths for
the expected `X-Plow-Revision`, and revokes the token and temporary policy.
The normal sign-in policy is kept. Once verified, disable the retired
`plow-session-feed.timer`. For rollback, re-enable the legacy feed timer,
refresh the old KV feed, and run
`node dashboard/plow/deploy.ts --ingress rollback`. The rollback uses the
retained Worker and restores its former route.
