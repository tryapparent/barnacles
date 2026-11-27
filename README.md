# Plow

Open-source observability for how coding-agent work reaches release. Plow shows whether changes are reaching users, how thread-to-release time is changing, and where recorded time went.

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
            CLI and local snapshots
```

- [Collector](collector/README.md) documents source boundaries and code to adapt from Apparent.
- [Evidence](evidence/README.md) defines record identities, release attribution, and metrics.
- The [Plow dashboard](https://plow.tryapparent.com/app) shows thread activity and time summaries from collected session evidence. See the [dashboard guide](dashboard/plow/README.md) to build and test it.
- [Plow MCP](mcp/README.md) gives agents read-only access to bottleneck priorities and thread diagnostics through Cloudflare Access.

## Try it locally

Use Node 22.18 or later. The demo writes synthetic evidence to a private temporary directory, prints the delivery report, and prepares a read-only snapshot. It needs network access to fetch the pinned compiler. Use the snapshot directory printed by the demo as `$snapshot`.

```sh
npm ci --ignore-scripts
npm run demo
npm run verify
```

Build the React and shadcn dashboard served by the Cloudflare Worker.

```sh
plow_build_dir=$(mktemp -d /tmp/apparent-dev-plow-build-XXXXXX)
npm exec -- tsc -p dashboard/web/tsconfig.json
node dashboard/plow/build.ts "$plow_build_dir"
node dashboard/plow/smoke.mjs "$plow_build_dir"
```

The smoke command serves the built dashboard with synthetic evidence.

The [Actions import](collector/README.md#run-the-actions-import) and the [T3, Codex, and GitHub delivery imports](collector/README.md#import-t3-codex-and-github-delivery) write local SQLite evidence. Use the delivery report to inspect verified releases and thread-to-release coverage.

The [dashboard guide](dashboard/README.md) links to the current app, local snapshot contracts, and the historical preview.

[Changed Code Analysis](collector/README.md#changed-code-analysis) ranks files by how often commits touched them. Use it to find frequently edited files worth investigating for maintenance bottlenecks.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Plow is licensed under [MIT](LICENSE).
