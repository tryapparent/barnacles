# Plow deployment

The [Worker guide](../../plow/README.md#deployment) documents the verified
Cloudflare Worker release and private feed publisher.

After verification passes on main, the collector release job publishes an
attested source archive and its exact revision. The collector runs with
host-local configuration and publishes a derived SQLite snapshot. See the
[collector guide](../../../collector/README.md#poll-github) for the command.

## Collector delivery from GitHub Actions

The source-only archive requires a collector deployment entry point that
prepares and verifies a snapshot without starting a shipping dashboard.
Before switching a deployment that uses a bundled frontend, verify that
the poller and the session feed publisher can read the same persistent
evidence database and that the configured Session history link still has
a serving endpoint. The existing deployment and its release directory can
serve those consumers during the transition.

## T3 OTLP intake

Use the [Clanker T3 OTLP runbook](t3-otlp.md) to apply and verify authenticated
trace intake from a release containing the durable receiver.

## Session history

Verify the existing private `/sessions` page and `/api/v1/sessions` through
the configured private URL. The Plow Worker uses that URL for its Session
history link. Confirm the configured endpoint before retiring its serving
process.
