# Plow in 3D

Explore how agent work is divided among admission waits, provider runs and unobserved time in one interactive farm. Plots, rows of plants and localized fog represent a synthetic evidence snapshot. Select a field to see its operations, or select a thread to inspect its intervals. Use the wheel or zoom buttons to move closer. Use **Whole farm** or Escape to return.

**Widescreen only.** The farm requires a browser viewport at least **1024 CSS pixels wide**. Design and verify changes against the full landscape composition. Below that width, show the window-size message and keep the 3D renderer inactive. Widening the window opens the scene automatically.

## Build and open

Install the locked dependencies and pinned compiler as described in [Contributing](../../CONTRIBUTING.md). From the repository root, build the standalone page into a directory of your choice.

```sh
node dashboard/3d/build.mjs "$output_directory/dashboard.html"
```

Open the HTML file directly in a browser. It works offline and includes the assets, fonts, compiled evidence policy and synthetic fixture.

## Landscape

[The evidence policy](landscape.bend) uses Plow’s interval, summary and trend policies. [The view](view/) projects the data into parcels, time intervals and label anchors. React controls and the [WebGL scene](scene/) share those coordinates. The foreground oak, woodland and distant ridges are [painted scenery layers](scenery/) that move at different rates as the camera travels. The [component guide](components.md) covers updating the world and the limits of snapshot-local identity.

## Field labels

Keep field names, operation names and durations in the established Plow serif lettering. Anchor the text to its parcel and keep the baseline horizontal and the numerals readable as the camera moves.

## Host boundaries

The exact host paths registered for this prototype cover the WebGL and DOM APIs, React presentation, static assets, synthetic fixtures, build and verification I/O. Bend2 owns evidence decisions. Camera transforms, terrain construction, visual level of detail and projected label placement belong to the renderer.
