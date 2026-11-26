# Barnacles

Open-source observability for how coding-agent work reaches release. Barnacles shows whether changes are reaching users, how thread-to-release time is changing, and where recorded time went.

## Architecture

```text
T3 metadata + local Codex rollouts + GitHub delivery evidence
                         |
                      Collector
                         |
                  SQLite evidence views
                         |
                       Grafana
```

- [Collector](collector/README.md) documents source boundaries and code to adapt from Apparent.
- [Evidence](evidence/README.md) defines record identities, release attribution, and metrics.
- [Dashboard](dashboard/README.md) describes the planned Grafana surface and drilldown.

The [Actions import](collector/README.md#run-the-actions-import) and the [T3, Codex, and GitHub delivery imports](collector/README.md#import-t3-codex-and-github-delivery) write local SQLite evidence. Use the delivery report to inspect verified releases and thread-to-release coverage. Grafana provisioning is a follow-up.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Barnacles is licensed under [MIT](LICENSE).
