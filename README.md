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

The [Actions import](collector/README.md#run-the-actions-import) is runnable against real GitHub metadata and writes a local SQLite database. Thread-to-release attribution and Grafana provisioning are planned follow-ups.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Barnacles is licensed under [MIT](LICENSE).
