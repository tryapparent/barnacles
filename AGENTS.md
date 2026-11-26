# Barnacles agent instructions

Barnacles is a public MIT-licensed project for observing how coding-agent work reaches users.

## Ownership

- [Collector](collector/README.md) reads source evidence and emits allowlisted records.
- [Evidence](evidence/README.md) owns SQLite, record identities, delivery joins, and metric definitions.
- [Dashboard](dashboard/README.md) provisions Grafana against evidence views.

Keep the dependency direction from collector to evidence and from dashboard to evidence views. Keep source clients and credentials out of evidence queries and dashboards. Put commands and focused verification instructions in the owning directory as they become runnable.

## Bend2 first

- Write new and changed product logic in Bend2. This includes source normalization, classification, evidence validation and attribution, clock selection, metrics, and state transitions. When touching an existing host-language decision, migrate the smallest complete decision and switch its real callers to Bend2 in the same change.
- Keep host code at the runtime boundary for API and filesystem access, foreign-format decoding, SQLite transactions, Grafana integration, and build wiring. Move decisions behind those boundaries into Bend2 wherever the pinned toolchain supports them.
- For logic that must stay in another language, document the exact caller, runtime constraint, and affected behavior beside the code. A host-language adapter or an existing implementation alone is insufficient justification.
- Verify the compiled Bend2 module through the normal entry point. Keep one implementation of each decision and keep generated modules out of Git.

## Evidence and privacy

- Treat thread start, merge, landed CI success, publication, and verified access as distinct facts. Shipping requires evidence for the intended surface and an explicit delivery mapping. Preserve partial coverage and unknown clocks.
- Keep elapsed delivery time, hosted queue, hosted execution, tool envelopes, and observed processes distinct. Preserve overlaps and parent/child spans.
- Use bounded, read-only source requests. Commit synthetic fixtures only. Keep real imports, raw prompts, outputs, private identifiers and links, local paths, and credentials out of Git and public artifacts.
- Keep imports repeatable and document provenance, coverage, and failure behavior. Check the replay and the relevant partial-data case when changing an import or join.

## Verification and delivery

- Verify the changed entry point. For dashboard changes, inspect the actual Grafana build for the supported sizes, themes, keyboard paths, and relevant data states. Use the approved design reference when available.
- Record the exact commands and evidence for the change and state any gaps. Keep draft scope and explicit holds. Deployment, source-side instrumentation, and spend require separate authorization.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for review and publication.
