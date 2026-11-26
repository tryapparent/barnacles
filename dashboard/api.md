# Shipping review API

The harbor dashboard and an automated reader use the same versioned read-only
HTTP interface. The API reads the prepared SQLite evidence snapshot.
Bend2 owns evidence selection, milestone state and elapsed time, ranking,
pagination, and shipment counts. The Node host handles HTTP, JSON and SQLite I/O.

## Run locally

```sh
node dashboard/prepare.ts "$job/evidence.sqlite" "$job/grafana" OWNER/REPO
node dashboard/prepare.ts --serve "$job/grafana"
```

The API listens on `127.0.0.1:3031` by default. Pass a port as the last argument
to override it. Keep the prepared directory private. The prepare command writes
the read-only database and a compiled Bend2 policy for the API in the same
atomic snapshot. Rebuild snapshots prepared before this interface was added.
Each request opens a read transaction against the current database, so an
atomic replacement of `dashboard.sqlite` prepared with the same code becomes
visible on the next request.

## Open the harbor dashboard

Build the React client into the private job directory and serve it on the API's
origin.

```sh
npm ci --ignore-scripts
npm run build:harbor -- --outDir "$job/harbor"
node dashboard/prepare.ts --serve "$job/grafana" 3031 "$job/harbor"
```

Open [Shipping review](http://127.0.0.1:3031/). The browser requests the same
JSON as an agent. Review filters and PR detail links are encoded in the URL.
The page shows the snapshot timestamp and supports keyboard navigation and
reduced motion.

For a private Tailscale Serve deployment, set `BARNACLES_PROXY_HOST` to the
exact Serve hostname and port as sent in the HTTP Host header, and
`BARNACLES_PROXY_USER` to the authorized Tailscale login. This keeps the app
bound to loopback and requires the trusted Serve identity on every request,
including the assets and JSON routes. Use these settings only when the
proxy strips client-supplied identity headers and sets its own.

The scene uses the approved generated artwork for the two working shores.
Its references are the [Clyde shipyard archive](https://i.rcahms.gov.uk/canmore/x/SC01268607.jpg)
and the [Historic England Whitby archive](https://historicengland.org.uk/images-books/photos/item/AA63/04965).
The canvas draws at most four ships per stage for readability. The Fleet
manifest lists every observed PR with a link to its evidence. Vessel size uses
depth perspective because the evidence source does not retain PR diff sizes.

The browser presentation uses React, Vite, Canvas and SVG. TypeScript decodes
API responses and renders the shared evidence. The local Button and
NativeSelect adapt the [shadcn registry](https://ui.shadcn.com/docs/components/native-select)
under its [MIT license](web/assets/SHADCN-LICENSE). The gauge adapts the
[dithercn dial](https://dithercn.dev/docs/charts/gauge) under its
[MIT license](web/assets/DITHERCN-LICENSE). The self-hosted Geist Pixel Square
font carries its [OFL license](web/assets/OFL.txt).

## Read the evidence

Start at [the API index](http://127.0.0.1:3031/api/v1) to discover routes and
parameters. The routes accept GET and return JSON.

```sh
curl --fail-with-body --get http://127.0.0.1:3031/api/v1/shipping \
  --data-urlencode 'from=2026-11-09' \
  --data-urlencode 'to=2026-11-26T18:29:24.000Z' \
  --data-urlencode 'clock=Tool envelopes'
```

Dates use UTC. Pass a date such as `2026-11-26` for midnight, or a UTC
timestamp with seconds and optional milliseconds ending in `Z`. Bounds are
inclusive. Omit `to` for the snapshot cutoff and `from` for the preceding
30 days. A later `to` is capped at the snapshot cutoff. A range can span
up to 366 days. The response includes both `snapshotAt` and its effective
`window`.

| Field | Meaning |
| --- | --- |
| `snapshotCoverage` | Unique observed PRs, verified Linux Main x86_64 shipments, and shipments with an attributable thread-to-publication cycle in the prepared sample. |
| `cycleComparison` | The comparison of the latest two completed UTC weeks at snapshot time, with direction, signed delta, and each week's measured mean and sample count. An insufficient comparison has a null delta. |
| `shipments` | PRs with publication inside the selected window and verified access by its cutoff. Weekly buckets use Mondays in UTC. A missing bucket means the selected sample supplied no verified shipment for that week. |
| `operations` | Ranked elapsed times ending at the snapshot cutoff, using the default 24-hour reporting window. Available clocks and operation names are included. Cumulative spans can overlap. |
| `fleet` | PRs with a milestone in the last 24 hours of the effective window, or the whole window if shorter. Each PR has one current stage, a last observed time, and a detail link. |
| `deliveries` | PRs with a milestone inside the effective window, ordered newest start first with observed PR clocks as a fallback. Each item has the ordered milestone list and a detail link. |

The operation clock defaults to `Tool envelopes`. Other clocks are
`Async cells`, `CI queue`, `CI execution`, and `CI steps`. Omit `operation`
for all rows of the selected clock, or use an exact name from
`operations.operationOptions`. A clock without evidence returns an empty list.
Use `limit` (1–100, default 25) and `offset` (default 0) to page through
deliveries. Advance using `deliveries.nextOffset`, which is null at the end.
`deliveries.maxMeasuredMillis` is the longest sum of observed consecutive
intervals across the selected delivery rows, independent of pagination. The
browser uses it to hold the scale steady as more rows enter the list. Row widths
use a compressed scale so short intervals stay visible alongside long ones.
Selecting a ship scrolls to its delivery row and opens the milestone waterfall
there. The link keeps the PR number and cutoff so it can be opened directly.
Waterfalls use a linear UTC scale.

Follow a record's `detailPath` to read `/api/v1/pull-requests/{number}`. It
carries an `asOf` cutoff so the summary and detail use the same time. You can
also omit the cutoff to get the latest known state. Each detail includes the
source and, when available, a pull request, workflow, or release link for each
observed milestone. A null timestamp or interval means unknown. An interval
requires both consecutive clocks in order. Publication and verified access
are separate milestones. A PR can appear in the fleet and delivery list
without a qualified Linux release. The API includes PR-scoped records and
does not infer a repository for unlinked T3 threads. The source does not retain
PR diff size.

Invalid requests return `400` with an `error.code` and `error.message`. A PR
with no observed milestone by the requested cutoff returns `404`. A valid
window with no matching evidence returns `200` with empty collections.

## Verify

Run `BARNACLES_TEST_DIRECTORY="$job" npm run verify -- dashboard evidence`.
The HTTP integration test prepares synthetic evidence, queries the running
API, compares publication with verified access, checks missing milestones and
pagination, and replaces the database while the server is running.
