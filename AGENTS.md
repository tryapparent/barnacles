# Barnacles agent instructions

Barnacles is a public MIT-licensed project for observing how coding-agent work reaches users.

## Ownership

- [Collector](collector/README.md) reads source evidence and emits allowlisted records.
- [Evidence](evidence/README.md) owns SQLite, record identities, delivery joins, and metric definitions.
- [Dashboard](dashboard/README.md) provisions Grafana against evidence views.

Keep the dependency direction from collector to evidence and from dashboard to evidence views. Keep source clients and credentials out of evidence queries and dashboards. Put commands and focused verification instructions in the owning directory as they become runnable.

## Evidence and privacy

- Treat thread start, merge, landed CI success, publication, and verified access as distinct facts. Shipping requires evidence for the intended surface and an explicit delivery mapping. Preserve partial coverage and unknown clocks.
- Keep elapsed delivery time, hosted queue, hosted execution, tool envelopes, and observed processes distinct. Preserve overlaps and parent/child spans.
- Use bounded, read-only source requests. Commit synthetic fixtures only. Keep real imports, raw prompts, outputs, private identifiers and links, local paths, and credentials out of Git and public artifacts.
- Keep imports repeatable and document provenance, coverage, and failure behavior. Check the replay and the relevant partial-data case when changing an import or join.

## Verification and delivery

- Verify the changed entry point. For dashboard changes, inspect the actual Grafana build for the supported sizes, themes, keyboard paths, and relevant data states. Use the approved design reference when available.
- Record the exact commands and evidence for the change and state any gaps. Keep draft scope and explicit holds. Deployment, source-side instrumentation, and spend require separate authorization.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for review and publication.
