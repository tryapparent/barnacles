#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '%s\n' 'Usage: dashboard/run.sh SNAPSHOT_DIRECTORY [up|grafana|config|down]' >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
action=${2:-up}
PLOW_SNAPSHOT_DIR=$root
if [ "$action" != down ]; then
  PLOW_SNAPSHOT_DIR=$(CDPATH= cd -- "$1" && pwd -P)
fi
PLOW_GRAFANA_UID=$(id -u)
PLOW_GRAFANA_GID=$(id -g)
if docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -qx name=rootless; then
  PLOW_GRAFANA_UID=0
  PLOW_GRAFANA_GID=0
fi
export PLOW_SNAPSHOT_DIR PLOW_GRAFANA_UID PLOW_GRAFANA_GID

compose() {
  docker compose -f "$root/../compose.yaml" "$@"
}

case $action in
  down) compose down ;;
  config) compose config ;;
  grafana)
    node "$root/prepare.ts" --validate "$PLOW_SNAPSHOT_DIR"
    current=$(compose ps -a -q grafana)
    if [ -z "$current" ] ||
      [ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/plow/dashboard.sqlite"}}{{.Source}}{{end}}{{end}}' "$current")" != "$PLOW_SNAPSHOT_DIR/dashboard.sqlite" ]; then
      printf '%s\n' 'Use up to activate a different snapshot or start a new deployment.' >&2
      exit 2
    fi
    compose up -d --no-deps --wait --wait-timeout 100 grafana
    ;;
  up)
    node "$root/prepare.ts" --validate "$PLOW_SNAPSHOT_DIR"
    compose up -d --no-deps --force-recreate tempo
    compose run --rm -T --no-deps tempo-replay
    compose up -d --no-deps --wait --wait-timeout 100 grafana
    ;;
  *)
    printf '%s\n' 'Expected up, grafana, config, or down.' >&2
    exit 2
    ;;
esac
