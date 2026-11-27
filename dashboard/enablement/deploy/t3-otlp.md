# T3 OTLP on Clanker

This rollout requires a verified release containing both the deployment
launcher and the durable `collector/t3-otel/compose.yaml` stack. The
Collector owner supplies the pinned image and trace pipeline, backend receiver,
database schema, named queue and evidence volumes, and restart policy. Use the
release's source directory so the launcher, config and receiver build all come
from the same revision. Use the existing [collector release provenance
checks](README.md#collector-delivery-from-github-actions). Keep the release
directory private and preserve the attested archive's file modes during
extraction so the unprivileged receiver can read the sources copied into its
image. Extract the verified archive in a private directory with
`tar --same-permissions`.

The Compose project `plow-t3-otel` owns the intake lifecycle. On Clanker the
enabled rootless `docker.service` and user lingering provide startup at boot.
The Compose restart policy resumes the running services. The rootless project
keeps its queue and SQLite data across release changes. Codex keeps its
existing services and bearer. Each independently attributed T3 instance needs
its own trusted receiver identity. No sender device files are mounted or read.
Keep the applied release directory available for Compose's configuration
mounts. The dashboard release switch does not apply the T3 project.

## Host inputs

Point `PLOW_T3_DEPLOY_ENV` at a private, mode `0600` Compose environment
file outside the release. Set these values in that file.

| Input | Value |
| --- | --- |
| `PLOW_T3_INSTANCE` | Stable trusted instance label for this intake |
| `PLOW_T3_OTLP_PORT` | Reserved Clanker loopback port for T3 traces, default `4319` |
| `PLOW_T3_INGRESS_SECRET_FILE` | Absolute path to the T3 sender bearer file |
| `PLOW_T3_BACKEND_SECRET_FILE` | Absolute path to a distinct Collector-to-SQLite bearer file |

Provision separate high-entropy bearer values through the authorized secret
store. Place the runtime files in a private directory and keep their values
out of the Compose environment file, command arguments and logs. File-backed
Compose secrets retain host ownership and mode. Materialize files with mode
`0400` owned by the container service UID in the rootless namespace
(`10001:10001` in the rollout contract). To set that ownership, use the
pinned volume-init image from the same Compose spec with network disabled and
only the private secret directory mounted, and run `chown 10001:10001` on the
two named files in that mount. Verify mode and readability in the service
namespace without displaying the values.
[Docker Compose file secret permissions](https://docs.docker.com/reference/compose-file/services/#secrets)

For rotation, point the environment file at new versioned secret file paths
and reapply. A changed mount source makes Compose recreate the affected
containers. Retain the previous private references during the rollback
window. Distribute only the new ingress bearer to authorized senders.

## Apply and verify locally

Use a shell with the T3 Compose inputs supplied by the private environment
file. Clear any shell overrides for those inputs and for `COMPOSE_PROJECT_NAME`.
Use `PLOW_T3_COMPOSE_PROJECT` and a free loopback port for candidates only.
Use one operator per project during an apply or rollback.

```sh
export PLOW_T3_DEPLOY_ENV="$path_to_private_compose_env"
"$release_source/dashboard/run.sh" t3-otlp apply
"$release_source/dashboard/run.sh" t3-otlp status
```

The launcher checks the published port in the resolved Compose model, applies
the release, waits for Compose startup, and confirms that both the loopback
Collector and the private SQLite receiver return HTTP 401 for a POST without
a bearer. A failed apply requires operator inspection before routing any
senders. These checks establish listener readiness and one auth denial per
listener.

Before activation, check that a wrong bearer and the Codex bearer are denied
on T3, a correct T3 bearer is denied on Codex, and a correctly authenticated
POST to `/v1/metrics` and `/v1/logs` returns HTTP 404 on T3. Use a
synthetic allowlisted trace with a fresh ID and confirm the expected SQLite
row through the storage owner's read-only verification. Pass credentials via
a protected header file or stdin. Capture status codes and row counts only.
Confirm the T3 receiver has no published port.

On a candidate with disposable credentials and a distinct project and port,
reapply and compare the running container IDs and named volumes. Stop the
candidate receiver and submit a synthetic trace, restart the candidate
Collector, then reapply and verify the trace arrives after the receiver
resumes. Stop and reapply the candidate stack and confirm the same volumes
and SQLite rows remain. The integrated run must use the final receiver and
stack revision before any sender is activated.

## Private ingress and sender opt-in

The temporary native test used a loopback listener and authenticated
`/v1/traces`. The listener was removed when the test ended. Clanker's
installed Serve configuration had no route to the T3 trace listener at
inspection. Reuse a private ingress if it is explicitly authorized for T3
and forwards the original POST and Authorization header to the T3 loopback
port. Leave the existing dashboard and Codex ingress in place.

When a new route is required, the activation owner must approve the port and
tailnet access policy. The proposed mapping is a dedicated, tailnet-only
Serve HTTPS port forwarding to the T3 loopback port, with the original
`/v1/traces` path. The backend terminates the T3 bearer check and Serve
terminates TLS. Before applying the mapping, confirm it is free and that the
tailnet policy restricts access to approved senders. After applying, read
back that exact route and confirm Funnel is off for the listener.
[Tailscale Serve configuration](https://tailscale.com/docs/reference/tailscale-cli/serve)

```sh
tailscale serve --bg --https="$approved_https_port" "http://127.0.0.1:$t3_loopback_port"
```

From a separate authorized tailnet client, use the Serve DNS hostname for
certificate validation and TLS SNI. Verify the certificate and the same
auth, signal and SQLite checks through HTTPS. Verify an unauthorized peer
cannot reach it under the approved tailnet policy. Use an individual
synthetic probe client before rolling out device configuration.

For the native T3 build exercised in the earlier test, opt in at the T3
server's launch environment. Use the following configuration with the
approved hostname, port and secret reference resolved at launch.

```dotenv
T3CODE_OTLP_TRACES_URL=https://<serve-dns-hostname>:<https-port>/v1/traces
T3CODE_OTLP_PROTOCOL=http/json
T3CODE_OTLP_HEADERS=authorization=Bearer%20<ingress-token>
```

Keep `T3CODE_OTLP_METRICS_URL` and `T3CODE_OTLP_LOGS_URL` unset. The
native server used `service.name=t3code-server`. Verify that identity and
trace arrival on the intended sender build with a synthetic thread event
after opt-in. The server must receive the config at launch.

## Rollback

Pause affected senders, then revert only the approved T3 ingress mapping.
For a dedicated Serve port installed with the command above, the inverse is
`tailscale serve --https="$approved_https_port" off`. Read back the route
state. Run `dashboard/run.sh t3-otlp stop` from the applied release to
stop the stack and retain its volumes.

To roll back a release, apply from the previous verified release with the
same project and loopback port, after checking its queue and SQLite
compatibility. Use `stop` when there is no compatible previous release.
Preserve both volumes for recovery and verify the restored release locally
before re-enabling traffic.
