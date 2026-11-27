#!/bin/sh
set -eu

history_ready() {
  for route in /sessions /api/v1/sessions; do
    status=$(curl -fsS --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' \
      -H "Tailscale-User-Login: ${PLOW_COLLECTOR_PROXY_USER:?Set PLOW_COLLECTOR_PROXY_USER}" \
      "http://127.0.0.1:${PLOW_COLLECTOR_PORT:?Set PLOW_COLLECTOR_PORT}$route") || return 1
    [ "$status" = 200 ] || return 1
  done
}

check_snapshot() {
  node --input-type=module - "$1" <<'JS'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") process.exitCode = 1;
} finally {
  db.close();
}
JS
}

deploy_collector() (
  umask 077
  base=${PLOW_COLLECTOR_ROOT:?Set PLOW_COLLECTOR_ROOT}
  repo=tryapparent/plow
  poller=barnacles-harbor-poller.service
  export PLOW_BEND_BUNDLE=${PLOW_BEND_BUNDLE:-${BARNACLES_BEND_BUNDLE:-}}
  exec 9>"$base/deploy.lock"
  flock -n 9 || exit 0
  main_sha() {
    gh api "repos/$repo/git/ref/heads/main" --jq .object.sha
  }
  sha=$(main_sha)
  printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{40}$'
  previous=$(readlink -f "$base/current")
  if [ "$(cat "$previous/revision")" = "$sha" ]; then
    history_ready
    exit
  fi
  run=$(gh run list --repo "$repo" --workflow verify.yml --branch main --event push \
    --commit "$sha" --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')
  if [ -z "$run" ]; then exit 0; fi
  published=$(gh run view "$run" --repo "$repo" --json jobs \
    --jq 'any(.jobs[]; .name == "collector-release" and .conclusion == "success")')
  if [ "$published" != true ]; then exit 0; fi
  test -L "$base/history"
  history_ready

  work=$(mktemp -d /tmp/apparent-dev-plow-deploy-XXXXXX)
  stage=
  switching=0
  keep=0
  activate() {
    rm -f "$stage/.next"
    ln -s "$1" "$stage/.next"
    mv -Tf "$stage/.next" "$base/current"
  }
  cleanup() {
    result=$?
    trap - EXIT HUP INT TERM
    if [ "$switching" = 1 ]; then
      systemctl --user stop "$poller" || result=1
      if activate "$previous" && systemctl --user start "$poller"; then
        printf '%s\n' 'Restored the previous Plow collector release.' >&2
      else
        printf '%s\n' 'Could not restore the previous Plow collector release.' >&2
        keep=1
        result=1
      fi
    fi
    if [ "$keep" = 0 ] && [ -n "$stage" ]; then rm -rf -- "$stage"; fi
    rm -rf -- "$work"
    exit "$result"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  stage=$(mktemp -d "$base/releases/$sha-XXXXXX")
  gh run download "$run" --repo "$repo" --name "plow-collector-$sha" --dir "$work"
  artifact="$work/plow-collector.tar.gz"
  gh attestation verify "$artifact" --repo "$repo" --source-ref refs/heads/main \
    --source-digest "$sha" --signer-workflow "$repo/.github/workflows/verify.yml" \
    --deny-self-hosted-runners
  tar -xzf "$artifact" --no-same-owner --same-permissions -C "$stage"
  test "$(cat "$stage/revision")" = "$sha"
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
    PLOW_POLL_SETTINGS="$work/interval" node collector/import-sources.ts \
      "$work" poll-github "${PLOW_COLLECTOR_REPOSITORY:?Set PLOW_COLLECTOR_REPOSITORY}" "$stage/snapshot" --once
  )
  check_snapshot "$stage/snapshot/dashboard.sqlite"
  if [ "$(main_sha)" != "$sha" ]; then exit 0; fi
  before=$(stat -c %i "$stage/snapshot/dashboard.sqlite")
  switching=1
  systemctl --user stop "$poller"
  activate "$stage"
  systemctl --user start "$poller"
  for attempt in $(seq 1 60); do
    if systemctl --user is-active --quiet "$poller" &&
      [ "$(stat -c %i "$stage/snapshot/dashboard.sqlite")" != "$before" ]; then
      check_snapshot "$stage/snapshot/dashboard.sqlite"
      history_ready
      keep=1
      switching=0
      printf 'Deployed Plow collector %s from Actions run %s.\n' "$sha" "$run"
      exit 0
    fi
    sleep 2
  done
  printf '%s\n' 'Plow collector did not publish a healthy snapshot.' >&2
  exit 1
)

install_collector_cutover() (
  umask 077
  base=${PLOW_COLLECTOR_ROOT:?Set PLOW_COLLECTOR_ROOT}
  port=${PLOW_COLLECTOR_PORT:?Set PLOW_COLLECTOR_PORT}
  bundle=${PLOW_BEND_BUNDLE:?Set PLOW_BEND_BUNDLE}
  units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  dashboard=barnacles-harbor.service
  poller=barnacles-harbor-poller.service
  history_override="$units/$dashboard.d/plow-history.conf"
  poller_override="$units/$poller.d/plow-collector.conf"
  case "$base$bundle" in *[!A-Za-z0-9./_-]*) exit 2 ;; esac
  case "$base" in /*) ;; *) exit 2 ;; esac
  case "$bundle" in /*) ;; *) exit 2 ;; esac
  printf '%s\n' "$port" | grep -Eq '^[0-9]{1,5}$'
  test -d "$bundle"
  exec 9>"$base/deploy.lock"
  flock 9
  if [ ! -L "$base/history" ]; then
    prior=$(readlink -f "$base/current")
    test -f "$prior/web/index.html"
    test -f "$prior/source/dashboard/prepare.ts"
    test -f "$prior/snapshot/session-study.sqlite"
    ln -s "$prior" "$base/history"
  fi
  test -f "$base/history/web/index.html"
  test -f "$base/history/snapshot/session-study.sqlite"
  history_ready

  work=$(mktemp -d /tmp/apparent-dev-plow-cutover-XXXXXX)
  changed=0
  cleanup() {
    result=$?
    trap - EXIT HUP INT TERM
    if [ "$changed" = 1 ]; then
      restore "$work/old-history" "$history_override"
      restore "$work/old-poller" "$poller_override"
      systemctl --user daemon-reload || result=1
      systemctl --user restart "$dashboard" || result=1
      history_ready || result=1
    fi
    rm -rf -- "$work"
    exit "$result"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  write_config() {
    install -D -m 0600 "$1" "$2.next"
    mv -f "$2.next" "$2"
  }
  restore() {
    if [ -f "$1" ]; then write_config "$1" "$2"; else rm -f "$2"; fi
  }
  if [ -f "$history_override" ]; then cp "$history_override" "$work/old-history"; fi
  if [ -f "$poller_override" ]; then cp "$poller_override" "$work/old-poller"; fi
  cat >"$work/history" <<EOF
[Service]
WorkingDirectory=$base/history/source
ExecStart=
ExecStart=/usr/bin/node dashboard/prepare.ts --serve $base/history/snapshot $port $base/history/web
EOF
  cat >"$work/poller" <<EOF
[Service]
Environment=PLOW_BEND_BUNDLE=$bundle
Environment=PLOW_POLL_SETTINGS=$base/polling/poll-interval
EOF
  if ! cmp -s "$work/history" "$history_override" || ! cmp -s "$work/poller" "$poller_override"; then
    changed=1
    write_config "$work/history" "$history_override"
    write_config "$work/poller" "$poller_override"
    systemctl --user daemon-reload
    systemctl --user restart "$dashboard"
    for attempt in $(seq 1 20); do
      if history_ready; then break; fi
      sleep 1
    done
    history_ready
  fi
  if ! cmp -s "$0" "$base/collector-deploy.sh"; then
    if [ -f "$base/collector-deploy.sh" ] && [ ! -e "$base/collector-deploy.previous.sh" ]; then
      install -m 0700 "$base/collector-deploy.sh" "$base/collector-deploy.previous.sh"
    fi
    install -m 0700 "$0" "$base/collector-deploy.sh.next"
    mv -f "$base/collector-deploy.sh.next" "$base/collector-deploy.sh"
  fi
  changed=0
  printf '%s\n' 'Installed source-only collector rollout and verified private Session history.'
)

restore_history_ingress() (
  host=${PLOW_COLLECTOR_HISTORY_HOST:?Set PLOW_COLLECTOR_HISTORY_HOST to the existing private host and port}
  port=${host##*:}
  listener=${PLOW_COLLECTOR_PORT:?Set PLOW_COLLECTOR_PORT}
  printf '%s\n' "$port" "$listener" | grep -vEq '^[0-9]{1,5}$' && exit 2
  self=$(tailscale status --json | jq -er '.Self.DNSName | rtrimstr(".")')
  test "$host" = "$self:$port"
  history_ready
  state() {
    tailscale serve status --json | jq -r --arg host "$host" --arg port "$port" --arg listener "$listener" '
      if .AllowFunnel[$host] then "conflict"
      elif .Web[$host].Handlers == {"/": {Proxy: ("http://127.0.0.1:" + $listener)}} and .TCP[$port].HTTPS
      then "configured"
      elif .TCP[$port] == null and .Web[$host] == null then "absent"
      else "conflict" end'
  }
  created=0
  case "$(state)" in
    absent)
      tailscale serve --bg --https="$port" "http://127.0.0.1:$listener"
      created=1
      ;;
    configured) ;;
    *) printf '%s\n' 'Existing Serve configuration conflicts with the private Session history route.' >&2; exit 1 ;;
  esac
  if [ "$(state)" != configured ]; then
    if [ "$created" = 1 ]; then tailscale serve --https="$port" off; fi
    printf '%s\n' 'The expected private HTTPS mapping could not be verified.' >&2
    exit 1
  fi
  printf '%s\n' 'Verified the existing private Session history HTTPS mapping. Funnel is off.'
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

if [ "$#" -eq 1 ]; then
  case "$1" in
    collector-deploy) deploy_collector; exit ;;
    collector-cutover) install_collector_cutover; exit ;;
    collector-history-ingress) restore_history_ingress; exit ;;
  esac
fi

if [ "$#" -eq 2 ] && [ "$1" = t3-otlp ]; then
  manage_t3_otlp "$2"
  exit
fi

printf '%s\n' 'Usage: dashboard/run.sh collector-cutover | collector-deploy | collector-history-ingress | t3-otlp apply|status|stop' >&2
exit 2
