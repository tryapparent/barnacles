# Plow landscape prototype

Explore the synthetic thread dashboard as a continuous farm. Click a field, operation, trend position or thread to move the camera there. Use the zoom buttons or wheel for a closer look, drag to pan, and use Whole farm or Escape to return.

From the repository root, install the locked dependencies and compiler as described in [Contributing](../../CONTRIBUTING.md). Build to a file of your choosing.

```sh
node dashboard/3d/build.mjs "$output_directory/dashboard.html"
```

Open the resulting file in a WebGL-capable browser. The build embeds the seven local landscape images, the fixture, the existing React dashboard and the compiled Bend2 policy. The standalone file runs without a server or feed credentials. The normal dashboard build and deployment have their own entry points.

## Source

- [Scene](scene/) contains the WebGL renderer, instanced vegetation, ground materials, volumetric fog shaders, chart plots and thread strips.
- [View](view/) contains navigation, drill-down, accessible HTML labels, and the farm styles.
- [Fixture](fixture.json) contains illustrative intervals. The build uses the tracked Plow dashboard shell on this branch.
- [Lettering study](studies/lettering.html) compares painted labels and survey stakes on stills from the synthetic prototype. Open the HTML file directly and switch materials or treatments.
- [Component design](components.md) describes the proposed data-driven architecture and verification cases.

The host exception for this prototype preserves its browser-specific WebGL, Canvas, DOM controls and build wiring. Its existing chart and summary policies compile from Bend2 through the Plow builder. Camera positions, graphical parcel splits, mesh generation and projected label placement are presentation concerns. The standalone build contains synthetic data only.

## Verification

At desktop and phone widths, open every category, select and deselect its operations, open each batch, inspect a thread, then return to the overview. Check pointer and keyboard paths, zoom, drag and resize. Unobserved intervals use animated ray-marched fog. With reduced motion enabled the volume should stay still while navigation remains usable.

The narrow overview inherits a layout constraint. At 320 pixels the Admission wait field occupies about 54% of the visible parcel area while its duration represents 65% of the displayed total. Read exact durations from the labels. The component design specifies the geometry repair.
