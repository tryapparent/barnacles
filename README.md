# Barnacles

Open-source observability for how coding-agent work reaches release. Barnacles shows whether changes are reaching users, how thread-to-release time is changing, and where recorded time went.

## Architecture

```text
Codex JSONL     T3 snapshots     GitHub APIs
       \             |             /
        Collector codecs + Bend2 transforms
                      |
                 EvidenceBatch
                      |
              SQLite transactions
                      |
          Evidence reports and snapshots
                      |
           Grafana + Tempo or CLI
```

- [Collector](collector/README.md) documents source boundaries and code to adapt from Apparent.
- [Evidence](evidence/README.md) defines record identities, release attribution, and metrics.
- [Dashboard](dashboard/README.md) describes the Grafana surface and drilldown.

## Try it locally

Use Node 22.18 or later. The demo writes synthetic evidence to a private temporary directory, prints the delivery report, and prepares a Grafana snapshot. It needs network access to fetch the pinned compiler and requires no provider credentials. The command prints the optional Docker launch command.

```sh
npm ci --ignore-scripts
npm run demo
npm run verify
```

The [Shipping review API](dashboard/api.md) serves the prepared evidence to browser clients and agents.

The [Actions import](collector/README.md#run-the-actions-import) and the [T3, Codex, and GitHub delivery imports](collector/README.md#import-t3-codex-and-github-delivery) write local SQLite evidence. Use the delivery report to inspect verified releases and thread-to-release coverage. The [local Grafana dashboards](dashboard/provisioning/README.md) visualize shipping, recorded time, and rollout spans.

The root [Compose project](compose.yaml) assembles the local dashboard deployment. After preparing a snapshot, run `dashboard/run.sh "$job/grafana"`. The [Dashboard deployment guide](dashboard/enablement/deploy/README.md) covers independent Grafana updates and snapshot rollback.

[Changed Code Analysis](collector/README.md#changed-code-analysis) ranks files by how often commits touched them. Use it to find frequently edited files worth investigating for maintenance bottlenecks.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Barnacles is licensed under [MIT](LICENSE).
