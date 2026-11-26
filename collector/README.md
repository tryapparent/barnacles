# Collector

The first entry point imports one GitHub Actions attempt by repository, run ID, attempt, and expected head SHA. It uses Node 22.18+ and an authenticated GitHub CLI. Run it in a private job directory. Source readers own authentication, pagination, caps, timeouts, and conversion to allowlisted records. They return coverage alongside the records so a failed read cannot appear as an empty source.

| Source | Initial boundary |
| --- | --- |
| T3 | Import metadata from supported thread and PR-link tools. Retain source identity, thread start, status, run clocks, explicit PR links, and origin when established. Omit messages and titles. |
| Codex | Read selected local rollouts. Pair stable call and result IDs and preserve a separate endpoint for a correlated async process. Discard raw arguments and outputs after deriving timing. |
| GitHub | Read PR and commit metadata, exact Actions attempts and jobs, and release assets. Check tag ancestry where applicable. Verify the intended asset with a bounded anonymous range request when the surface is public. Store publication and access observation timestamps. |

## Run the Actions import

From the repository root, with `gh` already authenticated:

```sh
job=$(mktemp -d /tmp/apparent-dev-barnacles-ci-XXXXXX)
sha=9c1ffc52836711a006b4a983146655c04970f0bf
node collector/import-actions.ts "$job" tryapparent/apparent 45813089179 1 "$sha"
node collector/import-actions.ts "$job" tryapparent/apparent 45813387238 1 "$sha"
sqlite3 -readonly -header -column "$job/evidence.sqlite" '
  SELECT workflow_id, clock, operation, count, mean_seconds, total_seconds, unmeasured_count
  FROM action_occupancy
  WHERE count > 0
  ORDER BY workflow_id, clock, total_seconds DESC;'
```

These are the public landed CI and desktop release runs for Apparent #2071. The command reads metadata only. TypeScript handles API reads and SQLite I/O. Bend2 decides whether observed endpoints establish queue, execution, and step intervals. The command builds that policy using the pinned, checksum-verified compiler and disables Bend telemetry. The import requires network access to fetch those pinned tools and read GitHub metadata. It downloads neither workflow logs nor artifacts.

The importer checks the attempt and SHA, reads at most ten 100-job pages, and rejects changing counts, duplicate IDs, or partial inventories before writing. Replaying a complete snapshot replaces the same attempt atomically. Submission to runner allocation is distinct from execution. A cancelled job with an explicit unallocated runner ID can supply a terminal queue clock. Pending, skipped, and unresolved carried-over jobs supply no execution duration. Jobless attempts keep their status and zero job count with no inferred queue. Arbitrary job and step names are grouped under Other jobs or Other steps. The SQLite file stays local.

Run the synthetic boundary check with `BARNACLES_TEST_DIRECTORY="$job" node --test collector/github/attempt.test.ts`. It compiles the actual Bend2 policy and exercises the importer and SQLite write path.

## Apparent donor code

Use the reviewed upstream revision `ed8e448f6b7d0826b1922a97fcef9691c9f5676f` as the starting point. The Actions import adapts exact-attempt reads and clock rules from the donor. It also adapts the checksum-pinned [Bend2 bootstrap](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/shared/enablement/bend/toolchain.ts). [APPARENT-LICENSE](APPARENT-LICENSE) retains the donor notice. Preserve the original license and notices on copied code. Barnacles should run from its own checkout.

- [Rollout census](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/census.ts) and [yielded poll readers](https://github.com/tryapparent/apparent/tree/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/yielded-polls) supply envelope pairing and conservative process correlation.
- [GitHub reader](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/github.ts) and [snapshot normalization](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/snapshots.ts) supply attempt/SHA validation, job/step clocks, and carried-job handling. A jobless workflow supplies no runner-queue clock.
- [Release guidance](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/composition/enablement/release/README.md) supplies the channel and artifact semantics. Keep the Apparent release tag convention in its source adapter.

Apparent's review ranking and dispatch orchestration serve a different workflow. Barnacles has no dependency on its desktop stack, CI hooks, or dispatch tooling.
