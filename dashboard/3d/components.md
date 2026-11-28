# How a Plow landscape is assembled

## From evidence to a footprint

The standalone builder compiles [the landscape policy](landscape.bend) and bundles it alongside the browser view. Its input is the same shape as the [illustrative fixture](fixture.json). A thread starts at an absolute UTC time in milliseconds. Its intervals and event offsets use elapsed seconds. The adapter decodes clocks before passing them to the policy. The policy supplies the category durations, operation breakdowns, non-overlapping timeline segments, failure points and batch measurements. Two concurrent threads can each contribute time.

The chart layout gives each parcel a key, parent, semantic role, material, name, value and world-space rectangle. Selection, drawing and labels refer to that descriptor. Category and operation areas follow their durations. A zero-duration category has zero area. A tiny positive category still has its proportional area. Small labels can move to the edge, and a keyboard target can be larger than the ground it selects.

A thread row uses elapsed time along its horizontal axis. Ground before and after the recorded extent is meadow. A gap inside that extent is unobserved, with fog. A rust-colored survey flag marks the instant of a recorded failure. The trend has separate runs for contiguous measured batches, including a mark for an isolated batch. A missing batch measurement leaves a gap. A measured zero reaches the zero line.

## Changing the data

The standalone page starts with embedded synthetic data. The integration entry point accepts a feed or a function supplying one.

```js
const applied = await window.plowLandscape.refresh(nextFeed)
const diagnostics = window.plowLandscape.stats()
```

Pass complete snapshots. The fixture is useful for testing insertion, removal, duration changes and unavailable data. Selection can follow a surviving category or named operation within its category. The feed does not expose durable identity for individual threads or runs. Row numbers can identify different threads after an insertion. A change of cohort returns an anonymous selection to a known parent and announces the change. The trend and timeline also cover different cohorts, so their array indexes cannot be joined.

If two refreshes overlap, the latest request takes precedence. When an update fails, the farm keeps the last usable scene and marks it stale. Calling `refresh` with the same data reuses the existing parcel geometry.

## Materials and field labels

The overview uses a hillside perspective. The camera supplies the same projection parameters to the WebGL scene, the ground texture lookup, the woodland edge and the DOM overlay. During a field visit the camera keeps an oblique view. Operation captions move within the visible part of their ground footprint as the user pans. Keep the terrain and the hit targets in register when adjusting the lens.

The distant valley uses a cropped ImageGen landscape for the horizon layer. The meadow uses a fine grass tile at a consistent world scale. Twin wheel ruts are drawn on the ground. A timber fence separates the cultivated and fallow sides of each measured trend, with each percentage drawn at its batch position on inspection. The farmstead, orchard, rocks and seed heads use scene geometry outside the measured parcels. Their footprints do not contribute to any metric.

Change terrain shading, foliage and fog in [the scene](scene/). Keep sun, paths, meadow and wind consistent from one plot to the next. Use the parcel and local plant cell when varying position, rotation and size. A surviving cell should keep its plant when a neighboring parcel changes.

A label has a world anchor and a permitted footprint. Set its name and duration as horizontal text. Keep text selectable through the parcel’s keyboard target and expose both values in its accessible name.

## Checks for future changes

Run the landscape regressions from the repository root with `node --test dashboard/3d/landscape.test.ts`. The dashboard verification suite also includes these tests.

- Verify the entire overview and each selected field at the 1024 CSS pixel minimum and on a larger widescreen. Compare parcel areas to durations and keep tiny or empty entries reachable. Test crossing the [minimum width](widescreen.mjs) in both directions.
- Replay identical snapshots, reverse the completion order of two refreshes, remove a selected operation, and replace a thread with one that has the same time and label. Check focus, data and recovery together.
- Record the plant pattern and upload counters before changing one region. Compare surviving local cells. Pan and zoom without changing the data and check buffer reuse.
- Exercise missing and zero measurements, a trend singleton, a failure point and overlapping work and admission waits.
- Exercise keyboard, mouse, reduced motion, missing instancing and unavailable WebGL. Inspect both the whole farm and the focused terrain. Record the renderer and viewport when reporting performance.
