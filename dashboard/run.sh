#!/bin/sh
set -eu
dataset=$(cd "$1" && pwd)
[ -f "$dataset/dashboard.sqlite" ] && [ -f "$dataset/tempo.ndjson" ] && [ -f "$dataset/dashboards/shipping.json" ] || {
  printf '%s\n' 'Run dashboard/prepare.ts to build the local evidence snapshot first.' >&2
  exit 1
}
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
uid=$(id -u)
gid=$(id -g)
if docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -qx name=rootless; then
  uid=0
  gid=0
fi
sqlite_url=https://github.com/fr-ser/grafana-sqlite-datasource/releases/download/v4.0.9/frser-sqlite-datasource-4.0.9.zip
network=$(docker network create --label app=barnacles-local "barnacles-local-$$")
tempo=''
cleanup() {
  if [ -n "$tempo" ]; then docker stop "$tempo" >/dev/null || :; fi
  docker network rm "$network" >/dev/null || :
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
tempo=$(docker run -d --rm --network "$network" --network-alias tempo \
  --tmpfs '/var/tempo:uid=10001,gid=10001,mode=0700' \
  -p '127.0.0.1::3200' -p '127.0.0.1::4318' \
  --mount "type=bind,src=$root/provisioning/tempo.yml,dst=/etc/tempo.yml,readonly" \
  grafana/tempo:3.1.1 -target=all -config.file=/etc/tempo.yml)
node "$root/load-tempo.ts" "$dataset/tempo.ndjson" "$(docker port "$tempo" 3200/tcp)" "$(docker port "$tempo" 4318/tcp)"
docker run --rm --network "$network" --user "$uid:$gid" \
  --tmpfs "/var/lib/grafana:uid=$uid,gid=$gid,mode=0700,exec" \
  -p "127.0.0.1:${BARNACLES_PORT:-3030}:3000" \
  --mount "type=bind,src=$dataset/dashboard.sqlite,dst=/barnacles/dashboard.sqlite,readonly" \
  --mount "type=bind,src=$dataset/dashboards,dst=/barnacles/dashboards,readonly" \
  --mount "type=bind,src=$root/provisioning/dashboards,dst=/etc/grafana/provisioning/dashboards,readonly" \
  --mount "type=bind,src=$root/provisioning/datasources,dst=/etc/grafana/provisioning/datasources,readonly" \
  -e "GF_PLUGINS_PREINSTALL_SYNC=frser-sqlite-datasource@4.0.9@$sqlite_url,marcusolsson-treemap-panel@2.1.1" \
  -e GF_AUTH_ANONYMOUS_ENABLED=true -e GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
  -e GF_AUTH_BASIC_ENABLED=false -e GF_AUTH_DISABLE_LOGIN_FORM=true \
  -e GF_USERS_DEFAULT_THEME=dark -e GF_ANALYTICS_REPORTING_ENABLED=false \
  -e GF_ANALYTICS_CHECK_FOR_UPDATES=false -e GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
  grafana/grafana:12.3.0
