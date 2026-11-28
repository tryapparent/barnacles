# Plow MCP

Plow MCP gives coding agents read-only access to the analysis, timeline, and charts
shown in the dashboard. Add `https://plow.tryapparent.com/app/mcp` as a Streamable HTTP MCP
server in an RFC 8707-compatible client once the route is enabled. Sign in
through Cloudflare Access when the client prompts.

| Tool | Input | Result |
| --- | --- | --- |
| `get_plow_bottlenecks` | Empty object | Latest 24-hour analysis, including its window, timestamp, coverage, priorities, and thread IDs. |
| `get_plow_thread` | `threadId` from the summary | The selected thread's costs, findings, and source coverage. |
| `get_plow_timeline` | Optional `range` (`24h` or `7d`) | Anonymous dashboard timeline rows, UTC starts, and failures. Elapsed values use seconds. |
| `get_plow_charts` | Optional `range` (`24h` or `7d`) | Where time went and Agent work share for the selected time frame. Times use milliseconds and shares use basis points. |

The [Bend2 tool definitions](tools.bend) compile at startup. The existing
[analysis API host](../dashboard/prepare.ts) handles Streamable HTTP, checks the
Cloudflare assertion, and serves the same read-only SQLite projections as the
dashboard. Requests can read the latest committed analysis. A thread can age
out between calls. The API reports missing threads and unavailable analysis as
tool errors.

The activity tools read the same atomically refreshed feed as the dashboard.
The live analysis deployment publishes it to the shared activity volume.
Both tools default to 24 hours and use the dashboard's Bend2 frame, row
selection, and chart calculations. A seven-day request returns an error if
the feed does not cover the full time frame.
Each call reads the latest snapshot. Check the returned observation time to
detect a refresh between calls.

## Enable the endpoint

Use the existing `analysis-api` Compose service and existing Plow Cloudflare
Access application. The application’s policy determines which users can read
the MCP projection. Review its allowed principals before enabling the route.
The public Tunnel routes only `/app/mcp` to the loopback analysis origin and
requires the existing Access JWT audience. The origin independently verifies
the signature, issuer, audience, and expiry. The dashboard analysis HTTP routes
continue to use the configured Tailscale login.

1. In the installed analysis stack's private Compose environment, set
   `PLOW_MCP_ACCESS_TEAM` and `PLOW_MCP_ACCESS_AUDIENCE` to the same values
   as the dashboard's `PLOW_ACCESS_TEAM` and `PLOW_ACCESS_AUDIENCE`.
   Standalone deployments without live T3 history set `PLOW_MCP_FEED_DIR`
   to the dashboard's `PLOW_FRONTEND_STATE/feed` directory containing
   `timeline.json`. Compose mounts either feed read-only.
   Rebuild and recreate only `analysis-api` from the verified release using
   the existing Compose project and environment. Leave the analysis volume
   in place.
2. Use the [dashboard ingress credentials and settings](../dashboard/plow/README.md#cloudflare-ingress)
   with a Cloudflare API token that can also edit Access applications. Supply
   the configured `PLOW_ANALYSIS_PORT` when it differs from 15480. For a
   hosted client using Dynamic Client Registration, set
   `PLOW_MCP_OAUTH_REDIRECT_URI` to its exact approved HTTPS callback.
3. Run `node dashboard/plow/deploy.ts --ingress mcp-apply`. The command checks
   that the origin denies unauthenticated MCP requests, enables Managed OAuth
   on the existing Access application, reads back the application and tunnel
   configuration, and checks the edge's OAuth challenge. Connect from the
   hosted MCP client and verify OAuth sign-in, tool discovery, and all four tool
   calls with the intended user.
4. Run `node dashboard/plow/deploy.ts --ingress mcp-remove` to remove the MCP
   route. This preserves the application's Managed OAuth settings, which
   apply to the entire Access application.

Cloudflare issues the OAuth token and converts it to the signed origin
assertion. See [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

## Verify

The [Verify workflow](../.github/workflows/verify.yml) runs a real MCP client
against the HTTP handler with a synthetic SQLite projection and signed Access
assertions. It covers tool discovery, the timeline and chart values, a missing thread,
requests without a valid assertion, and the REST identity boundary. A hosted
OAuth connection requires the configured Cloudflare application and an approved
client redirect URI or an existing OAuth client registration.
