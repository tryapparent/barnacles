# Plow deployment

The [Worker guide](../../plow/README.md#deployment) documents the verified
Cloudflare Worker release and private feed publisher.

After verification passes on main, the collector release job publishes an
attested source archive and its exact revision. The collector runs with
host-local configuration and publishes a derived SQLite snapshot. See the
[collector guide](../../../collector/README.md#poll-github) for the command.
