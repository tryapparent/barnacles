# GitHub-only Octokit pilot

Run the [standalone Compose project](compose.yaml) from the repository root.
Its only service reads `tryapparent/apparent` and writes a private
`evidence.sqlite` to the mounted state directory. The image uses a digest-pinned
Node base, the npm lockfile and the checksum-verified Bend2 compiler. Compose
consumes the YAML declaration directly. The project has no listeners and
creates no Harbor snapshot.

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
