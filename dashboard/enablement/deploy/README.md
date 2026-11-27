# Dashboard deployment

<a name="harbor-on-clanker"></a>

## Plow on Clanker

Clanker runs Plow and its evidence poller as enabled systemd user services. The
existing Tailscale Serve route is the permanent private Plow URL. To find it,
read the loopback port from the service's `ExecStart` and match it to its proxy
target in Serve. Keep the private URL in host configuration.

```sh
systemctl --user show barnacles-harbor.service -p WorkingDirectory -p ExecStart
tailscale serve status
```

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

### Session history

Load the approved private [session study](../../api.md#session-history) into
the active release's snapshot under the deployment lock. Resolve the
`current` symlink while holding the lock so the study lands in the release
serving requests. The collector deploy command copies the study into the next
release, and the data poller refreshes the shipping snapshot independently.

Verify `/sessions`, its frontend asset and `/api/v1/sessions` through the
authorized tailnet URL. Once the API returns the expected study, follow the
[Plow preview deployment](../../plow/README.md#deployment) to configure the
Session history link.
