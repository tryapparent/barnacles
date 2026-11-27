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

The pinned Bend2 compiler builds the interval, grouping, ranking, and timeline
policies under `policy/`. The registered host paths provide HTML, embedded
fonts, DOM and browser input adapters, build packaging, Chromium verification,
and the JavaScript Worker module and Cloudflare API calls that those runtimes
require. The projection reuses the collector database and publishes only
timing intervals, generic clock labels, and an observation timestamp. It
omits thread identifiers, titles, prompt text, links, and unlinked Codex
and GitHub records. Generated files and live data stay out of Git and build
artifacts. Harbor keeps its separate session study.
When configured, the Session history link opens Plow’s private tailnet view.

## Build and verify

Run from the repository root with Node 22.18 or later and Chrome installed.

```sh
npm ci --ignore-scripts
plow_build_dir=$(mktemp -d /tmp/apparent-dev-plow-build-XXXXXX)
node dashboard/plow/build.ts "$plow_build_dir"
PLOW_SCREENSHOTS=1 node dashboard/plow/smoke.mjs "$plow_build_dir"
```

The smoke check runs the built Worker with a simulated Access session, verifies
denial with an absent or mismatched audience, and exercises the exact HTML and
response policy through Chrome at 320, 390, 640, 728, 1120, 1440, and 1920 pixels.
It checks the projector, feed availability, compact thread filtering, and
stable page regions during keyboard operation, zoom, pan, and inspection.
Screenshots are optional.

## Deployment

The GitHub Verify workflow builds and tests the preview on pull requests and
pushes to main. The production job takes the tested Worker artifact from the
same run after all verification jobs pass. It uses the main-only
`plow-production` GitHub environment. A single deployment runs at a time and
a run whose commit is no longer at the tip of main skips activation.

Configure the environment with `PLOW_CLOUDFLARE_ACCOUNT_ID`,
`PLOW_ACCESS_AUDIENCE`, and `PLOW_SESSION_NAMESPACE_ID` variables and a `PLOW_WORKER_TOKEN` secret with Individual
Workers Editor access scoped to the existing `plow-private-preview` Worker.
The deployed module checks the Cloudflare Access context for that audience.
After verifying the live Plow Session history route, set the optional
`PLOW_SESSION_HISTORY_URL` environment secret to its full private HTTPS URL.
The Worker includes the link in authorized pages with that setting.
Cloudflare Access policies, host routes, and alternate URL settings stay in
Cloudflare. The workflow checks that alternate URLs are disabled and signed-out
requests go to Access before and after activation. The workflow summary ties
the Git commit to the active Worker version and deployment ID. A failed
post-deployment check restores the prior version if its replacement is still
active. A real Google sign-in is checked separately with the authorized account.

## Publish the feed

Create a dedicated Workers KV namespace on the account that owns the deployed
Worker. Set `PLOW_SESSION_NAMESPACE_ID` to its ID and publish the first feed
before activating the Worker. The namespace needs no public host or route.
The Worker reads one versioned key after accepting the existing Access
audience and serves the result with `Cache-Control: private, no-store`.

Run both commands on the collection host. Point the publisher at the SQLite
database populated by the collector. It opens one read transaction and never
writes to the database. Pass a path to a temporary credential file through
`PLOW_KV_TOKEN_FILE` and supply `CLOUDFLARE_ACCOUNT_ID` and
`PLOW_SESSION_NAMESPACE_ID` in the publisher environment.

```sh
job=$(mktemp -d /tmp/apparent-dev-plow-feed-XXXXXX)
node dashboard/plow/build.ts --project-feed "$evidence" "$job/feed.json"
node dashboard/plow/deploy.ts --publish-feed "$job/feed.json"
```

Run this pair from one fifteen-minute timer on the collection host, with the
second command conditional on the first succeeding. Remove the temporary
directory on exit. A repeat checks the existing value and skips an identical
write. Keep the publisher and the Worker namespace in the same account. If a
projection or upload fails, the last successful feed remains available with
its original observation timestamp. The publication timer reads imported
evidence and does not collect new T3 records.
