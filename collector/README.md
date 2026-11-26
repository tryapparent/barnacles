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

These are the public landed CI and desktop release runs for Apparent #2071. The command reads metadata only. Bend2 matches source identities, filters status and display labels, and selects queue, execution, and step clocks. The CLI host uses Node for GitHub subprocess calls, JSON and timestamp decoding, loading the compiled Bend2 module, and SQLite writes. The pinned Bend2 build emits an ES module of policy exports for this caller. The host supplies the process, filesystem, and SQLite interfaces. The command builds that policy using the pinned, checksum-verified compiler and disables Bend telemetry. The import requires network access to fetch those pinned tools and read GitHub metadata. It downloads neither workflow logs nor artifacts.

The importer checks the attempt and SHA, reads at most ten 100-job pages, and rejects changing counts, duplicate IDs, or partial inventories before writing. Replaying a complete snapshot replaces the same attempt atomically. Submission to runner allocation is distinct from execution. A cancelled job with an explicit unallocated runner ID can supply a terminal queue clock. Pending, skipped, and unresolved carried-over jobs supply no execution duration. Jobless attempts keep their status and zero job count with no inferred queue. Arbitrary job and step names are grouped under Other jobs or Other steps. The SQLite file stays local.

Run the synthetic boundary check with `BARNACLES_TEST_DIRECTORY="$job" node --test collector/github/attempt.test.ts`. It compiles the actual Bend2 policy and exercises the importer and SQLite write path.

## Apparent donor code

Use the reviewed upstream revision `ed8e448f6b7d0826b1922a97fcef9691c9f5676f` as the starting point. The Actions import adapts exact-attempt reads and clock rules from the donor. It also adapts the checksum-pinned [Bend2 bootstrap](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/shared/enablement/bend/toolchain.ts). [APPARENT-LICENSE](APPARENT-LICENSE) retains the donor notice. Preserve the original license and notices on copied code. Barnacles should run from its own checkout.

- [Rollout census](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/census.ts) and [yielded poll readers](https://github.com/tryapparent/apparent/tree/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/yielded-polls) supply envelope pairing and conservative process correlation.
- [GitHub reader](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/github.ts) and [snapshot normalization](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/snapshots.ts) supply attempt/SHA validation, job/step clocks, and carried-job handling. A jobless workflow supplies no runner-queue clock.
- [Release guidance](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/composition/enablement/release/README.md) supplies the channel and artifact semantics. Keep the Apparent release tag convention in its source adapter.

Apparent's review ranking and dispatch orchestration serve a different workflow. Barnacles has no dependency on its desktop stack, CI hooks, or dispatch tooling.

## Import T3, Codex, and GitHub delivery

Use the same private job directory and SQLite file as the Actions import. Each command fetches the pinned Bend2 compiler and compiles the shared source policy. GitHub imports also require authenticated `gh`; release access checks use anonymous `curl`.

```sh
node collector/import-sources.ts "$job" t3 "$job/t3.json"
node collector/import-sources.ts "$job" rollout local-codex "$rollout"
node collector/import-sources.ts "$job" github tryapparent/apparent 2085 \
  linux-main-v2-fad85e0d1ad703cc04bdf0392f9a411498dec22b
node collector/import-sources.ts "$job" github tryapparent/apparent 2071 \
  linux-main-v2-9c1ffc52836711a006b4a983146655c04970f0bf
node collector/import-sources.ts "$job" report
```

### T3 metadata

Fetch the chosen thread with the supported `t3_thread_read` tool (`limit: 1`, `maxCharsPerItem: 1`, `runLimit: 50`) and fetch its links separately with `list_thread_pull_requests` for the same ID. This captures archived links as well as active ones. From the structured responses, write only the following projection to the private input file:

```js
const { thread, recentRuns } = threadRead.structuredContent;
const { pullRequests, nextCursor } = pullRequestList.structuredContent;
const snapshot = {
  instance: "local-t3",
  thread: (({ threadId, createdAt, updatedAt, status, createdBy, creationSource, settled }) =>
    ({ threadId, createdAt, updatedAt, status, createdBy, creationSource, settled }))(thread),
  recentRuns: recentRuns.map(({ runId, requestedAt, startedAt, completedAt, status }) =>
    ({ runId, requestedAt, startedAt, completedAt, status })),
  links: { nextCursor, pullRequests: pullRequests.map(({ host, number, repository, source, state }) =>
    ({ host, number, repository, source, state })) },
};
```

Use a stable instance name per T3 environment. Follow and combine link pages before setting the cursor to null. A non-null cursor is rejected. Thread run data covers the runs in the read response. The importer keeps the provider's link source and treats `created` and `agent` as ownership evidence. Manual links, multiple candidate owners, and chronological conflicts remain visible as coverage gaps. Direct web or mobile user creation supports the manual T3 origin. Other origins stay unknown until the provider supplies explicit evidence.

### Codex rollout

Set `rollout` to one permitted retained JSONL file by exact session or workspace evidence. The host decodes one file of up to 64 MiB, including original provider timestamps when present. Bend2 pairs calls with results, handles missing and ambiguous endpoints, and correlates a yielded tool cell with an unambiguous terminal wait receipt. A cell span ends when the terminal result was observed and can overlap the envelope and other work. Other process receipt formats remain outside this slice. No titles, messages, raw arguments, outputs, or file paths go into SQLite. A rollout import by itself establishes no T3 or GitHub link.

### GitHub PR and release

Pass a PR number alone to capture PR, commit, and review metadata. For release evidence, pass an explicit Linux Main tag. The adapter checks the tag's direct Git ref, equality or ancestry with the PR merge SHA, one uploaded x86_64 AppImage, and an anonymous one-byte Range receipt. It preserves PR metadata when release collection fails. The first 100 commit and review records are sufficient for the verified examples. Counts and caps qualify the first observed review and whether the commit sample is complete. Other channels and annotated tags need their own eligibility support.

Bend2 selects the first commit, first observed review, and earliest **observed and verified** release per PR and surface from decoded evidence. Publication and access observation have separate timestamps. For PR #2085 the T3 metadata projection supplies one owning link. PR #2071 has PR-to-release data with no verified T3 owner. The report can be regenerated without rereading GitHub.

Run both integration tests with:

```sh
BARNACLES_TEST_DIRECTORY="$job" node --test collector/github/attempt.test.ts collector/sources.test.ts
```
