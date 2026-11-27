# Plow agent instructions

Plow is a public MIT-licensed project for observing how coding-agent work reaches users.

## Ownership

- [Collector](collector/README.md) reads source evidence and emits allowlisted records.
- [Evidence](evidence/README.md) owns SQLite, record identities, delivery joins, and metric definitions.
- [Plow](dashboard/plow/README.md) owns the browser dashboard and its Cloudflare Worker. The [Grafana tooling](dashboard/README.md) reads local evidence snapshots.

Keep the dependency direction from collector to evidence and from dashboard to evidence views. Keep source clients and credentials out of evidence queries and dashboards. Put commands and focused verification instructions in the owning directory as they become runnable.

## Plow hosting

- Follow the [Plow deployment guide](dashboard/plow/README.md#deployment) for the Cloudflare Worker at `plow.tryapparent.com/app`. Keep candidate checks on loopback.

## Bend2 is the implementation language

- Use Bend2 by default for authored code. Implement all Plow product behavior in Bend2. This includes pairing, correlation, filtering, classification, validation of evidence, state updates, selection and ranking, attribution, and metric calculations. Apply this rule to new code and migrate the complete decision when changing existing behavior.
- Keep the TypeScript host to external I/O, foreign-format decoding and encoding, compiler wiring, and SQLite transactions. SQL supplies schema, storage constraints, and raw evidence reads. Make domain decisions in Bend2 even when a TypeScript loop or SQL query could do the work.
- If the pinned compiler or runtime blocks a required Bend2 implementation, record the exact limitation and affected behavior. Get an explicit scope decision before adding a host-language implementation of that product behavior.
- Keep non-Bend host and tooling exceptions in the [exact-path registry](.githooks/bend-exceptions.json). New exceptions require an explicit decision and a concrete reason. The commit and push hooks check new paths.
- Review every changed host and SQL branch for misplaced product decisions. Exercise the compiled Bend2 code through the real entry point before claiming completion. Keep generated modules out of Git.

## Evidence and privacy

- Treat thread start, merge, landed CI success, publication, and verified access as distinct facts. Shipping requires evidence for the intended surface and an explicit delivery mapping. Preserve partial coverage and unknown clocks.
- Keep elapsed delivery time, hosted queue, hosted execution, tool envelopes, and observed processes distinct. Preserve overlaps and parent/child spans.
- Use bounded, read-only source requests. Commit synthetic fixtures only. Keep real imports, raw prompts, outputs, private identifiers and links, local paths, and credentials out of Git and public artifacts.
- Keep imports repeatable and document provenance, coverage, and failure behavior. Check the replay and the relevant partial-data case when changing an import or join.

## Directory width

Keep at most ten immediate files and ten immediate subdirectories in each affected first-party directory. The [hook documentation](CONTRIBUTING.md#commit-hook) defines the limited exclusions and root allowances.

## Comments

Put explanations in visible Markdown documentation. Staged code and configuration may retain or remove existing lexical comments. Adding, editing, or duplicating a comment is rejected by the [commit hook](CONTRIBUTING.md#commit-hook).

## Verification and delivery

- Verify the changed entry point. For dashboard changes, inspect the actual Plow build for the supported sizes, themes, keyboard paths, and relevant data states. Use the approved design reference when available.
- Record the exact commands and evidence for the change and state any gaps. Deployment, source-side instrumentation, and spend require separate authorization.
- Treat a draft PR as a checkpoint. For ordinary implementation work, follow the PR through checks and review, resolve in-scope blockers, and merge it when eligible. Finish the task after confirming the merge and completing any required post-merge verification.
- Honor explicit draft-only requests, merge holds, and required approvals. When T3 requires a PR watch, register it and yield. Resume the merge work when the watch reports an update.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for review and publication.
