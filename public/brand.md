# Plow brand guide

Open the [visual brand guide](brand/) for examples and downloadable wordmarks.

## Identity

**Name** · Plow in prose. Use **plow** for the lowercase wordmark.

**Tagline** · Know your ground.

**Brand idea** · Good code starts with good ground. The codebase, verification, CI/CD, and tools shape what coding agents can do.

**Audience** · Engineering teams using coding agents who want to ship faster and spend less time worrying about where work is getting stuck.

**Voice** · Calm, observant, and grounded in the work. Use concrete words like *work*, *checks*, *release*, and *wait*. Use the farming metaphor for the brand thought and describe what Plow sees in plain English.

## Wordmark and type

- Set **plow** and display headlines in **Young Serif Regular (400)**. Use the lowercase wordmark on its own with clear space of roughly one lowercase letter around it. Use Ink on Cool Mist or Original Cream on Wet Earth. Transparent wordmarks are supplied in [Ink](assets/plow-ink.png) and [Original Cream](assets/plow-cream.png).
- Use **Young Serif Regular (400)** for main copy, including the intro at 17–23 px on the landing page. Use **Source Serif 4 Regular (400)** with optical sizing at 12–14 px for labels, timestamps, and controls.
- At a 1,440 px composition width, use roughly 100 px for the hero, 76 px for the second display headline, 42 px for the wordmark,. At a 375 px width, use 34 px for the hero, 25 px for the second headline, 24 px for the wordmark,.

## Color

| Color | Hex | Role |
| --- | --- | --- |
| Wet Earth | `#392820` | Dark supporting surfaces |
| Ink | `#1A130D` | Text on light and accent fills |
| Cool Mist | `#F2F5F6` | Main light background |
| Meadow | `#6A934F` | Primary accent and action fill |
| Original Cream | `#FFF4DF` | Warm text and accents on Wet Earth |

Ink labels reach 5.16:1 on Meadow. Meadow reaches 3.25:1 on Cool Mist, 3.26:1 on Original Cream, and 3.94:1 on Wet Earth for graphical accents. Original Cream reaches 12.85:1 on Wet Earth and 1.00:1 on Cool Mist. Use Ink or Wet Earth where a meaningful edge needs contrast on a light surface. Harbor chart component choices are open.

## Art and composition

Start with **The Long Field**. Keep the horizon low, leave room for the headline in the sky, and let the darker cloud bank sit above the work. Follow with **Wet Iron**, close enough to see the blade turn the soil. Use **The Plowman’s Hands** as a supporting crop. The wide scene gives the page room to breathe. The close scenes show the work up close. Keep the product dashboard’s visual direction separate.

## Stable page layout

At a given viewport size, interactions within a page must preserve the position and size of its existing regions and the full width and height of the document. Apply this rule to pointer and keyboard interactions and to every state they trigger, including animations, loading, and errors. The layout can adapt when the viewport changes or the user navigates to another page.

- Reserve an empty slot in the initial layout for each dropdown or disclosure panel. When it opens, it may fill only that slot. Keep the slot the same size when the panel closes, and keep it clear of other content and controls.
- Size replaceable regions in advance for controls, results, and feedback. Keep long content within its assigned region using wrapping, internal scrolling, or pagination. Keep scrollbar space stable wherever a scrollbar can appear.
- Verify the rule at each supported breakpoint. Compare region bounds and document dimensions before, during, and after opening, closing, and updating controls. Include the longest supported content and keyboard operation. The bounds and dimensions must match at the same viewport size.

## Homepage copy

> **Know your ground.**
>
> See where your coding agents get stuck, from the first message to a feature in customers’ hands.

**Primary action** · See a delivery. Show one feature’s path from thread to release, the elapsed time, and where to look first. Show the access check separately from the publication time. The bundled reference uses a labeled illustrative delivery. Live copy can use a verified example with the same structure.

See the [landing-page reference](index.html) and the artwork and font licenses in [assets](assets/).

## Hosting

Serve this directory on a static host with `index.html` as the directory index. The landing page is at `/` and the visual guide is at `/brand/`. Both use local artwork and font assets. The labeled delivery example on the landing page is illustrative.

### Compose deployment

The root Compose file includes the public service. Start it as its own Compose project on a host that also runs the dashboard. This lets the public site run without dashboard snapshots.

```sh
docker compose -p plow-public -f public/compose.yaml up -d --wait
curl -fsS http://127.0.0.1:3032/
curl -fsS http://127.0.0.1:3032/brand/
```

The origin binds to loopback. Point the Cloudflare Tunnel for `plow.tryapparent.com` to `http://127.0.0.1:3032`. Compose mounts the landing page, brand page, and their assets read-only. The publishing route has no access to dashboard snapshots or APIs. The static HTML, asset formats, and Compose wiring are exact-path exceptions because the browser and container runtime consume these formats directly.
