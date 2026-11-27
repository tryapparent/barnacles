# Plow agent instructions

Plow is a public MIT-licensed project for observing how coding-agent work reaches users.

## Ownership

- [Collector](collector/README.md) reads source evidence and emits allowlisted records.
- [Evidence](evidence/README.md) owns SQLite, record identities, delivery joins, and metric definitions.
- [Plow](dashboard/plow/README.md) owns the browser dashboard and its Clanker origin. The [dashboard guide](dashboard/README.md) documents local snapshot preparation.

Build the Plow interface in React with the shared [shadcn controls](dashboard/web/controls.tsx). Keep timeline geometry in the chart renderer and evidence decisions in Bend2.

Keep the dependency direction from collector to evidence and from dashboard to evidence views. Keep source clients and credentials out of evidence queries and dashboards. Put commands and focused verification instructions in the owning directory as they become runnable.

## Infrastructure as code

- Define all Plow infrastructure in version-controlled code and configuration. Cover services and containers, systemd units and timers, deployment workflows, runtime configuration schemas, persistent storage, networking, DNS, TLS, access policies, and monitoring. Use the tooling appropriate to each component, including tracked systemd units for host services and Compose for services deployed through Compose.
- Keep a single version-controlled source of truth for each component. Provision, update, and roll back through the tracked entry points. Host files and provider settings must be reproducible from those definitions and documented environment inputs. Apply authorized external changes from code even when a provider requires a separate apply step.
- Declare required secret references, environment inputs, and storage locations in code. Inject real secrets and environment-specific private values at deployment time. Keep credentials, private values, and runtime data out of Git.
- When changing existing infrastructure, bring any manual configuration needed for that change under version control before calling the work complete. For new or changed infrastructure, verify the tracked definition on a clean target or isolated candidate and check that reapplying it converges without duplicate resources or data loss.

## Plow hosting

- Follow the [Plow deployment guide](dashboard/plow/README.md#deployment) for the Docker Compose origin and Cloudflare Access at `plow.tryapparent.com/app`. Keep candidate checks on loopback.

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
- Record the exact commands and evidence for the change and state any gaps.
- Assigned Plow implementation work includes standing authorization to merge its eligible PRs and let the existing automatic Clanker rollout proceed. Treat a draft PR as a checkpoint, follow checks and review, resolve in-scope blockers, and finish after verifying the merge and applicable rollout. Proceed without asking for separate merge or routine rollout confirmation.
- New production services, manual deployments outside the existing release process, source-side instrumentation, and spend require separate authorization.
- Honor explicit draft-only requests, merge holds, and required approvals. When T3 requires a PR watch, register it and yield. Resume the merge work when the watch reports an update.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for review and publication.
