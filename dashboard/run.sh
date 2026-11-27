#!/bin/sh
set -eu

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

if [ "$#" -eq 2 ] && [ "$1" = t3-otlp ]; then
  manage_t3_otlp "$2"
  exit
fi

printf '%s\n' 'Usage: dashboard/run.sh t3-otlp apply|status|stop' >&2
exit 2
