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

The repository currently defines these boundaries. The first runnable milestone is a bounded local import with one explicitly linked, release-backed cycle and enough real Actions timing to drill into a workflow.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Barnacles is licensed under [MIT](LICENSE).
