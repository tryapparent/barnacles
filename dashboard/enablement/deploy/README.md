# Dashboard deployment

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
