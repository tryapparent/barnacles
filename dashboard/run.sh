#!/bin/sh
set -eu

deploy_collector() (
  umask 077
  base=${PLOW_COLLECTOR_ROOT:?Set PLOW_COLLECTOR_ROOT}
  port=${PLOW_COLLECTOR_PORT:?Set PLOW_COLLECTOR_PORT}
  repo=tryapparent/plow
  dashboard=barnacles-harbor.service
  poller=barnacles-harbor-poller.service
  exec 9>"$base/deploy.lock"
  flock -n 9 || exit 0
  main_sha() {
    gh api "repos/$repo/git/ref/heads/main" --jq .object.sha
  }
  sha=$(main_sha)
  printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{40}$'
  previous=$(readlink -f "$base/current")
  if [ "$(cat "$previous/revision")" = "$sha" ]; then exit 0; fi
  run=$(gh run list --repo "$repo" --workflow verify.yml --branch main --event push \
    --commit "$sha" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  if [ -z "$run" ]; then exit 0; fi
  published=$(gh run view "$run" --repo "$repo" --json jobs \
    --jq 'any(.jobs[]; .name == "collector-release" and .conclusion == "success")')
  if [ "$published" != true ]; then exit 0; fi

  work=$(mktemp -d /tmp/apparent-dev-plow-deploy-XXXXXX)
  stage=$(mktemp -d "$base/releases/$sha-XXXXXX")
  switching=0
  candidate_pid=
  activate() {
    rm -f "$stage/.next"
    ln -s "$1" "$stage/.next"
    mv -Tf "$stage/.next" "$base/current"
  }
  cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ -n "$candidate_pid" ]; then kill "$candidate_pid" 2>/dev/null || true; fi
    if [ "$switching" = 1 ]; then
      systemctl --user stop "$poller" "$dashboard" || status=1
      if activate "$previous" && systemctl --user start "$dashboard" "$poller"; then
        printf '%s\n' 'Restored the previous Plow collector release.' >&2
      else
        printf '%s\n' 'Could not restore the previous Plow collector release.' >&2
        status=1
      fi
    fi
    rm -rf -- "$work"
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  gh run download "$run" --repo "$repo" --name "plow-collector-$sha" --dir "$work"
  artifact="$work/plow-collector.tar.gz"
  gh attestation verify "$artifact" --repo "$repo" --source-ref refs/heads/main \
    --source-digest "$sha" --signer-workflow "$repo/.github/workflows/verify.yml" \
    --deny-self-hosted-runners
  tar -xzf "$artifact" --no-same-owner -C "$stage"
  test "$(cat "$stage/revision")" = "$sha"
  test -f "$stage/web/index.html"
  (
    cd "$stage/source"
    npm ci --ignore-scripts
    node --input-type=module - "$base/polling/evidence.sqlite" "$work/evidence.sqlite" <<'JS'
import { backup, DatabaseSync } from "node:sqlite";
const input = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  await backup(input, process.argv[3]);
} finally {
  input.close();
}
JS
    BARNACLES_POLL_SETTINGS="$work/interval" node collector/import-sources.ts \
      "$work" poll-github "${PLOW_COLLECTOR_REPOSITORY:?Set PLOW_COLLECTOR_REPOSITORY}" "$stage/snapshot" --once
  )
  if [ -f "$previous/snapshot/session-study.sqlite" ]; then
    cp "$previous/snapshot/session-study.sqlite" "$stage/snapshot/"
  fi
  env -u BARNACLES_PROXY_HOST -u BARNACLES_PROXY_USER node "$stage/source/dashboard/prepare.ts" \
    --serve "$stage/snapshot" 0 "$stage/web" >"$work/candidate.log" 2>&1 &
  candidate_pid=$!
  origin=
  for attempt in $(seq 1 20); do
    origin=$(sed -nE 's|^Barnacles API (http://127\.0\.0\.1:[0-9]+)/api/v1$|\1|p' "$work/candidate.log")
    if [ -n "$origin" ]; then break; fi
    kill -0 "$candidate_pid"
    sleep 1
  done
  test -n "$origin"
  curl -fsS --max-time 5 "$origin/" -o /dev/null
  curl -fsS --max-time 5 "$origin/api/v1/shipping?limit=1" -o /dev/null
  kill "$candidate_pid"
  wait "$candidate_pid" || true
  candidate_pid=
  if [ "$(main_sha)" != "$sha" ]; then exit 0; fi
  before=$(stat -c %i "$stage/snapshot/dashboard.sqlite")
  switching=1
  systemctl --user stop "$poller" "$dashboard"
  activate "$stage"
  systemctl --user start "$dashboard" "$poller"
  for attempt in $(seq 1 60); do
    if systemctl --user is-active --quiet "$dashboard" &&
      systemctl --user is-active --quiet "$poller" &&
      [ "$(stat -c %i "$stage/snapshot/dashboard.sqlite")" != "$before" ] &&
      curl -fsS --max-time 5 -H "Tailscale-User-Login: ${PLOW_COLLECTOR_PROXY_USER:?Set PLOW_COLLECTOR_PROXY_USER}" \
        "http://127.0.0.1:$port/api/v1/shipping?limit=1" -o /dev/null; then
      switching=0
      printf 'Deployed Plow collector %s from Actions run %s.\n' "$sha" "$run"
      exit 0
    fi
    sleep 2
  done
  printf '%s\n' 'Plow collector did not publish a healthy snapshot.' >&2
  exit 1
)

if [ "$#" -eq 1 ] && [ "$1" = collector-deploy ]; then
  deploy_collector
  exit
fi

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '%s\n' 'Usage: dashboard/run.sh SNAPSHOT_DIRECTORY [up|grafana|config|down]' >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
action=${2:-up}
BARNACLES_SNAPSHOT_DIR=$root
if [ "$action" != down ]; then
  BARNACLES_SNAPSHOT_DIR=$(CDPATH= cd -- "$1" && pwd -P)
fi
BARNACLES_GRAFANA_UID=$(id -u)
BARNACLES_GRAFANA_GID=$(id -g)
if docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -qx name=rootless; then
  BARNACLES_GRAFANA_UID=0
  BARNACLES_GRAFANA_GID=0
fi
export BARNACLES_SNAPSHOT_DIR BARNACLES_GRAFANA_UID BARNACLES_GRAFANA_GID

compose() {
  docker compose -f "$root/../compose.yaml" "$@"
}

case $action in
  down) compose down ;;
  config) compose config ;;
  grafana)
    node "$root/prepare.ts" --validate "$BARNACLES_SNAPSHOT_DIR"
    current=$(compose ps -a -q grafana)
    if [ -z "$current" ] ||
      [ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/barnacles/dashboard.sqlite"}}{{.Source}}{{end}}{{end}}' "$current")" != "$BARNACLES_SNAPSHOT_DIR/dashboard.sqlite" ]; then
      printf '%s\n' 'Use up to activate a different snapshot or start a new deployment.' >&2
      exit 2
    fi
    compose up -d --no-deps --wait --wait-timeout 100 grafana
    ;;
  up)
    node "$root/prepare.ts" --validate "$BARNACLES_SNAPSHOT_DIR"
    compose up -d --no-deps --force-recreate tempo
    compose run --rm -T --no-deps tempo-replay
    compose up -d --no-deps --wait --wait-timeout 100 grafana
    ;;
  *)
    printf '%s\n' 'Expected up, grafana, config, or down.' >&2
    exit 2
    ;;
esac
