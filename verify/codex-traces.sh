set -euo pipefail
umask 077

cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
legacy=$(realpath -- "${1:?Pass the verified legacy Collector release source directory}")
[[ -r "$legacy/collector/codex/otelcol.yaml" && -r "$legacy/collector/codex/otel.ts" ]]

proof=$(mktemp -d /tmp/apparent-dev-plow-codex-traces-XXXXXX)
export PLOW_LGTM_WORKDIR=$proof
job=${proof##*-}
project=plow-traces-${job,,}
unset COMPOSE_PROFILES PLOW_CODEX_TRACE_BASE_CONFIG PLOW_CODEX_TRACE_ENV_FILE
export PLOW_GRAFANA_IMAGE="$project:local" PLOW_GRAFANA_PORT=0 PLOW_GRAFANA_TAILNET_AUTH=false PLOW_LGTM_RESTART=no
compose() { docker compose -p "$project" "$@"; }
cleanup() {
  local status=$?
  if (( status != 0 )); then compose --profile codex-trace-fanout logs > "$proof/compose.log" 2>&1 || true; fi
  if [[ -n ${receiver_pid:-} ]]; then kill "$receiver_pid" 2>/dev/null || true; fi
  compose --profile codex-trace-fanout down --volumes > "$proof/cleanup.log" 2>&1 || status=1
  rm -f "$proof"/{mcp-token,viewer-header,fixture.env,grafana-password}
  docker image rm "$PLOW_GRAFANA_IMAGE" >> "$proof/cleanup.log" 2>&1 || true
  printf 'Private proof outputs: %s\n' "$proof"
  return "$status"
}
trap cleanup EXIT

mkdir "$proof/spool"
touch "$proof/spool/"{codex,t3}.jsonl
chmod 755 "$proof/spool"
chmod 644 "$proof/spool/"{codex,t3}.jsonl
openssl rand -hex 24 > "$proof/grafana-password"
chmod 444 "$proof/grafana-password"
free_port() {
  node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
export PLOW_TEMPO_ALLOY_PORT
PLOW_TEMPO_ALLOY_PORT=$(free_port)
compose up -d --build --wait --wait-timeout 120

grafana=$(compose port grafana 3000)
alloy=$(compose port alloy 4318)
tempo=$(compose port tempo 3200)
mimir=$(compose port mimir 9009)
[[ $grafana == 127.0.0.1:* && $alloy == 127.0.0.1:* && $tempo == 127.0.0.1:* && $mimir == 127.0.0.1:* ]]
[[ $alloy == "127.0.0.1:$PLOW_TEMPO_ALLOY_PORT" ]]
db="$proof/evidence.sqlite"
source_token=$(openssl rand -hex 24)
evidence_token=$(openssl rand -hex 24)
PLOW_OTLP_EVIDENCE_PORT=0 PLOW_OTLP_EVIDENCE_TOKEN=$evidence_token \
  node "$legacy/collector/codex/otel.ts" "$proof" trace-fixture \
  > "$proof/legacy.log" 2>&1 &
receiver_pid=$!
for ((attempt=0; attempt<30; attempt++)); do
  evidence_port=$(sed -n 's/^Codex OTLP evidence ready on 127\.0\.0\.1:\([0-9]*\)$/\1/p' "$proof/legacy.log")
  [[ -z $evidence_port ]] || break
  kill -0 "$receiver_pid"
  sleep 1
done
[[ $evidence_port =~ ^[0-9]+$ ]]
collector_port=$(free_port)
export PLOW_CODEX_TRACE_BASE_CONFIG="$legacy/collector/codex/otelcol.yaml"
export PLOW_CODEX_TRACE_ENV_FILE="$proof/fixture.env"
printf '%s\n' "PLOW_CODEX_OTLP_PORT=$collector_port" "PLOW_CODEX_OTLP_TOKEN=$source_token" \
  "PLOW_OTLP_EVIDENCE_PORT=$evidence_port" "PLOW_OTLP_EVIDENCE_TOKEN=$evidence_token" > "$PLOW_CODEX_TRACE_ENV_FILE"

compose run --rm --no-deps codex-trace-fanout validate --config=/etc/plow.yaml --config=/etc/plow-fanout.yaml
compose up -d --no-deps codex-trace-fanout
collector=$(compose --profile codex-trace-fanout ps -q codex-trace-fanout)
[[ -n $collector ]]
compose up -d --no-deps codex-trace-fanout
[[ $(compose --profile codex-trace-fanout ps -q codex-trace-fanout) == "$collector" ]]

trace_id=11111111111111111111111111111111
now=$(date +%s)
start_ns=$(( (now - 2) * 1000000000 ))
child_ns=$(( start_ns + 200000000 ))
child_end_ns=$(( start_ns + 700000000 ))
end_ns=$(( start_ns + 1200000000 ))
canary=synthetic-private-trace-canary
fixture() {
  jq -nc --arg trace "$1" --arg start "$start_ns" --arg end "$end_ns" \
    --arg childStart "$child_ns" --arg childEnd "$child_end_ns" --arg canary "$canary" '
    def attr($key; $value): {key:$key, value:{stringValue:$value}};
    [attr("private"; $canary)] as $private |
    {resourceSpans:[{resource:{attributes:$private},scopeSpans:[{
      scope:{name:$canary,version:$canary,attributes:$private},spans:[
        {traceId:$trace,spanId:"2222222222222222",name:"run_turn",
         startTimeUnixNano:$start,endTimeUnixNano:$end,traceState:$canary,
         status:{code:1,message:$canary},attributes:($private + [
           attr("conversation.id"; "11111111-1111-1111-1111-111111111111"),
           attr("turn.id"; "22222222-2222-2222-2222-222222222222")])},
        {traceId:$trace,spanId:"3333333333333333",parentSpanId:"2222222222222222",name:"exec_command",
         startTimeUnixNano:$childStart,endTimeUnixNano:$childEnd,status:{code:2,message:$canary},
         attributes:($private + [attr("call_id"; "call_fixture")]),
         events:[{timeUnixNano:$childEnd,name:$canary,attributes:($private + [
           attr("event.name"; "codex.tool_result"),attr("success"; "false")])}]}
      ]}]}]}
  ' > "$proof/fixture-$1.json"
}
fixture "$trace_id"

endpoint="http://127.0.0.1:$collector_port/v1/traces"
post() {
  curl -sS --retry 5 --retry-connrefused --max-time 10 -o "$proof/collector-receipt.json" \
    -w '%{http_code}' -H @<(printf 'Authorization: Bearer %s\n' "$2") -H 'Content-Type: application/json' \
    --data-binary "@$proof/fixture-$1.json" "$endpoint"
}
[[ $(post "$trace_id" wrong-token) == 401 ]]
[[ $(post "$trace_id" "$source_token") == 200 ]]

legacy_proof() {
  node --input-type=module - "$db" "$1" <<'JS'
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const [path, id] = process.argv.slice(2);
const db = new DatabaseSync(path, { readOnly: true });
const spans = db.prepare(
  "SELECT span_id,parent_span_id,operation,start_ns,end_ns,status_code,conversation_id,turn_id,call_id FROM codex_otel_spans WHERE instance='trace-fixture' AND trace_id=? ORDER BY span_id"
).all(id);
const event = db.prepare(
  "SELECT span_id,event,observed_ns,success FROM codex_otel_span_events WHERE instance='trace-fixture' AND trace_id=?"
).get(id);
assert.equal(spans.length, 2);
assert.equal(spans[1].parent_span_id, spans[0].span_id);
assert.equal(event.observed_ns, spans[1].end_ns);
console.log(JSON.stringify({ spans, event }));
JS
}
legacy_proof "$trace_id" > "$proof/legacy.json"
grafana_api() {
  curl -fsS --max-time 10 --netrc-file <(printf 'default login admin password %s\n' "$(cat "$proof/grafana-password")") "$@"
}
grafana_api "http://$grafana/api/dashboards/uid/plow-codex-traces" > "$proof/dashboard.json"
jq -e '.meta.provisioned' "$proof/dashboard.json" > /dev/null
grafana_api "http://$grafana/api/dashboards/uid/plow-codex-trace" > "$proof/detail.json"
jq -e '.meta.provisioned and any(.dashboard.panels[]; .id == 1 and .type == "traces")' \
  "$proof/detail.json" > /dev/null
from=$(( (now - 60) * 1000 ))
to=$(( (now + 5) * 1000 ))
search_request() {
  jq -e --arg from "$1" --arg to "$2" --arg label "$3" '
    (.dashboard.templating.list[] | select(.name == "spanStatus") |
      .query | split(", ")[] | split(" : ") | select(.[0] == $label) | .[1]) as $criterion |
    {from:$from,to:$to,queries:[.dashboard.panels[] | select(.id==1) | .targets[0] |
      .query |= (split("${spanStatus:raw}") | join($criterion))]}
  ' "$proof/dashboard.json"
}
exact_request() {
  jq -e --arg trace "$1" '
    {from:"0",to:"0",queries:[.dashboard.panels[] | select(.id==1) | .targets[0] |
      select(.queryType == "traceql" and .query == "${traceId:raw}") |
      .query = $trace | .queryType = "traceId"]} | select(.queries | length == 1)
  ' "$proof/detail.json"
}
query() {
  curl -sS --max-time 10 -H @"$proof/viewer-header" \
    -H 'Content-Type: application/json' --data-binary @"$proof/$1-query.json" \
    "http://$grafana/api/ds/query" > "$proof/$1.json"
}
account=$(grafana_api -H 'Content-Type: application/json' \
  --data '{"name":"tempo-fixture","role":"Viewer"}' "http://$grafana/api/serviceaccounts" | jq -er .id)
grafana_api -H 'Content-Type: application/json' \
  --data '{"name":"verification","secondsToLive":300}' "http://$grafana/api/serviceaccounts/$account/tokens" |
  jq -er .key > "$proof/mcp-token"
printf 'Authorization: Bearer %s\n' "$(cat "$proof/mcp-token")" > "$proof/viewer-header"

grafana_api "http://$grafana/api/datasources/uid/plow-tempo" |
  jq -e '.jsonData.traceQuery.timeShiftEnabled == false' > /dev/null

unset_id=55555555555555555555555555555555
fixture "$unset_id"
jq '.resourceSpans[0].scopeSpans[0].spans |= (.[0:1] | map(del(.status)))' \
  "$proof/fixture-$unset_id.json" > "$proof/unset-payload.json"
mv "$proof/unset-payload.json" "$proof/fixture-$unset_id.json"
[[ $(post "$unset_id" "$source_token") == 200 ]]
search_request "$from" "$to" Error > "$proof/search-query.json"
search_request "$from" "$to" 'Any status' > "$proof/any-query.json"
for ((attempt=0; attempt<30; attempt++)); do
  if query any && jq -e --arg a "$trace_id" --arg b "$unset_id" \
    '.results.A.status == 200 and (.results.A.frames[0].data.values[0] | sort) == [$a, $b]' \
    "$proof/any.json" > /dev/null; then
    break
  fi
  sleep 1
done
(( attempt < 30 ))
search_request "$from" "$to" OK > "$proof/ok-query.json"
search_request "$from" "$to" Unset > "$proof/unset-query.json"
search_request "$((from - 3600000))" "$((to - 3600000))" 'Any status' > "$proof/empty-query.json"
curl -fsS --max-time 10 "http://$tempo/api/traces/$trace_id" > "$proof/tempo.json"
exact_request "$trace_id" > "$proof/exact-query.json"
exact_request ffffffffffffffffffffffffffffffff > "$proof/missing-query.json"
for label in search ok unset empty exact missing; do query "$label"; done

node verify/tempo-mcp.ts "http://$grafana" "$proof"

historical_id=66666666666666666666666666666666
hour_ns=3600000000000
(
  start_ns=$((start_ns - hour_ns))
  end_ns=$((end_ns - hour_ns))
  child_ns=$((child_ns - hour_ns))
  child_end_ns=$((child_end_ns - hour_ns))
  fixture "$historical_id"
)
[[ $(post "$historical_id" "$source_token") == 200 ]]
[[ $(post "$historical_id" "$source_token") == 200 ]]
legacy_proof "$historical_id" > "$proof/legacy-replay.json"
for ((attempt=0; attempt<30; attempt++)); do
  if curl -fsS --max-time 10 "http://$tempo/api/v2/traces/$historical_id" > "$proof/tempo-replay.json" &&
    jq -e --arg start "$((start_ns - hour_ns))" --arg end "$((end_ns - hour_ns))" '
      [.trace.resourceSpans[].scopeSpans[].spans[]] | sort_by(.spanId) |
      length == 2 and .[0].startTimeUnixNano == $start and .[0].endTimeUnixNano == $end
      and .[1].parentSpanId == .[0].spanId and .[1].traceId == .[0].traceId
    ' "$proof/tempo-replay.json" > /dev/null; then
    break
  fi
  sleep 1
done
(( attempt < 30 ))
exact_request "$historical_id" > "$proof/exact-replay-query.json"
query exact-replay
jq -e '.results.A.status == 200 and (.results.A.frames[0].data.values[0] | length == 2)' \
  "$proof/exact-replay.json" > /dev/null

for ((attempt=0; attempt<30; attempt++)); do
  if curl -fsSG --max-time 10 --data-urlencode \
    'query=otelcol_receiver_accepted_spans_total{job="plow-collection-alloy",receiver=~".*codex_live",transport="http"}' \
    "http://$mimir/prometheus/api/v1/query" > "$proof/alloy-receipts.json" &&
    jq -e 'any(.data.result[]; .value[1] | tonumber >= 7)' "$proof/alloy-receipts.json" > /dev/null; then
    break
  fi
  sleep 1
done
(( attempt < 30 ))

compose stop tempo
for label in any exact; do
  cp "$proof/$label-query.json" "$proof/$label-outage-query.json"
  query "$label-outage"
  jq -e '.results.A | .status >= 400 and (.error | length > 0) and (.frames | length == 0)' \
    "$proof/$label-outage.json" > /dev/null
done

compose stop alloy
outage_id=44444444444444444444444444444444
fixture "$outage_id"
[[ $(post "$outage_id" "$source_token") == 200 ]]
legacy_proof "$outage_id" > "$proof/legacy-during-alloy-outage.json"
printf 'Verified Collector auth, both outputs, Alloy receipts, status filters, exact lookup, replay, empty and missing results, and a backend outage.\n'
