# GitHub evidence collection

Run the Node 22.18+ producer with a separate fine-grained token or externally rotated installation token for each repository. Grant **Pull requests: read** and **Actions: read** on that repository. The producer issues authenticated GETs to the fixed GitHub API origin. The optional loopback HTTP origin is for synthetic verification. Requests never follow redirects or API-supplied URLs. Link headers supply page numbers only.

| Environment input | Value |
| --- | --- |
| PLOW_GITHUB_REPOSITORIES | Required comma-separated alias=owner/repo pairs. Up to 16 unique repositories and aliases. Repository is normalized to lowercase. Aliases start with a lowercase letter or digit and may contain up to 48 lowercase letters, digits, underscores or hyphens. |
| PLOW_GITHUB_CREDENTIAL_LAYOUT | Set to `per-alias` to use one credential file per alias. The default `legacy` layout supports the existing single-repository setup. |
| PLOW_GITHUB_CREDENTIAL_DIR | Absolute directory path for the per-alias layout. Each configured alias reads `github-read-<alias>` from this directory. |
| PLOW_GITHUB_READ_TOKEN_FILE | Single credential path required by the legacy layout. |
| PLOW_GITHUB_ACTIONS_SINCE | Required default Actions history floor as a UTC timestamp. Keep it stable for an existing checkpoint. |
| PLOW_GITHUB_ACTIONS_SINCE_BY_ALIAS | Optional JSON object mapping a configured alias to its own inclusive Actions history floor. Set it before adding a repository and keep it stable with its checkpoint. Both bounds also apply to reconciliation. PR backfill covers the visible list. |
| PLOW_GITHUB_STATE | Private durable state, default /state/github. Contains checkpoint, write-ahead batch, staged IDs and terminal receipts. |
| PLOW_SPOOL | Private shared spool root, default /spool. Keep its github subdirectory mode 0700. Configure ownership for this producer to write to the shared health subdirectory as well. |
| PLOW_GITHUB_JOB_NAMES | Optional JSON array of up to 512 reviewed names. Defaults to verify, build, test, lint, release and checks. Unapproved names become Other jobs. Keep the list stable with existing terminal receipts. |
| PLOW_GITHUB_MAX_STEPS | Optional work budget, default 40 operations per cycle, range 1–256. |
| PLOW_GITHUB_MAX_REQUESTS | Optional request budget, default 160 per cycle, range 24–512. |
| PLOW_BEND_BUNDLE | Path to the pinned compiler bundle produced by npm run hooks:install. Mount read-only in the runtime for offline compilation. |
| PLOW_GITHUB_ORIGIN | Defaults to https://api.github.com. The only override allowed is plain HTTP on 127.0.0.1. |

Keep one writer per state root and use distinct aliases across instances. Pre-create state, spool and credential directories with private permissions. Use the tracked entry point from a read-only checkout. Mount state and spool writable by the runtime user. Mount the compiler and credential directory read-only. Each credential must be a regular file owned by the worker's effective UID with mode 0400 or 0600 and a maximum size of 4 KiB. Symlinks are rejected. The worker reopens each file at the start of every cycle, so the credential provider can rotate it with an atomic rename in the mounted directory.

```sh
flock -n -F "$PLOW_GITHUB_STATE/writer.lock" node collect/github/main.ts
```

Run with `--once` for one bounded cycle. It returns an error after writing health if every configured credential is unreadable. The continuous process yields 15 seconds between cycles. Requests have an 8 MiB body cap, a 10-second timeout and a shared two-minute cycle deadline. Each alias uses only its configured credential. An unreadable credential or denied API request affects the failing repository while other aliases continue to run. Rate limits suspend requests only for the affected repository, including across restarts. A rotated credential resumes when the relevant retry time arrives.

## Inventory and checkpoints

- PR history starts at the last ascending creation page and walks backward. Recent additions append at the tail. Each page verifies its boundary against the newer page and restarts discovery when the boundary moves. Live PRs independently scan recent updates with a delayed upper watermark and a two-minute overlap.
- Actions live rechecks a rolling day for recent reruns and uses its last successful upper watermark with overlap to bridge a longer gap. Historical Actions scans newest-first in disjoint creation windows of up to seven days. A result at GitHub's 1,000-result ceiling splits the window, newer half first. A capped one-second window remains a coverage gap while older windows drain. Action sweeps renew six hours after inventory exhaustion to discover reruns of older runs within the configured floor. GitHub's creation query does not expose a global rerun update cursor.
- Each queued run drains exact attempts from latest through first. The producer compares exact attempt metadata around a bounded, paginated job inventory. A job without an attempt field binds through its exact-attempt endpoint only when run ID and SHA match. A terminal attempt receives a durable receipt after staging evidence from its terminal job inventory. Active, unreadable or capped attempts remain in the durable retry backlog. Retries share the cycle's request budget and do not block fresh inventory. HTTP 404 or 410 remains unavailable, including when GitHub masks authorization or an item expired. The configured floor bounds which Actions runs can be discovered by creation time. GitHub only returns retained evidence, and the producer emits `retention_unknown` even after exhausting the visible inventory. The floor controls source scans. Local staged IDs and receipts persist for replay protection.
- Bend2 constructs the entity identity and canonical allowlisted revision. The filesystem adapter hashes the canonical body and publishes immutable batches through a durable outbox. It syncs evidence before recording staged IDs and advancing the checkpoint. A restart can replay the same batch. Source replay contributes no new batch for previously staged revisions. Preserve staged IDs and terminal receipts when rotating spool files after downstream acknowledgement. Downstream consumers also deduplicate by event ID, since resetting Alloy positions can replay a file. Staging measures producer handoff only.

## Evidence and health contract

Immutable batches land in `/spool/github/*.jsonl`. Each JSON object has `kind`, `eventId`, `repository`, `observedMs` and `timestampMs`. Treat the ID as opaque. It combines a SHA-256 digest of the canonical revision and the entity identity. Typed identity fields identify the entity across revisions. All clocks are UTC Unix milliseconds. The source anchor `timestampMs` can be null. `observedMs` is the collection clock at staging.

| Kind | Fields and meaning |
| --- | --- |
| github_pr | Decimal string `prNumber`, open/closed/merged `status`, nullable full `headSha` and `mergeSha`, `openedMs`, `mergedMs`, `updatedMs`. Merge SHA requires merge time because GitHub can expose a test merge SHA. Anchor is merge when observed, otherwise opening. |
| github_actions_attempt | Decimal strings `runId`, `attempt`, nullable decimal `workflowId`, full `headSha`, nullable `prNumber`, `status` and `conclusion`. PR linkage requires one explicit association with matching base repository identity. `createdMs` is measured for the first attempt only. `startedMs` is measured for the first attempt if consistent with job start. `completedMs` is null because the endpoint lacks exact completion. `updatedMs` carries GitHub's mutable update clock. `lastJobCompletedMs` is a lower bound on terminal attempt completion. `jobCount` and `jobsComplete` describe observed inventory. Anchor is validated start or creation for the first attempt and earliest measured job start for reruns. |
| github_actions_job | Decimal strings `runId`, `attempt`, `jobId`, full `headSha`, reviewed `jobName`, nullable `status`, `conclusion`, `createdMs`, `startedMs`, `completedMs`. Start and end require worker allocation and ordered source values. Anchor uses completion, start or creation in that order. |
| github_coverage | `lane`, `status`, `availability` (available, partial, unavailable or unknown), nullable `gapCode`, `windowStartMs`, `windowEndMs`, `remainingThroughMs` and `page`, count `pendingAttempts`, nullable `runId` and `attempt`. Lanes are pulls_live, pulls_backfill, actions_live, actions_backfill and actions_retention. Window exhaustion refers to an enumerated time window. Lane completion additionally requires drained pending attempts and no detected scan gap. Retention gaps are visible independently. |

Records omit PR content, actors, commit messages, ref names, raw job names, runner names, steps and logs. Release evidence awaits an explicit delivery mapping. This collector leaves publication, shipping and verified external access unknown.

Health uses `/spool/health/github-<alias>-<unique>.jsonl` with `kind=collector_health`, `schemaVersion=1`, `collector=github`, configured `scope`, `lane=live|backfill` and `status=working|idle|retrying|blocked|complete`. Both lanes emit after each cycle, including rate-limit backoff and after backfill catches up. `observedMs` is the heartbeat clock. `lastSuccessMs` is the latest successful source checkpoint in that lane. `newestSourceMs` and `oldestScannedMs` preserve known source clocks and scan bounds. `scannedUnits`, `eligibleUnits` and `ingestedRecords` stay null because these lanes mix pages, windows and attempts and the producer cannot see Loki acknowledgements.

## Compose deployment

The [Compose overlay](../../infra/lgtm/github.compose.yaml) runs one worker with a writer lock in the private persistent state directory. For the existing Clanker stack, apply from the same pinned release directory and with the same private runtime as the Grafana project. Set the authorized repository list and intended floor before the first run.

```sh
export PLOW_LGTM_WORKDIR=/private/plow/runtime
export PLOW_GITHUB_CREDENTIAL_DIR=/private/plow/github-credentials
export PLOW_BEND_BUNDLE=/private/plow/verified-compiler
export PLOW_GITHUB_COLLECTOR_USER=0:0
export PLOW_GITHUB_REPOSITORIES=plow=tryapparent/plow,apparent=tryapparent/apparent
export PLOW_GITHUB_CREDENTIAL_LAYOUT=per-alias
export PLOW_GITHUB_ACTIONS_SINCE=2026-01-01T00:00:00Z
bash infra/lgtm/deploy.sh --github-only
```

Provision `github-read-plow` and `github-read-apparent` separately in `PLOW_GITHUB_CREDENTIAL_DIR`, each scoped to its corresponding repository under the `tryapparent` resource owner. Grant read access to Pull requests and Actions, with the automatic Metadata read permission. Keep the directory private.

Existing single-repository deployments can keep `github-read` and omit the layout setting. To expand an existing deployment, keep the runtime directory, existing alias and Actions floor. Add the per-alias files and switch the layout and repository list in the deployment inputs. The worker retains the version 1 checkpoint, cursors, retry queues, receipts and staged IDs. When upgrading a checkpoint from the original collector, the old shared cooldown carries over in legacy mode. Per-alias mode establishes a cooldown independently for each repository. Each newly configured repository starts its own live and backfill cursors.

Use the service UID and GID as seen inside the container. On Clanker's rootless Docker, `0:0` maps to the host account that owns the private runtime. The deploy script prepares `github-state` and uses the existing shared `spool`. Keep the private state, spool and compiler paths stable across reapplications. Keep the aliases, floor and job-name allowlist stable with the checkpoints. Ensure that the worker and Alloy can access the spool under their configured identities.

The script targets the existing `plow-grafana` project by default. Set `COMPOSE_PROJECT_NAME` to a unique name for an isolated candidate. The GitHub-only mode starts or reapplies only `github-collector` with the production restart policy. For a full stack deployment, export `PLOW_GITHUB_ENABLED=true` with the same inputs and use the deployment mode for the current ingress. Keep the configured T3 and Codex capture profiles and inputs on full deployments.

After startup, verify a fresh GitHub `live` and `backfill` heartbeat for each configured alias in Collection Health. Confirm both lanes record successful source reads and check any gap code. A running container or a staged spool file alone does not prove delivery to Grafana.

To roll back the worker, unset the enable flag for subsequent full deployments and stop just the service from the release directory with the same inputs.

```sh
docker compose -p plow-grafana -f compose.yaml -f infra/lgtm/github.compose.yaml stop github-collector
```

Retain `github-state`, the shared spool and Alloy storage for resume. Use the same overlay and `docker compose run --rm --no-deps github-collector --once` for a bounded run against an isolated state and spool.

The [common Alloy configuration](../alloy/config.txt) reads the GitHub spool and indexes records by source time when present, partitioned by UTC hour for late-arriving history. Records without a source anchor use Alloy’s observation time. Both producer clocks remain in each record. A separate receiver sends health reports to the [Collection Health dashboard](../../grafana/collection-health.md). [Alloy filelog settings](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.filelog/) · [Loki ordering limits](https://grafana.com/docs/loki/latest/configure/)

## Verification

```sh
npm ci --ignore-scripts
npm run hooks:install
node --test collect/github/history.test.ts
npm run verify -- collect
```

The CLI test restarts independent Node processes over the same private spool and checkpoint and reads a synthetic loopback API. It expands a legacy checkpoint to two aliases, verifies that an over-permissive file is rejected and confirms that the other alias still reports successful live and backfill reads. Set PLOW_GITHUB_KEEP_PROOF=1 with the direct test command to retain the generated synthetic proof in a private temporary directory.
