# Plow

Plow explains where coding-agent run time went and shows the evidence behind each finding. Grafana is the user interface. Bend2 supplies the analysis.

See [Architecture](ARCHITECTURE.md) for the repository layout and data flow. See [the run breakdown](grafana/README.md) for the provisioned Grafana dashboard.

## Verify locally

Use Node 22.18+, Docker Compose, curl, jq, and OpenSSL.

```sh
npm ci --ignore-scripts
npm run verify
bash infra/lgtm/check.sh
```

The loopback stack runs Grafana, Alloy, Loki, Tempo, and Mimir with synthetic Codex and T3 evidence. It builds the analysis plugin and checks the Grafana query, replay behavior, and the Grafana MCP query. See [the stack guide](infra/lgtm/README.md) for an interactive candidate.

[Contributor guide](CONTRIBUTING.md) · [Agent instructions](AGENTS.md) · [MIT license](LICENSE)
