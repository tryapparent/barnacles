set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
export PLOW_LGTM_WORKDIR=$(mktemp -d /tmp/apparent-dev-plow-access-XXXXXX)
job=${PLOW_LGTM_WORKDIR##*-}
project="plow-access-${job,,}"
export PLOW_ACCESS_IMAGE="$project:local"
export PLOW_TAILNET_ORIGIN=https://candidate.example.ts.net:19480
compose() {
  docker compose -p "$project" -f infra/lgtm/compose.yaml -f infra/access/compose.yaml "$@"
}
cleanup() {
  status=$?
  rm -f "$PLOW_LGTM_WORKDIR/mcp/token"
  compose down --volumes > "$PLOW_LGTM_WORKDIR/cleanup.log" 2>&1
  printf 'Synthetic access check status %s. Evidence in %s\n' "$status" "$PLOW_LGTM_WORKDIR"
}
trap cleanup EXIT

node --experimental-transform-types collect/fixture.ts "$PLOW_LGTM_WORKDIR"
mkdir -m 0777 "$PLOW_LGTM_WORKDIR/access-grafana"
openssl rand -hex 24 > "$PLOW_LGTM_WORKDIR/grafana-password"
chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"

compose config --quiet
compose build grafana-mcp
compose up -d --build --wait --wait-timeout 120
first=$(compose ps -q grafana)
[[ -z $(docker inspect --format '{{range .NetworkSettings.Ports}}{{if .}}{{.}}{{end}}{{end}}' "$first") ]]
node --test infra/access/access.test.mjs
compose up -d --no-build --wait --wait-timeout 120
[[ "$first" == "$(compose ps -q grafana)" ]]
PLOW_ACCESS_REAPPLY=1 node --test infra/access/access.test.mjs
printf 'Candidate startup and reapply retained the Grafana container, Viewer and fixture query.\n'

export PLOW_MCP_TOKEN_FILE="$PLOW_LGTM_WORKDIR/mcp/token"
mkdir -m 0700 "$(dirname "$PLOW_MCP_TOKEN_FILE")"
grafana_admin() {
  curl -fsS --max-time 15 --unix-socket "$PLOW_LGTM_WORKDIR/access-grafana/grafana.sock" \
    --netrc-file <(printf 'default login admin password %s\n' "$(cat "$PLOW_LGTM_WORKDIR/grafana-password")") "$@"
}
api=http://localhost/app/api
account=$(grafana_admin "$api/serviceaccounts" -H 'Content-Type: application/json' \
  --data '{"name":"plow-fixture-mcp","role":"Viewer"}' | jq -er '.id | numbers')
umask 077
grafana_admin "$api/serviceaccounts/$account/tokens" -H 'Content-Type: application/json' \
  --data '{"name":"verification","secondsToLive":300}' | jq -er .key > "$PLOW_MCP_TOKEN_FILE"
chmod 0444 "$PLOW_MCP_TOKEN_FILE"
grafana_admin "$api/dashboards/uid/plow-run-breakdown" | jq -ce '
  {from:"1748951940000",to:"1748952060000",queries:[(.dashboard.panels[] | select(.id == 1) | .targets[0] | .runId = "fixture-run")]}
' > "$PLOW_LGTM_WORKDIR/query.json"
grafana_admin "$api/ds/query" -H 'Content-Type: application/json' \
  --data-binary "@$PLOW_LGTM_WORKDIR/query.json" > "$PLOW_LGTM_WORKDIR/direct.json"
node verify/grafana-mcp.ts "$PLOW_LGTM_WORKDIR/query.json" \
  "$PLOW_LGTM_WORKDIR/direct.json" "$PLOW_LGTM_WORKDIR/mcp.json" --exact \
  -p "$project" -f infra/lgtm/compose.yaml -f infra/access/compose.yaml
rm -- "$PLOW_MCP_TOKEN_FILE"
