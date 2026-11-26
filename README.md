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
            Harbor + API or CLI
```

- [Collector](collector/README.md) documents source boundaries and code to adapt from Apparent.
- [Evidence](evidence/README.md) defines record identities, release attribution, and metrics.
- [Harbor](dashboard/api.md) documents the shipping dashboard and the shared read-only API.

## Try it locally

Use Node 22.18 or later. The demo writes synthetic evidence to a private temporary directory, prints the delivery report, and prepares a read-only snapshot. It needs network access to fetch the pinned compiler. Use the snapshot directory printed by the demo as `$snapshot`.

```sh
npm ci --ignore-scripts
npm run demo
npm run verify
```

Build and serve the Harbor website using a private output directory.

```sh
npm run build:harbor -- --outDir "$job/harbor"
node dashboard/prepare.ts --serve "$snapshot" 3031 "$job/harbor"
```

Open [Harbor Shipping review](http://127.0.0.1:3031/).

The [Actions import](collector/README.md#run-the-actions-import) and the [T3, Codex, and GitHub delivery imports](collector/README.md#import-t3-codex-and-github-delivery) write local SQLite evidence. Use the delivery report to inspect verified releases and thread-to-release coverage.

The [legacy dashboard notes](dashboard/README.md) document the Grafana and Tempo preview for reference.

[Changed Code Analysis](collector/README.md#changed-code-analysis) ranks files by how often commits touched them. Use it to find frequently edited files worth investigating for maintenance bottlenecks.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Barnacles is licensed under [MIT](LICENSE).
