# Plow deployment

The [Worker guide](../../plow/README.md#deployment) documents the verified
Cloudflare Worker release and private feed publisher.

## Collector delivery from GitHub Actions

After verification passes on main, the collector release job publishes an
attested source archive and its exact revision. The collector runs with
host-local configuration and publishes a derived SQLite snapshot. See the
[collector guide](../../../collector/README.md#poll-github) for the command.

The source-only archive requires a collector deployment entry point that
prepares and verifies a snapshot without starting a shipping dashboard.
Before switching a deployment that uses a bundled frontend, verify that
the poller and the session feed publisher can read the same persistent
evidence database and that the configured Session history link still has
a serving endpoint. The existing deployment and its release directory can
serve those consumers during the transition.

## T3 OTLP intake

Use the [Clanker T3 OTLP runbook](t3-otlp.md) to apply and verify the
authenticated trace stack from a release that includes the durable receiver.
