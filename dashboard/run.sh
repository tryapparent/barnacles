#!/bin/sh
set -eu
dataset=$(cd "$1" && pwd)
[ -f "$dataset/dashboard.sqlite" ] && [ -f "$dataset/dashboards/shipping.json" ] || {
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
exec docker run --rm --user "$uid:$gid" \
  --tmpfs "/var/lib/grafana:uid=$uid,gid=$gid,mode=0700,exec" \
  -p "127.0.0.1:${BARNACLES_PORT:-3030}:3000" \
  --mount "type=bind,src=$dataset,dst=/barnacles,readonly" \
  --mount "type=bind,src=$root/provisioning/dashboards,dst=/etc/grafana/provisioning/dashboards,readonly" \
  --mount "type=bind,src=$root/provisioning/datasources,dst=/etc/grafana/provisioning/datasources,readonly" \
  -e "GF_PLUGINS_PREINSTALL_SYNC=frser-sqlite-datasource@4.0.9@$sqlite_url,marcusolsson-treemap-panel@2.1.1" \
  -e GF_AUTH_ANONYMOUS_ENABLED=true -e GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
  -e GF_AUTH_BASIC_ENABLED=false -e GF_AUTH_DISABLE_LOGIN_FORM=true \
  -e GF_USERS_DEFAULT_THEME=dark -e GF_ANALYTICS_REPORTING_ENABLED=false \
  -e GF_ANALYTICS_CHECK_FOR_UPDATES=false -e GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false \
  grafana/grafana:12.3.0
