# Dashboard deployment

## Harbor on Clanker

Clanker runs Harbor and its evidence poller as enabled systemd user services. The
existing Tailscale Serve route is the permanent Harbor URL. To find it, read the
loopback port from Harbor's `ExecStart` and match that port to its proxy target
in Serve. Keep the private URL in host configuration.

```sh
systemctl --user show barnacles-harbor.service -p WorkingDirectory -p ExecStart
tailscale serve status
```

For an authorized deployment, stage the reviewed source, built frontend and
matching prepared snapshot together in a new release directory. Verify the
candidate locally on a separate loopback port. Stop that temporary process
after the check.

Record the previous target of the deployment's `current` symlink. Stop
`barnacles-harbor-poller.service`, then `barnacles-harbor.service`. Atomically
replace the symlink with one pointing at the staged release, then start Harbor
and its poller. Reuse the existing service ports, Serve route, identity settings
and persistent collector state. Verify the dashboard, an asset and
`/api/v1/shipping?limit=1` through the same authorized tailnet URL. If the
release fails, repeat the switch with the previous target and verify again.

### Collector delivery from GitHub Actions

After verification passes on main, the `collector-release` job publishes a
build-attested archive of the tracked source and built frontend. The
Clanker deploy command requires an attestation from the expected GitHub-hosted
workflow, source ref, and exact current main commit.

Run `dashboard/run.sh collector-deploy` with these host-local environment
variables. The systemd user deployment service runs the same command from an
installed copy of the launcher.

| Variable | Value |
| --- | --- |
| `PLOW_COLLECTOR_ROOT` | Existing release root containing `current`, `polling`, and `releases` |
| `PLOW_COLLECTOR_PORT` | Existing dashboard loopback port |
| `PLOW_COLLECTOR_REPOSITORY` | Repository the collector reads |
| `PLOW_COLLECTOR_PROXY_USER` | Existing dashboard proxy login |
| `BARNACLES_BEND_BUNDLE` | Same verified local compiler bundle used by the poller |

The command serializes with the existing deployment lock. It prepares a
candidate snapshot from a local SQLite backup, checks the dashboard and API
over loopback, then switches `current` and waits for a fresh snapshot from the
running collector. Failed activation restores the previous release. Keep
collector schema changes compatible with that rollback window because both
releases use the same persistent evidence database. The optional T3–Codex
configuration stays in the poller service's local environment.

Run the deployment service on demand for the first release. After verifying
the result, enable its timer for subsequent releases. The timer checks for
code updates separately from the collector's 15-minute data refresh.

## Grafana and Tempo

The repository root names and assembles one Compose project. Dashboard owns the Grafana and Tempo services, provisioning, replay, smoke tests, and recovery. Evidence owns the [snapshot contract](../../../evidence/README.md#published-dashboard-snapshot). Collector remains a host-side CLI for selected source inputs and credentials. A recurring import job can join through its own Compose include.

The two Compose files are exact-path Bend2 exceptions because Compose consumes declarative YAML for service wiring. Snapshot preparation still uses the compiled Evidence policy.

## Start or refresh

Use Docker Compose v2.20 or later and Node 22.18 or later. From the repository root, prepare a new generation in a private directory, then run:

```sh
dashboard/run.sh "$snapshot" config
dashboard/run.sh "$snapshot"
```

`run.sh` provides the snapshot bind paths and container user, validates the snapshot format before touching the services, recreates Tempo with empty temporary storage, and checks that the one-shot replay job succeeds before activating Grafana. Tempo and replay use the Compose network. Grafana binds to localhost port 3030 by default. The launcher prints Grafana readiness once its health check passes. Trace queries can be temporarily unavailable while refreshing. Keep snapshots immutable and serialize updates within the same Compose project.

If refresh fails during replay or Grafana startup, run `dashboard/run.sh "$previous_snapshot"` to replay and restore the previous generation. A failed snapshot build is safe to retry into a new directory. Use `COMPOSE_PROJECT_NAME` and `BARNACLES_PORT` to isolate a smoke deployment from a running installation.

## Update Grafana only

```sh
BARNACLES_GRAFANA_IMAGE='grafana/grafana:VERSION@sha256:DIGEST' dashboard/run.sh "$snapshot" grafana
```

The `grafana` command checks that the mounted snapshot matches and then reconciles only Grafana. It retains the running Tempo container and its replayed data. Roll back with the previous digest and the same command. Record the selected pin in the owner Compose file for a lasting upgrade. If a Tempo upgrade or daemon restart empties its temporary store, rerun the full launcher with the active generation.

Stop the project with `dashboard/run.sh "$snapshot" down`. The snapshot remains on disk.

## Verify

```sh
BARNACLES_COMPOSE_SMOKE=1 npm run verify -- dashboard
```

The smoke test runs the root Compose project on synthetic evidence and checks Grafana provisioning, datasource health, and a trace returned through Grafana. It updates Grafana to a second pinned version and back, verifies Tempo and the snapshot stay in place, then activates a new generation and rolls it back on the same Grafana image.
