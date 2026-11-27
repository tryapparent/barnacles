# GitHub-only Octokit pilot

Run the [standalone Compose project](compose.yaml) from the repository root.
Its only service reads `tryapparent/apparent` and writes a private
`evidence.sqlite` to the mounted state directory. The image uses a digest-pinned
Node base, the npm lockfile and the checksum-verified Bend2 compiler. Compose
consumes the YAML declaration directly. The project has no listeners and
creates no dashboard snapshot.

## Run one poll

Provide an existing GitHub App installation for the pilot repository. A pass
verifies the installation ID against the repository using an App JWT, then
requests an installation token limited to that repository and read access to
Actions, pull requests and contents. Octokit handles signing, token exchange
and expiry. Keep the private key in a restricted file outside the checkout.
Compose mounts the key read-only and keeps its contents out of the environment
and image.

```sh
export PLOW_PILOT_UID=0 PLOW_PILOT_GID=0
export PLOW_PILOT_STATE_DIR=/absolute/path/to/private/state
export PLOW_PILOT_CREDENTIAL_FILE=/absolute/path/to/app-private-key.pem
export PLOW_PILOT_APP_ID=APP_ID PLOW_PILOT_INSTALLATION_ID=INSTALLATION_ID

docker compose -f collector/github/compose.yaml build github-pilot
docker compose -f collector/github/compose.yaml run --rm --no-deps github-pilot
```

The UID and GID example is for rootless Docker, where container UID/GID 0 maps
to the operator. Otherwise use the container identity that can read the key and
write the existing state directory. Use mode 0600 for the credential file and
0700 for the state directory. For an isolated public-read check, set
`PLOW_PILOT_AUTH=public` and mount an empty private file at the credential path.
A verification pass can also use `PLOW_PILOT_AUTH=token` with a file containing
an existing authorized read token. The default mode is `app`.

Use the same one-shot command in a scheduler at the established 15-minute
default cadence. Serialize invocations with a lock in the private state
directory, for example by prefixing the command with
`flock -n "$PLOW_PILOT_STATE_DIR/collector.lock"`. Standard output reports the
poll counts. Scoped read failures retain complete rows already committed, and
a poll with failed captures exits nonzero. Optional unresolved PR CI or
release dispatch milestones retain the existing unknown coverage behavior.

## Verify one rerun

An ordinary pass uses the existing poller's bounded PR, Actions and release
listings. The run listing exposes the then-current attempt. Use each earlier
attempt's explicit identity to fill gaps and verify replay against the same
database.

```sh
docker compose -f collector/github/compose.yaml run --rm --no-deps github-pilot RUN_ID 1 HEAD_SHA
docker compose -f collector/github/compose.yaml run --rm --no-deps github-pilot RUN_ID 2 HEAD_SHA
```

Each exact import checks the SHA, run and attempt and positively enumerates the
exact `/actions/runs/{id}/attempts/{attempt}/jobs` pages twice before writing.
A partial or unstable inventory leaves the prior evidence intact. Replay
preserves the attempt and job identities and clocks. The evidence ledger keeps
unavailable clocks unknown.

Octokit sends serialized repository GETs and the App token exchange. Each pass
allows at most 300 HTTP requests and five minutes of API access, with a
30-second request timeout and a 16 MiB response cap. It rejects redirects and
stops sending when GitHub reports exhausted quota or rate limiting. The next
invocation is the retry boundary. Release access proof uses the existing
bounded public range probe. Existing CLI calls without an Octokit auth mode
continue to use authenticated `gh`.

Run `npm run verify -- collector` for synthetic coverage including the
GitHub App exchange, paginated attempt jobs, incomplete inventories and replay.
Use `docker compose -f collector/github/compose.yaml --profile github-pilot config --quiet`
to validate the resolved service with the state, credential and user variables
set. Keep live run IDs, SHA, clocks and SQLite data in private receipts.

## Resume a historical backfill

Run the `historical-backfill` Compose service between live polls. It is a
manual one-shot with lower CPU share, no schedule, no retries within a pass
and separate API budgets. Keep the existing live poll cadence. Use a private
state directory for the pilot, or serialize access with the live collector's
`collector.lock` if intentionally writing to its database. Do not start a
historical pass when a live poll is due.

Put a private `history.json` file in the mounted state directory. Choose one
source per invocation, and list at most 50 explicitly scoped targets. An
Actions manifest lists exact attempts. Add a separate entry for each rerun
using the full SHA. Run search and enumeration remain separate from this
manifest, so shifting list offsets and newly created reruns cannot change the
resume targets.

```json
{
  "source": "github-actions",
  "attempts": [
    { "runId": 123, "attempt": 1, "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { "runId": 123, "attempt": 2, "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
  ]
}
```

A T3 manifest names the authorized environment, the project whose canonical
repository is the selected GitHub repository, and the exact settled threads
to read. Obtain IDs via the T3 API. Use a supported authenticated
[Streamable HTTP MCP endpoint](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
exposing `t3_environment_read`, `t3_project_read` and `t3_thread_read` with
structured tool responses. Set `PLOW_T3_HISTORY_MCP_URL` and mount an already
authorized bearer credential as `PLOW_PILOT_CREDENTIAL_FILE` for this
invocation. The service verifies the environment, project and repository
before reading activity. It needs no T3 installation, agent filesystem or
device credentials. A connected T3 tool in a chat session alone does not
provide a reusable endpoint or credential for the container.

```json
{
  "source": "t3-activity",
  "environment": "environment-id",
  "project": "project-id",
  "threads": ["settled-thread-id"]
}
```

```sh
docker compose -f collector/github/compose.yaml build historical-backfill
flock -n "$PLOW_PILOT_STATE_DIR/collector.lock" \
  docker compose -f collector/github/compose.yaml run --rm --no-deps historical-backfill 2
```

The final argument is a limit of 1 through 8 work units. An Actions unit is
one exact attempt including both confirmed job inventories. The complete
invocation has its own cap of 32 requests and 60 seconds of API access. Use
the same App, token or public Octokit configuration as the pilot. A T3 unit
is an activity page of up to 25 items with minimal text. A pass allows at most 12 HTTP
POSTs including MCP setup and scope checks, within 45 seconds of API access.
T3 intentionally ignores recent run snapshots, whose list is bounded and
does not follow the activity cursor.

For a host-only invocation, point `BARNACLES_GITHUB_CREDENTIAL_FILE` or
`PLOW_T3_HISTORY_CREDENTIAL_FILE` to the chosen credential file and use

```sh
node collector/import-actions.ts JOB_DIRECTORY OWNER/REPO --backfill MANIFEST 2
```

The invocation prints aggregate coverage counts and the number of units
attempted. Exit 0 means every manifest target reached complete coverage,
exit 2 means at least one remains open, and exit 1 indicates a local
configuration, compiler or storage error. Repeat the command on the same
SQLite database to resume. Completed targets require no source reads.
Targets with fewer previous reads go first, so an unavailable target cannot
block other targets across bounded passes. A missing, inaccessible, expired, rate-limited, partial or budget-exhausted
unit leaves its previous cursor intact. GitHub may mask access denial as
HTTP 404. Opaque MCP errors remain partial. Treat those as uncertain
coverage. A changed T3 thread revision, a sparse inventory, or an
inconsistent page cannot advance the original snapshot's cursor. Use a
separate evidence database if an operator chooses to capture a new
revision of that thread. Keep private manifests, identifiers and evidence
outside Git.

The backfill writes coverage and evidence atomically per attempt or page.
SQLite serializes competing cursor commits and preserves the first accepted
page. Query `history_progress` for per-target coverage. For T3,
`position` is the number of covered positions starting at zero and is
also one past the last covered API position. `total` is the count reported
by the accepted source snapshot. Coverage reports enumeration of the
requested scope. Individual clocks can still be unknown. The
`history_t3_activity` table stores only local tool envelopes, keyed by
environment, thread, position and item. It keeps the item's allowlisted
kind, observed status and update clock. An update can represent a yield
or a later metadata change. It supplies no process exit, timing interval,
or run lifecycle clock. Historical activity is independent of live T3
OTLP ingestion.
