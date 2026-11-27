# Plow preview

The [private preview](https://plow.tryapparent.com/app) shows synthetic threads.
Time summary and Timeline share a UTC viewport. The summary clips each thread's
disjoint evidence intervals to that viewport, then sums and ranks them across
threads. Different threads can overlap on the clock. A category opens its
operation breakdown below the category tiles. Selecting an operation shows
only threads with matching spans in the visible UTC range and outlines those
spans on the same clock. Selecting it again clears the filter. Changing the
time range updates the matches while preserving the selected operation.

The pinned Bend2 compiler builds the interval, grouping, ranking, and timeline
policies under `policy/`. The registered host paths provide HTML, embedded
fonts, DOM and browser input adapters, build packaging, Chromium verification,
and the JavaScript Worker module and Cloudflare API calls that those runtimes
require. Generated files stay out of Git. This standalone preview uses neither
Harbor's snapshot nor the public Plow site's origin.

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
response policy through Chrome at 320, 390, 728, 1120, 1440, and 1920 pixels. It checks the
full-width layout and header artwork and exercises keyboard selection, zero
matches, range recovery, and thread details. Screenshots are optional. Open
the generated `index.html` for a standalone local preview.

## Deployment

The GitHub Verify workflow builds and tests the preview on pull requests and
pushes to main. The production job takes the tested Worker artifact from the
same run after all verification jobs pass. It uses the main-only
`plow-production` GitHub environment. A single deployment runs at a time and
a run whose commit is no longer at the tip of main skips activation.

Configure the environment with `PLOW_CLOUDFLARE_ACCOUNT_ID` and
`PLOW_ACCESS_AUDIENCE` variables and a `PLOW_WORKER_TOKEN` secret with Individual
Workers Editor access scoped to the existing `plow-private-preview` Worker.
The deployed module checks the Cloudflare Access context for that audience.
Cloudflare Access policies, host routes, and alternate URL settings stay in
Cloudflare. The workflow checks that alternate URLs are disabled and signed-out
requests go to Access before and after activation. The workflow summary ties
the Git commit to the active Worker version and deployment ID. A failed
post-deployment check restores the prior version if its replacement is still
active. A real Google sign-in is checked separately with the authorized account.
