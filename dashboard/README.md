# Dashboard

[Harbor](api.md) serves the shipping dashboard and its read-only evidence API.
See the [deployment guide](enablement/deploy/README.md) for the Clanker service.

Grafana and Tempo served an earlier preview. The setup and panel descriptions
are available in the [historical dashboard documentation](https://github.com/tryapparent/plow/blob/5b3dafaf06dd32136e5f016bc1b2a69d73d9c64f/dashboard/README.md).
The local preparation command still publishes the [SQLite snapshot and OTLP export](../evidence/README.md#published-dashboard-snapshot).
