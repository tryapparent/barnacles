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
  tar -xzf "$artifact" --no-same-owner --same-permissions -C "$stage"
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

manage_t3_otlp() (
  umask 077
  action=$1
  settings=${PLOW_T3_DEPLOY_ENV:?Set PLOW_T3_DEPLOY_ENV to the private Compose environment file}
  release=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
  stack="$release/collector/t3-otel/compose.yaml"
  test -r "$settings"
  if [ ! -f "$stack" ]; then
    printf '%s\n' 'This release is missing the durable T3 OTLP Compose stack.' >&2
    exit 1
  fi
  compose() {
    if [ -n "${PLOW_T3_COMPOSE_PROJECT:-}" ]; then
      set -- --project-name "$PLOW_T3_COMPOSE_PROJECT" "$@"
    fi
    docker --context rootless compose --env-file "$settings" --file "$stack" "$@"
  }

  case "$action" in
    apply)
      if ! compose config --format json | jq -e '
        [.services[].ports[]?] as $ports |
        all(.services[]; .network_mode != "host") and
        $ports == .services.traces.ports and ($ports | length) == 1 and
        $ports[0].host_ip == "127.0.0.1" and
        $ports[0].target == 4318 and $ports[0].protocol == "tcp"
      ' >/dev/null; then
        printf '%s\n' 'Expected only the loopback TCP mapping for the T3 traces service.' >&2
        exit 1
      fi
      compose up --detach --build --wait --wait-timeout 60
      listener=$(compose port traces 4318)
      case "$listener" in
        127.0.0.1:*) ;;
        *) printf '%s\n' 'Expected a loopback-only T3 OTLP listener.' >&2; exit 1 ;;
      esac
      for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if status=$(curl --silent --max-time 2 --noproxy '*' -o /dev/null -w '%{http_code}' \
            -H 'Content-Type: application/json' --data '{}' "http://$listener/v1/traces") &&
            [ "$status" = 401 ] &&
            compose exec --no-TTY evidence node -e '
              fetch("http://127.0.0.1:4320/v1/traces", {
                method: "POST", body: "{}", signal: AbortSignal.timeout(2000)
              }).then(
                response => { process.exitCode = response.status === 401 ? 0 : 1; },
                () => { process.exitCode = 1; }
              );
            ' >/dev/null 2>&1; then
          printf '%s\n' 'Both T3 OTLP listeners rejected a request without a bearer.'
          exit 0
        fi
        sleep 1
      done
      printf '%s\n' 'The T3 Collector and evidence receiver did not both pass the bearer-gate check.' >&2
      exit 1
      ;;
    status) compose ps --all ;;
    stop) compose stop ;;
    *) printf '%s\n' 'Usage: dashboard/run.sh t3-otlp apply|status|stop' >&2; exit 2 ;;
  esac
)

if [ "$#" -eq 1 ] && [ "$1" = collector-deploy ]; then
  deploy_collector
  exit
fi

if [ "$#" -eq 2 ] && [ "$1" = t3-otlp ]; then
  manage_t3_otlp "$2"
  exit
fi

printf '%s\n' 'Usage: dashboard/run.sh collector-deploy | t3-otlp apply|status|stop' >&2
exit 2
