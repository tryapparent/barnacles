# Collector

The Actions entry point imports an exact GitHub Actions attempt or samples attempts discovered in a creation-time window. It uses Node 22.18+ and an authenticated GitHub CLI. Run it in a private job directory. Source readers own authentication, pagination, caps, timeouts, and conversion to allowlisted records. They return coverage alongside the records so a failed read cannot appear as an empty source.

Each adapter extracts bounded provider input and decodes its wire format. Bend2 transforms it into allowlisted evidence, retaining the source identifiers and coverage needed for replay. The import commands pass an `EvidenceBatch` to Evidence's `loadEvidence` entry point. A new source should use this path and prove replay, partial input, and the relevant consumer with synthetic fixtures.

| Source | Initial boundary |
| --- | --- |
| T3 | Import metadata from supported thread and PR-link tools. Retain source identity, thread start, status, run clocks, explicit PR links, and origin when established. Accept an optional thread title for private Harbor review. Omit messages. |
| Codex | Read selected local rollouts. Pair stable call and result IDs and preserve a separate endpoint for a correlated async process. Discard raw arguments and outputs after deriving timing. |
| GitHub | Read PR and commit metadata, exact Actions attempts and jobs, and release assets. Check tag ancestry where applicable. Verify the intended asset with a bounded anonymous range request when the surface is public. Store publication and access observation timestamps. |
| Local Git | Read commit IDs and changed paths reachable from one revision. Emit a local Changed Code Analysis report. |

Saving a Git scan also retains the full observed path inventory for Harbor's folder analysis. The printed report and Grafana ranking still show the top 25 paths. Reimport scans saved before the inventory was introduced to populate the Harbor page.

## Changed Code Analysis

From the Barnacles checkout, with Node 22.18+ and Git installed:

```sh
job=$(mktemp -d /tmp/apparent-dev-barnacles-changes-XXXXXX)
node collector/changed-code.ts "$job" /path/to/repository HEAD 1000
```

Pass a local repository and optionally a revision and commit limit. The defaults are `HEAD` and 1,000 commits. The limit accepts 1–10,000. Git reads reachable non-merge commits in topological order, starting from the selected revision. The CLI bounds the Git read to 30 seconds and 32 MiB. A failed read exits with an error.

Bend2 ranks up to 25 paths by commit count, breaking ties by path byte order. Each commit touching a path adds one, whether the change is an addition, edit, or deletion. Renames contribute to the old and new paths independently. Merge commits and any changes made only during merge resolution are outside the count. Empty commits contribute to scan coverage. Paths use UTF-8 when possible and `pathBytesBase64` for other filenames.

The JSON report includes the resolved revision, commits scanned, whether more commits exist beyond the limit, and whether the checkout is shallow. Shallow boundary commits contribute to scan coverage, and their file counts are omitted because their parent diffs are unavailable. High change frequency is a place to start inspecting coupling and recurring edits. It can also reflect normal work on a busy feature or generated file.

History reads stay local. The command fetches the checksum-pinned Bend2 compiler, writes its temporary build under the job directory, and prints the report to stdout. Add `--save-as OWNER/REPO` to also save the scan to the job's `evidence.sqlite` for [Grafana](../dashboard/provisioning/README.md#changed-code-analysis). Use the same repository name when preparing the dashboard. Each successful import replaces that repository's previous scan atomically. Keep reports for private repositories local.

Verify with `BARNACLES_TEST_DIRECTORY="$job" node --test collector/changed-code.test.ts`.

## Run the Actions import

From the repository root, with `gh` already authenticated:

```sh
job=$(mktemp -d /tmp/apparent-dev-barnacles-ci-XXXXXX)
sha=9c1ffc52836711a006b4a983146655c04970f0bf
node collector/import-actions.ts "$job" tryapparent/apparent 45813089179 1 "$sha"
node collector/import-actions.ts "$job" tryapparent/apparent 45813387238 1 "$sha"
node evidence/report-actions.ts "$job/evidence.sqlite" tryapparent/apparent
```

These are the public landed CI and desktop release runs for Apparent #2071. The command reads metadata only. Bend2 matches source identities, filters status and display labels, and selects queue, execution, and step clocks. The CLI host uses Node for GitHub subprocess calls, JSON and timestamp decoding, loading the compiled Bend2 module, and SQLite writes. The pinned Bend2 build emits an ES module of policy exports for this caller. The host supplies the process, filesystem, and SQLite interfaces. The command builds that policy using the pinned, checksum-verified compiler and disables Bend telemetry. The import requires network access to fetch those pinned tools and read GitHub metadata. It downloads neither workflow logs nor artifacts.

The importer checks the run ID, attempt and SHA, then reads at most ten 100-job pages per pass. It confirms the job inventory with a second pass bracketed by exact attempt metadata reads. Missing rows, changing counts or snapshots, duplicate IDs, and identity mismatches abort before writing. Both forms write in one SQLite transaction. Replaying the same complete observation replaces the same attempt.

Submission to runner allocation is distinct from execution. A cancelled job with an explicit unallocated runner ID can supply a terminal queue clock. Pending, skipped, and unresolved carried-over jobs supply no execution duration. Jobless attempts retain their status and zero job count with no inferred start or queue. Reruns leave the run-level start unknown because it can carry forward, while individually measured job clocks remain available. The Intel Mac platform and native acceptance jobs have exact allowlists for named packaging, setup, and test steps in their respective job contexts. Arbitrary job and step names are grouped under Other jobs or Other steps. The SQLite file stays local.

### Discover by creation time

```sh
node collector/import-actions.ts "$job" OWNER/REPO --window \
  2026-01-01T00:00:00Z 2026-01-01T00:59:59Z 2 5
```

The interval is inclusive and uses UTC seconds. Set the last two arguments to the maximum inventory pages (1–10, 100 runs per page) and maximum exact attempts (1–20). The importer lists the run inventory up to the page cap, then captures the first eligible entries in GitHub response order using each entry's reported attempt and SHA. This sample favors the start of that ordering. It covers the attempt reported during discovery for each selected run. Earlier attempts can be imported explicitly by exact identity. The GitHub list and the attempt reads require Actions read access and use GET. [GitHub workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs)

Successful window imports print a JSON receipt containing the window, requested limits, `pagesRead`, GitHub's `reportedTotal`, `eligible` unique in-window run records validated on those pages, and `captured` exact attempts committed. `inventoryComplete` indicates that the validated listing reached the reported count below GitHub's 1,000-result search ceiling. It describes discovery, so it can be true when the attempt sample cap limits capture. A valid empty result reports zero eligible and captured. If an inventory page or selected attempt is incomplete or changes during its checks, the command exits with an error and writes no attempt rows. Discovery uses offset pagination and can detect inconsistent totals, short pages, and duplicate runs, with no point-in-time guarantee from GitHub.

Run the synthetic checks with `npm run verify -- collector`. They compile the actual Bend2 policy and exercise pagination, partial and changing inventories, the command-line entry point, and SQLite replay.

## Poll GitHub for Harbor

Use one collector process per evidence database and Harbor snapshot. From the
same checkout used for Harbor, with Node 22.18+, dependencies installed and
`gh` authenticated with repository read access, run:

```sh
export BARNACLES_POLL_SETTINGS="$job/poll-interval"
node collector/import-sources.ts "$job" poll-github OWNER/REPO "$job/harbor-snapshot"
```

Use an existing private job directory. For an ongoing installation, give the
collector a stable directory for its SQLite database and use a process
supervisor. It runs immediately at startup and waits **15 minutes** between
passes by default. Harbor can save a different interval in **Settings**.
Set the same environment variable when starting
[Harbor](../dashboard/api.md#github-polling-settings) and serve
`"$job/harbor-snapshot"` as its snapshot directory. The first publish creates
this directory. Append `--once` to run a single pass for a supervised check
or bootstrap. GitHub setup consists of the existing authenticated read access.

Each pass checks the 30 most recently updated PRs, the first 30 workflow runs
and the first 20 releases in GitHub's listings. The collector reuses stored
clocks to skip unchanged PRs and completed attempts. It refreshes in-flight
attempts within that listing. This is bounded recent coverage. Use the
one-off import commands below for historical backfill, older reruns outside
the listing, or PR-to-release mappings where the release tag points to a
descendant of the PR merge. Automatic Linux Main release capture uses exact
merge-SHA matches against known PRs and runs the existing artifact access
check. T3 and Codex imports can share the input evidence database.

If a listing fails, the pass keeps the previous Harbor snapshot. If an
individual record changes during capture or fails to import, the pass reports
the failure, keeps previous evidence for that record, and publishes the valid
captures. The next pass can retry records still within scope. Harbor's cutoff
is the time its snapshot was prepared. Collector logs show the listing sizes
and failed import count. Each publish replaces the Harbor SQLite file
atomically.

## Apparent donor code

Use the reviewed upstream revision `ed8e448f6b7d0826b1922a97fcef9691c9f5676f` as the starting point. The Actions import adapts exact-attempt reads and clock rules from the donor. It also adapts the checksum-pinned [Bend2 bootstrap](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/shared/enablement/bend/toolchain.ts). The [root LICENSE](../LICENSE) retains the donor notice. Preserve the original license and notices on copied code. Barnacles should run from its own checkout.

- [Rollout census](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/census.ts) and [yielded poll readers](https://github.com/tryapparent/apparent/tree/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/yielded-polls) supply envelope pairing and conservative process correlation.
- [GitHub reader](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/github.ts) and [snapshot normalization](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/enablement/timing/review/snapshots.ts) supply attempt/SHA validation, job/step clocks, and carried-job handling. A jobless workflow supplies no runner-queue clock.
- [Release guidance](https://github.com/tryapparent/apparent/blob/ed8e448f6b7d0826b1922a97fcef9691c9f5676f/composition/enablement/release/README.md) supplies the channel and artifact semantics. Keep the Apparent release tag convention in its source adapter.

Apparent's review ranking and dispatch orchestration serve a different workflow. Barnacles has no dependency on its desktop stack, CI hooks, or dispatch tooling.

## Import T3, Codex, and GitHub delivery

Use the same private job directory and SQLite file as the Actions import. Each command fetches the pinned Bend2 compiler and compiles the shared source policy. GitHub imports also require authenticated `gh`; release access checks use anonymous `curl`.

```sh
node collector/import-sources.ts "$job" t3 "$job/t3.json"
node collector/import-sources.ts "$job" rollout local-codex "$rollout"
node collector/import-sources.ts "$job" rollout-coverage
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
  thread: (({ threadId, createdAt, updatedAt, status, createdBy, creationSource, settled, title }) =>
    ({ threadId, createdAt, updatedAt, status, createdBy, creationSource, settled, title }))(thread),
  recentRuns: recentRuns.map(({ runId, requestedAt, startedAt, completedAt, status }) =>
    ({ runId, requestedAt, startedAt, completedAt, status })),
  links: { nextCursor, pullRequests: pullRequests.map(({ host, number, repository, source, state }) =>
    ({ host, number, repository, source, state })) },
};
```

Include the optional `title` only for threads whose titles can be shared with the private Harbor audience. Keep titles and the input projection out of Git and public output. Titles are trimmed and values longer than 512 characters are omitted. Replay the projection with a title to name a previously imported T3 thread.

Use a stable instance name per T3 environment. Follow and combine link pages before setting the cursor to null. A non-null cursor is rejected. Thread run data covers the runs in the read response. The importer keeps the provider's link source and treats `created` and `agent` as ownership evidence. Manual links, multiple candidate owners, and chronological conflicts remain visible as coverage gaps. Direct web or mobile user creation supports the manual T3 origin. Other origins stay unknown until the provider supplies explicit evidence.

### Codex rollout

Set `rollout` to one permitted retained JSONL file by exact session or workspace evidence. Install the pinned syntax parsers with `npm ci --ignore-scripts` before importing. The reader uses the size observed at open, rejects files over 128 MiB, and retains complete LF-delimited UTF-8 JSON records of at most 8 MiB each. It records oversized lines and trailing bytes without LF separately. A short read rejects the snapshot. Call and reasoning line numbers are one-based physical lines in the original file.

A file with conflicting session metadata is rejected unless it has the explicit Codex subagent history layout. The first record names the child thread, the shared parent, matching fork and parent thread IDs, and the first child history ordinal. The second record identifies that parent. Complete records must have contiguous ordinals starting at zero, with no further session headers. Only the child suffix is admitted under the original child thread ID. The inherited prefix remains in the source file and contributes no child spans or clocks. Calls and results cannot pair across the boundary. Files with unexplained conflicts, nested headers, missing or invalid ordinals, or no complete child record remain unsupported. A truncation without an LF never supplies a record, including when its bytes form valid JSON.

Bend2 pairs stable call and result IDs and correlates a yielded tool cell with an unambiguous terminal wait receipt. An async cell ends when the terminal result was observed and can overlap the tool envelope and other work. Malformed, oversized, cutoff, or pre-metadata records suppress async pairing for the admitted file. Independently observed tool envelopes and reasoning timestamps remain available. Other process receipt formats remain outside this slice. A rollout import establishes no T3 or GitHub link.

Pass an optional stable `SOURCE_ID` after the file to track retries, including across a move. Without it, the importer uses a local SHA-256 key derived from the absolute input path. The SQLite evidence and CLI coverage output are private. They contain allowlisted source identities and counts. File paths, titles, messages, raw arguments, and outputs are omitted. An admission rejection records its receipt and exits nonzero. A replay replaces the receipt for that source key. A failed replay leaves the previous admitted session snapshot in place.

Timestamped Codex `reasoning` response items contribute a source line and one observed time. The source provides no measured start and end for these items. The importer discards content and summaries.
When reasoning immediately follows a tool output in the response items, the importer retains the preceding call identity for the waterfall estimate. Turn boundaries and intervening response items clear this association. Reimport an older rollout to add this evidence.

The collector decodes direct tool arguments and projects JavaScript and Bash syntax with Tree-sitter. Bend2 uses those facts to decide which scripts can supply model samples. Bend2 classifies submitted operations through an allowlist, including each supported operation in compound commands or parallel scripts. It recognizes simple `env` prefixes and puts Rust and Git push categories first for the waterfall. Dynamic or unsupported commands receive an unknown category. The parser bounds each submitted script or shell command to 64 KiB and can see calls in conditional code. Category labels describe submitted syntax. Clocks still measure the envelope or the observed async cell. Command source and arguments stay in the original local rollout. Reimport under the same instance to add categories to an older snapshot.

For estimates, the collector accepts one literal shell command or a simple `&&` chain, submitted by one awaited `tools.exec_command` with its result printed directly or through a single binding. A matched successful structured receipt supplies elapsed shell time. Pipelines, parallel calls, substitutions, other operations, incomplete receipts, and ambiguous launches have no model sample. Bend2 counts repeated operations. SQLite retains counts and the whole receipt duration. Coverage counts eligible receipt syntax, accepted receipts, and mixed-category calls with a missing receipt. Submission categories share the measured span. A receipt supplies no per-command clock, so the coverage report has no apportioned times.

### GitHub PR and release

Pass a PR number alone to capture PR, commit, and review metadata. For release evidence, pass an explicit Linux Main tag. The adapter checks the tag's direct Git ref, equality or ancestry with the PR merge SHA, one uploaded x86_64 AppImage, and an anonymous one-byte Range receipt. It preserves PR metadata when release collection fails. The first 100 commit and review records are sufficient for the verified examples. Counts, caps, and unique commit IDs qualify the first observed review and whether the commit sample is complete. Other channels and annotated tags need their own eligibility support.

The CLI also reads a single bounded page of PR workflow runs for the PR branch and open-to-merge window. First PR CI is the earliest observed first-attempt workflow start with a PR link, or an exact repository, branch, and PR commit match when GitHub supplies no PR links. It measures the workflow clock. When a verified release tag is supplied, a unique successful Linux Main publishing workflow with matching source and run identity supplies its dispatch time. A missing, partial, or duplicate workflow inventory, or multiple eligible dispatch runs, leaves the corresponding clock unknown.

Bend2 selects the first commit, first observed review, and earliest **observed and verified** release per PR and surface from decoded evidence. Publication and access observation have separate timestamps. For PR #2085 the T3 metadata projection supplies one owning link. PR #2071 has PR-to-release data with no verified T3 owner. The report can be regenerated without rereading GitHub. Each row exposes endpoint and stage coverage, source-link gaps, and unknown causal fields. Thread-to-commit and thread-to-publication are elapsed intervals from thread creation. Older threads can contribute idle time. The report has no active-work duration or verified link from a rollout wait or landed CI attempt to a delivery stage. See the [coverage contract](../evidence/README.md#coverage-contract).

Run both integration tests with:

```sh
npm run verify -- collector
```

### Cell waits and nested command sessions

Reimport a rollout with `node collector/import-sources.ts "$job" rollout INSTANCE FILE`. The importer recognizes a bounded Codex cell receipt and looks up the wait's literal `cell_id` within that rollout. Repeated waits may observe a cell still running. A unique, ordered completion supplies the cell endpoint. Duplicate claims, missing launches, and incomplete rollouts remain visible as coverage gaps.

Command-session attribution accepts a direct command or process-I/O tool result, or one result printed by an awaited `tools.exec_command` or `tools.write_stdin` call inside `functions.exec`. The wrapper may print the result directly or through one local binding. A fixed, bounded `for` loop may poll the same read-only handle and print its terminating result once. A nested receipt can arrive inline or at the cell's terminal wait. Structured receipts allow one process payload up to 256 KiB and an elapsed value from zero through 86,400 seconds. An open receipt supplies a numeric session handle. A paired read-only poll must use a literal handle and submit no input. Bend2 processes observations in result-line order, including results supplied by terminal waits. An operation with no result uses its start line. A confirmed exit closes that generation of the handle. Conflicting claims and unresolved process activity suppress subsequent joins that could reuse uncertain handles. Parallel calls, other loops and compound wrappers, dynamic handles, and unstructured process output can still produce cell evidence.

The standalone `gh_owned_wait.py RUN --repo OWNER/REPO --head SHA --attempt ATTEMPT --timeout SECONDS --interval SECONDS` form, with optional `python` or `python3` invocation and simple output redirection and literal `umask 077` or `set -e` preambles, supplies an exact **requested** GitHub workflow identity. This recognizes the submitted argv and checks its four identity fields. It records neither the helper's contents nor independent GitHub attestation of the target. Bare `gh run watch` has a watcher category with incomplete identity. Other shell chains, quoted code, substitutions, and helpers with dynamic identity fields receive no exact identity. Generic categories describe submitted operations and may contain several operations sharing a clock.

```sh
node collector/import-sources.ts "$job" waits SESSION [CALL]
node collector/import-sources.ts "$job" watch-overlaps OWNER/REPO RUN HEAD_SHA ATTEMPT
BARNACLES_TEST_DIRECTORY="$job" node --test collector/sources.test.ts
```

The lookup returns the wait's tool-envelope timestamps and its cell and process evidence. The overlap report compares observed read-only poll envelopes across distinct process launches for one exact workflow identity. A nested poll envelope begins at the wrapper request and ends at its matched result. Reported intervals are pairwise intersections and may themselves overlap. They establish concurrent observation only. They supply no estimate of resource savings, delivery delay, or critical-path impact.

The checksum-pinned Bend2 compiler recursively lowers nested patterns in the source policy. The compiler subprocess uses a 4 MiB V8 stack because the default stack overflowed during that lowering on Node 22. Rollout admission and envelope routing use constructor tags to reduce the cost of lowering nested string patterns. The receipt still exposes the existing status strings. The process schedule uses four fixed-width characters to encode each source line in most-significant-byte-first order. Walking the line index from low to high preserves numeric order without the pinned `List.sort` stack overflow on large rollouts.


### Fetch attempts named by rollout watchers

After importing the rollouts into a private job directory, run `node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --from-waits FROM TO MAX_ATTEMPTS` with UTC seconds and a limit of 1–20. The read-only GitHub collector fetches missing exact attempts named by confirmed watcher receipts that overlap the interval. The JSON receipt gives the number missing before capture and the number imported. See [the Actions wait dashboard and evidence contract](../evidence/actions-wait.md).

### Host interfaces

- [GitHub transport and wire decoding](github/attempt.ts) executes bounded `gh` requests, decodes JSON and timestamp fields, and converts nullable clock fields for SQLite. [Delivery](github/delivery.ts) constructs the provider request paths and executes the anonymous HTTPS range probe. Bend2 checks the response identity, completeness, and proof before attribution.
- [Rollout file and receipts](codex/rollout.ts) uses Node file handles and streaming JSONL, extracts provider receipt headers, and decodes structured JSON receipts. [Syntax projection](codex/rollout-syntax.ts) uses the pinned Tree-sitter WebAssembly parsers, node field access and literal decoding. Bend2 checks printed and looped process eligibility and exact watcher shell syntax from the projected facts. It maintains the call, cell, and process indexes and applies handle collisions and barriers.
- [T3 metadata](t3.ts) checks the JSON pagination cursor is explicitly null and decodes provider fields. Bend2 validates clock ordering and link attribution. [Changed Code Analysis](changed-code.ts) invokes Git, decodes NUL-separated records, and encodes paths as UTF-8 or Base64. Bend2 handles the scan limit, shallow-boundary identity, and ranking.
- [Import entry points](import-sources.ts) and [Actions import](import-actions.ts) parse CLI arguments, build and load the pinned policies, and call Evidence's SQLite entry point.

The pinned Node module loader exports pure Bend2 functions. A synthetic policy compiled through `buildPolicy` exported its pure marker and omitted both `File.open` and `Process.run` IO functions. The executable backend has an IO runner with a separate effect bundle. The Tree-sitter parser and its node objects stay in the Node adapter.

`File.open` supports named modes such as `"r"` and `File.size` returns a U32 size. The rollout adapter requires a nonblocking open and a regular-file check on the opened descriptor before reading to its initial size. `Process.run` takes argv, text input, a combined output cap, and a deadline. It inherits the caller environment and returns UTF-8 text. Changed Code Analysis requires a repository working directory, a child-specific Git protocol restriction, and byte-preserving output for paths. The Node adapters retain these file and subprocess interfaces.

Run `npm run verify -- collector` to exercise the compiled policy through the importer. The synthetic rollout covers out-of-order results, terminal wait attribution, recycled and contradictory handles, missing-result barriers, duplicate receipts, unsupported loop launches, exact watcher identity, and 12,000 results arriving in reverse launch order.

### Capture one local command

On Linux with bpftrace, BTF, and permission to attach the scheduler probes, generate an observer for one agent worker and a fresh, isolated working directory. Use a directory reserved for a single shell launch from that worker. This gives a verifiable binding when the executor does not expose a root PID receipt.

```sh
umask 077
job=$(mktemp -d /tmp/apparent-dev-barnacles-process-XXXXXX)
node collector/import-sources.ts "$job" process-probe "$worker_pid" "$isolated_workdir" >"$job/process.bt"
timeout --signal=INT --kill-after=5s 60s sudo -n bpftrace -q "$job/process.bt" >"$job/events" 2>"$job/observer.log"
```

Run the unchanged agent command in the isolated directory after the observer prints `ready`. The probe follows fork, exec, and exit events for that shell tree and stops at the shell's exit or the timeout. It writes allowlisted executable labels, monotonic timestamps, and local task IDs. The capture contains no arguments, command output, or paths. Keep the observer, log, and capture private.

Verify the isolated launch against the retained rollout and import the rollout under a local instance name. Construct a private binding JSON object with `instance`, `session`, `call`, `line` (the physical source line), `startedAt` (the imported call's UTC timestamp), and `eventsSha256` (SHA-256 of the unchanged event file). Use a binding only when one rollout call accounts for the scoped shell launch. The existing rollout import uses the nearest millisecond of `create_time` when present.

```sh
node collector/import-sources.ts "$job" rollout "$instance" "$rollout"
node collector/import-sources.ts "$job" process "$job/binding.json" "$job/events" "$job/observer.log"
node dashboard/prepare.ts "$job/evidence.sqlite" "$job/snapshot" "$repository"
npm run build:harbor -- --outDir "$job/harbor"
node dashboard/prepare.ts --serve "$job/snapshot" 3031 "$job/harbor"
```

Open **Process timings** in Harbor. The collector rejects ambiguous or mismatched calls, changed checksums, unrecognized event rows, observer diagnostics, and captures over 4,096 events or 120 seconds. A capture with a clean stop and missing exit evidence can still surface its measured spans. A replay of the same binding is idempotent. Concurrent launches in a shared directory need an executor-supplied process identity or another explicit binding.

## Replay bottleneck evidence

Use a private job directory and a frozen NDJSON stream of projected facts.

```sh
node collector/import-sources.ts "$job" bottlenecks "$job/facts.ndjson"
```

Each line is an object with an opaque `id` and one of these shapes:

| Kind | Other fields | Observation |
| --- | --- | --- |
| `file` | `thread`, `path`, `at` | A literal file target projected from a supported read request. Count distinct threads, deduplicated requests, and visits within 15 minutes per thread and path. This does not prove the file was opened. |
| `timing` | `clock`, `operation`, `start`, `end` | Sum closed intervals by clock and operation. Use zero for an absent endpoint. Show incomplete observations separately. These totals may overlap. |
| `attempt` | `thread`, `key`, `start`, `end`, `failed`, `succeeded` | Link the last failed execution to a successful retry within 30 minutes for the same thread and exact operation/target/input/environment key. |
| `diagnostic` | `thread`, `line`, `failed` | A single output line from a command receipt with a verified terminal outcome. Missing staged prerequisites and directory-width rejections require a failed receipt. Repeated evidence for the same command and rule is counted once. |
| `job-result` | `thread`, `conclusion` | A completed hosted job for the target thread, with an exact attempt/job identity and verified provider conclusion. Records failure and timeout independently of duration. Use original execution records when a rerun carries forward an earlier job. |
| `hosted-admission` | `thread`, `conclusion`, `assigned`, `steps`, `annotation` | A hosted job and its exact check-run annotation. A terminal cancellation with an explicitly unassigned runner, no steps and the provider’s acquisition failure annotation signals hosted admission failure. Ordinary cancelled or superseded jobs cannot establish this signal. |
| `t3-pr-notice` | `thread`, `sourceThread`, `visibility`, `status`, `truncated`, `linkedPr`, `message` | An original T3 notification with a unique matching linked PR. A canonical local, completed merge-conflict notice records a historical observation at that notification. The head, duration, and current mergeability remain unknown. Deduplication uses the notification ID. |
| `t3-pr-watch-wake` | `thread`, `watchId`, `number`, `message`, `registeredAt`, `parkedAt`, `noticeStamp`, `requestedStamp`, `priorOrdinal`, `nextOrdinal` | One original watch registration in a terminal T3 turn followed by a canonical local notification for the same uniquely linked PR. Supply the completed turn's end as `parkedAt` and the unrounded ISO timestamps of the notification and the next turn request. Use complete activity evidence with no intervening user turn, notice or watch disposal. Record the root turn gap under `t3-pr-watch-parked` with the observed wake reason and both evidence IDs. Child activity and hosted CI clocks can overlap this interval. |
| `forge-response` | `thread`, `operation`, `status`, `failed`, `identified` | One completed provider request. Use `github-pr-create` for a verified GitHub create-PR request, the HTTP status from its own response, and `identified` for a matching GitHub request receipt. A failed request with a 5xx response records an API server error without estimating incident duration. |
| `job-rerun-response` | `thread`, `job`, `line`, `failed` | A terminal GitHub job-specific rerun request and its response line. A refusal naming the same job records a rejected rerun request. The provider's reason and any resulting wait remain unknown. |
| `local-build-admission` | `thread`, `waitMs`, `boundMs`, `allocated`, `capacity` | An explicit runner admission receipt associated with one launch. Bound the producer's wait by the elapsed milliseconds between launch and receipt observation. The admitted worker count must be positive and within capacity. Report this duration in a separate clock, rounded down to seconds per launch. Flag waits of at least 60 seconds. No absolute interval is inferred. |
| `hosted-apt-result` | `thread`, `conclusion`, `exitCode`, `httpStatus`, `archive`, `summary` | The exit, archive pathname, HTTP code and APT summary from the same exact hosted dependency step. A failed step with APT exit 100, a pool `.deb` 404 and the archive fetch summary records a package download failure. Use an exact run/attempt/job/step identity. |
| `native-model-fetch-result` | `thread`, `step`, `conclusion`, `exitCode`, `status`, `revision`, `line`, `origin`, `started`, `ended` | A failed pinned Circle Vision model fetch during the exact hosted native prerequisite step. Use the producer's HTTP result with query parameters removed, the full model revision, the repository-relative `download:record/media/circle-vision/build.ts` frame, and the step's terminal outcome and clocks. A qualifying 5xx records a failed fetch. The separate `ci-native-prerequisite-step` clock includes the full prerequisite step. |
| `toolchain-fetch-result` | `thread`, `step`, `conclusion`, `exitCode`, `status`, `asset`, `line`, `origin`, `started`, `ended` | A pinned Bend toolchain source fetch that failed before Cargo. Bind the source filename, HTTP status, exact error and `prepareBend:shared/enablement/bend/toolchain.ts` origin to the same terminal prerequisite step. An observed 5xx adds the full step under `ci-native-prerequisite-step` for the Bend toolchain. |
| `local-admission-timeout` | `thread`, `exitCode`, `line` | A `t3-build` launch with the exact terminal receipt indicating admission timed out, at exit 124. If read through a later process poll, associate the exact handle with its launch. No admitted build or wait duration is inferred. |
| `socket-preflight` | `thread`, `required`, `limit`, `line`, `origin` | A local verification subprocess rejected the scratch socket path. Pass the canonical exception sentence through the numeric path limit, and the repository-relative `check_temp_environment:enablement/verification.py` traceback origin. The enclosing command can exit successfully after invoking another command. This signal records the preflight rejection without a duration. |
| `capture-access-result` | `thread`, `operation`, `line`, `failed` | One completed local command receipt for `apparent-inspect` or `apparent-connect-files`. Use the canonical `Error: Capture unavailable (not_found).` portion of the producer's error. Record observed unavailability without claiming a reason or duration. Capture IDs and command text stay out of the fact. |
| `hosted-publish-result` | `thread`, `publisher`, `conclusion`, `exitCode`, `status`, `line` | A hosted publication step's exit and output. For `onboarding-release`, use status zero and the line reporting an existing version with a different or unfinished artifact. For `github-release-assets`, include the HTTP status and the GitHub release upload endpoint with query parameters removed. A failed step with exit 1 and a qualifying receipt records the corresponding publication failure. |
| `benchmark-marker` | `thread`, `lane`, `conclusion`, `exitCode`, `sameBuild`, `line`, `started`, `ended` | A same-build Record Start calibration with a known producer timeout at the painted marker or revision-specific frame acknowledgement. The stage must be the failed owner benchmark step. |
| `benchmark-pressure` | `thread`, `lane`, `source`, `conclusion`, `exitCode`, `sameBuild`, `qualified`, `scorePresent`, `pressureRejected`, `started`, `ended` | An unscored same-build calibration rejected by the CPU pressure guard. Use `stop-result` for a matched Record Stop verdict and `calibration-artifact` for an exact Record Start artifact bound to the failing job. Both benchmark facts account for the full owner step, including setup, under a separate clock. |
| `benchmark-admission` | `thread`, `lane`, `conclusion`, `exitCode`, `line`, `origin`, `started`, `ended` | An exact failed Connect Watch owner benchmark step with the producer's no-qualified-SMT-subset assertion and the repository-relative `main:connect/enablement/benchmark/hosted.ts` origin. Count the full owner step in `ci-benchmark-owner-step`. The signal establishes admission ended at replay probing. It does not establish a measured comparison or isolate the source of resource contention. |
| `hosted-deploy-result` | `thread`, `service`, `conclusion`, `exitCode`, `line`, `phaseLine`, `accepted` | A failed deployment step with a producer result and its same-step origin frame. For `connect-worker`, the admission error signals a superseded candidate. For `public-pages`, require provider deployment acceptance before the timeout in readback. Acceptance and verified availability are separate. |
| `hosted-test-failure` | `thread`, `scope`, `lane`, `test`, `execution`, `conclusion`, `at` | A failed test result emitted by the test runner inside an exact failed hosted step. Use the repository and PR identity for scope, workflow/job/matrix/step for lane, and a stable identifier for the repository-relative suite and test case. Use the original run/attempt/job/step for execution, including when a rerun carries results forward. Supply the producer failure timestamp. A repeated failure of that test in the same lane points to the previous failed execution. Assertions and revisions may differ. |
| `hosted-test-fanout` | `thread`, `scope`, `lane`, `revision`, `failure`, `conclusion`, `at` | One exact failed hosted test step, identifying the suite, explicit failed test, and its matching assertion signature. Use the tested checkout revision, repository and PR scope, and a lane specific to the workflow/job/matrix/step. A matching failure signature and checked-out revision across distinct lanes link their evidence IDs. Retries within a lane count once for this rule. The linked steps can execute concurrently. |
| `package-build-result` | `thread`, `scope`, `tool`, `digest`, `assets`, `reportedMs`, `start`, `end` | A complete successful `vite-production-client` result inside one exact hosted packaging step and build directory. Use a distinct producer result ID and a digest of the sorted complete reported output names and sizes. Consecutively observed executions with matching manifests in that scope must be nonoverlapping. The finding shows the repeated execution's reported build time rounded down. Matching manifests do not establish byte identity or time savings. |
| `peer` | `thread`, `clock`, `cohort`, `revision`, `start`, `end`, `eligible` | Compare a closed eligible clock with earlier completed observations. Group by versioned operation, workflow, event and runner class as applicable. A cohort retains the latest observation per revision, up to 64 revisions. At least eight different prior revisions are required. Flag a duration above p90, at least twice the median and at least 60 seconds above it. |

Use integer Unix seconds for timestamps. Feed attempt and file records in source chronological order within their keys. Feed peers in completion order, including comparable history from before the target window. Observations identified by a repeated ID are replayed once per applicable clock or file. Keep unrelated shell envelopes, script output, absolute paths, and prompts out of the input. For diagnostics, pass only the bounded output line and terminal outcome from the same command receipt. Exclude command text, narrative and acknowledgements. Diagnostic findings retain the rule and command identity, without the line. Use opaque or repository-relative labels, and store materialized facts and output privately. The analyzer identifies observable activity and comparable anomalies. It does not infer the critical path, activity from idle gaps, or the reason a runner was unallocated.

Feed hosted test failures and package build results in timestamp order within their scopes. Only valid, distinct executions update the previous observation for a matching key. These findings retain the evidence IDs and do not add time to the existing hosted clocks.
