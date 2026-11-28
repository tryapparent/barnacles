# Reusing the landscape as evidence changes

This is a design proposal for the next implementation. The branch preserves the interactive prototype. Today it reconstructs plots from the HTML and SVG, including accessible descriptions, and repaints the terrain when the board changes.

## One footprint for drawing and interaction

Let the existing Bend2 policy produce the clipped data and durations. Let the chart layout turn them into exact world-space footprints. Give React and WebGL the same descriptors. An example operation parcel would contain a snapshot key, parent key, operation name, category, duration in milliseconds, rectangular footprint and label anchors. A trend needs separate measured runs and isolated points. A failure needs a point and an accessible target. A missing sample breaks a line.

Build reusable soil, crop and fog renderers around the footprint. Keep paths, meadow, sunlight and wind shared across the world. Bind each label to an anchor and a permitted footprint, with a priority and minimum readable screen height. Swapping a mud inscription for a floating label or a sign changes its material and placement. The same semantic name, duration, selection target and accessible control still identify the parcel. Cache glyph shapes. A timer update can replace the numeral glyphs without rebuilding a gate or replanting a field.

Preserve exact normalized area using the policy denominator. At 320 pixels move labels to the path edge or reveal them on selection. Give tiny plots a distinct keyboard or list target. Keep time labels horizontal at reading distance. Reserve fog for unobserved intervals within the recorded extent. Outside the interval is meadow. A measured zero, an unknown and a point event require different representations.

## A stable landscape

Use a stable local origin and spacing for each perennial field. Seed plants by parcel identity, material type and local cell coordinates. Sample texture coordinates and wind phase in world space, so furrows and light remain continuous across parcel boundaries. When a field grows, keep the plants in cells that remain inside the footprint and add plants in the newly covered cells. Shrinking removes the uncovered cells. Shade both old and new plants with the same sun. Clip ground cover, labels and hit regions from one layout result.

The current feed has scoped ordinals, clocks and labels. Distinct threads can share all those values. Keep selection local to one snapshot until evidence exposes a privacy-reviewed opaque identity. Never manufacture a persistent key from the display row or timestamp. Timeline traces and the trend history cover different cohorts. Their array positions cannot identify the same thread.

On a later keyed feed, apply one complete snapshot atomically. Keep focus on a surviving key, even if its row moves. When evidence changes or splits an interval beyond recognition, return focus to the nearest surviving parent and announce it. Keep the last usable scene during a transient refresh error, with an explicit stale status. Changes to category shares can move neighboring parcel boundaries. Maintain each surviving parcel’s local planting pattern across that transition.

## Frame and update costs

Separate evidence, layout, view and material changes. An evidence revision invalidates the affected regions and distribution layout. A camera move changes projection, visibility, picking and label detail. A selection changes its outline and readout. Wind updates a shader uniform. Batch visible vegetation instances, keep static buffers resident, and render the fog only inside its projected volume. Use textured ground cover at distance and on devices without plant instancing. Pause animation while hidden and honor reduced motion. Profile frame time, draw calls, reuploaded bytes and peak instances on real phones before selecting budgets.

## Migration and checks

1. Replace operation-area reads from accessibility text with structured policy durations. Share the category, operation and timeline geometry with the hit targets. Check the 320 px case and all-zero, tiny and mixed known/unknown spans.
2. Move plants and ground geometry to keyed buffers. Insert, reorder, resize and remove synthetic records while a parcel is selected. Compare unaffected cell positions and ensure keyboard focus survives wherever identity permits.
3. Connect the trend’s measured runs and singleton marks to the renderer. Check gaps, late evidence, duration ties, overlapping thread time and changes in cohort membership. Never smooth across a missing measurement.
4. Introduce lettering as an independent renderer. Compare mud, hovering letters and field signs at overview, drill-down and phone scales. Hide or simplify decorative lettering when the exact visible label would otherwise become illegible.
5. Compare identical snapshots before and after replay. Confirm equal area, selection and plant placement. Capture stationary wind, reduced motion, wheel zoom and repeated refresh while checking GPU upload and redraw counters.
