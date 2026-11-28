set -euo pipefail
umask 077

cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
legacy=$(realpath -- "${1:?Pass the verified legacy Collector release source directory}")
[[ -r "$legacy/collector/codex/otelcol.yaml" && -r "$legacy/collector/codex/otel.ts" ]]

export PLOW_LGTM_WORKDIR
PLOW_LGTM_WORKDIR=$(mktemp -d /tmp/apparent-dev-plow-codex-traces-XXXXXX)
job=${PLOW_LGTM_WORKDIR##*-}
project=plow-traces-${job,,}
compose() { docker compose -p "$project" "$@"; }
cleanup() {
  local status=$?
  if (( status != 0 )); then compose logs > "$PLOW_LGTM_WORKDIR/compose.log" 2>&1 || true; fi
  docker rm -f "$project-collector" > /dev/null 2>&1 || true
  if [[ -n ${receiver_pid:-} ]]; then kill "$receiver_pid" 2>/dev/null || true; fi
  rm -f "$PLOW_LGTM_WORKDIR"/{mcp-token,fixture.env,grafana-password}
  compose down --volumes > "$PLOW_LGTM_WORKDIR/cleanup.log" 2>&1
  printf 'Private proof outputs: %s\n' "$PLOW_LGTM_WORKDIR"
}
trap cleanup EXIT

mkdir "$PLOW_LGTM_WORKDIR/spool"
touch "$PLOW_LGTM_WORKDIR/spool/"{codex,t3}.jsonl
chmod 755 "$PLOW_LGTM_WORKDIR/spool"
chmod 644 "$PLOW_LGTM_WORKDIR/spool/"{codex,t3}.jsonl
openssl rand -hex 24 > "$PLOW_LGTM_WORKDIR/grafana-password"
chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"
compose up -d --wait --wait-timeout 90

grafana=$(compose port grafana 3000)
alloy=$(compose port alloy 4318)
tempo=$(compose port tempo 3200)
[[ $grafana == 127.0.0.1:* && $alloy == 127.0.0.1:* && $tempo == 127.0.0.1:* ]]
db="$PLOW_LGTM_WORKDIR/evidence.sqlite"
source_token=$(openssl rand -hex 24)
evidence_token=$(openssl rand -hex 24)
PLOW_OTLP_EVIDENCE_PORT=0 PLOW_OTLP_EVIDENCE_TOKEN=$evidence_token \
  node "$legacy/collector/codex/otel.ts" "$PLOW_LGTM_WORKDIR" trace-fixture \
  > "$PLOW_LGTM_WORKDIR/legacy.log" 2>&1 &
receiver_pid=$!
for ((attempt=0; attempt<30; attempt++)); do
  evidence_port=$(sed -n 's/^Codex OTLP evidence ready on 127\.0\.0\.1:\([0-9]*\)$/\1/p' "$PLOW_LGTM_WORKDIR/legacy.log")
  [[ -z $evidence_port ]] || break
  kill -0 "$receiver_pid"
  sleep 1
done
[[ $evidence_port =~ ^[0-9]+$ ]]
collector_port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
printf '%s\n' "PLOW_CODEX_OTLP_PORT=$collector_port" "PLOW_CODEX_OTLP_TOKEN=$source_token" \
  "PLOW_OTLP_EVIDENCE_PORT=$evidence_port" "PLOW_OTLP_EVIDENCE_TOKEN=$evidence_token" \
  "PLOW_TEMPO_ALLOY_PORT=${alloy##*:}" > "$PLOW_LGTM_WORKDIR/fixture.env"

image=otel/opentelemetry-collector-contrib:0.166.0@sha256:3e18fe04181de50bdd72e23ad4a4d6214b54351e63d496f1c58127cc4541ad7f
collector() {
  docker run "$@" --network host --env-file "$PLOW_LGTM_WORKDIR/fixture.env" \
    -v "$legacy/collector/codex/otelcol.yaml:/etc/plow.yaml:ro" \
    -v "$PWD/collect/alloy/codex-collector-fanout.yaml:/etc/plow-fanout.yaml:ro" \
    "$image" "${collector_cmd[@]}" --config=/etc/plow.yaml --config=/etc/plow-fanout.yaml
}
collector_cmd=(validate)
collector --rm
collector_cmd=()
collector -d --name "$project-collector" > /dev/null

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
  ' > "$PLOW_LGTM_WORKDIR/fixture-$1.json"
}
fixture "$trace_id"

endpoint="http://127.0.0.1:$collector_port/v1/traces"
post() {
  curl -sS --retry 5 --retry-connrefused --max-time 10 -o "$PLOW_LGTM_WORKDIR/collector-receipt.json" \
    -w '%{http_code}' -H "Authorization: Bearer $2" -H 'Content-Type: application/json' \
    --data-binary "@$PLOW_LGTM_WORKDIR/fixture-$1.json" "$endpoint"
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
legacy_proof "$trace_id" > "$PLOW_LGTM_WORKDIR/legacy.json"
jq -e --arg start "$start_ns" --arg end "$end_ns" --arg observed "$child_end_ns" '
  .spans[0].start_ns == $start and .spans[0].end_ns == $end
  and .spans[0].status_code == 1 and .spans[1].status_code == 2
  and .spans[1].call_id == "call_fixture"
  and .event.event == "codex.tool_result" and .event.success == 0 and .event.observed_ns == $observed
' "$PLOW_LGTM_WORKDIR/legacy.json" > /dev/null

grafana_api() {
  curl -fsS --max-time 10 --user "admin:$(cat "$PLOW_LGTM_WORKDIR/grafana-password")" "$@"
}
grafana_api "http://$grafana/api/dashboards/uid/plow-codex-traces" > "$PLOW_LGTM_WORKDIR/dashboard.json"
jq -e '.meta.provisioned' "$PLOW_LGTM_WORKDIR/dashboard.json" > /dev/null
grafana_api "http://$grafana/api/dashboards/uid/plow-codex-trace" > "$PLOW_LGTM_WORKDIR/detail.json"
jq -e '.meta.provisioned and any(.dashboard.panels[]; .id == 1 and .type == "traces")' \
  "$PLOW_LGTM_WORKDIR/detail.json" > /dev/null
from=$(( (now - 60) * 1000 ))
to=$(( (now + 5) * 1000 ))
query() {
  local file="$PLOW_LGTM_WORKDIR/$1-query.json" dashboard="$PLOW_LGTM_WORKDIR/dashboard.json"
  if [[ -n $3 ]]; then dashboard="$PLOW_LGTM_WORKDIR/detail.json"; fi
  jq --arg from "$from" --arg to "$to" --arg criterion "$2" --arg trace "$3" '
    {from:$from,to:$to,queries:[(.dashboard.panels[] | select(.id==1) | .targets[0] |
      if $trace == "" then .query |= (split("${spanStatus:raw}") | join($criterion))
      else .query=$trace | .queryType="traceId" end)]}
  ' "$dashboard" > "$file"
  grafana_api -H 'Content-Type: application/json' --data-binary "@$file" "http://$grafana/api/ds/query"
}
for ((attempt=0; attempt<30; attempt++)); do
  if query search 'span:status = error' '' > "$PLOW_LGTM_WORKDIR/search.json" &&
    jq -e --arg id "$trace_id" 'any(.results.A.frames[].data.values[0][]; . == $id)' "$PLOW_LGTM_WORKDIR/search.json" > /dev/null; then
    break
  fi
  sleep 1
done
(( attempt < 30 ))
curl -fsS --max-time 10 "http://$tempo/api/traces/$trace_id" > "$PLOW_LGTM_WORKDIR/tempo.json"
jq -e --arg start "$start_ns" --arg end "$end_ns" --arg childStart "$child_ns" --arg childEnd "$child_end_ns" '
  [.batches[].scopeSpans[].spans[]] | sort_by(.startTimeUnixNano) | length == 2
  and .[0].startTimeUnixNano == $start and .[0].endTimeUnixNano == $end
  and .[1].startTimeUnixNano == $childStart and .[1].endTimeUnixNano == $childEnd
  and .[1].parentSpanId == .[0].spanId and .[1].traceId == .[0].traceId
  and any(.[1].events[]; .name == "codex.tool_result" and .timeUnixNano == $childEnd)
' "$PLOW_LGTM_WORKDIR/tempo.json" > /dev/null
query exact '' "$trace_id" > "$PLOW_LGTM_WORKDIR/exact.json"
jq -e --arg trace "$trace_id" '
  .results.A.status == 200 and
  (.results.A.frames[0] |
    [.schema.fields[].name] as $fields |
    ([range(0; $fields | length) as $i | {key:$fields[$i], value:.data.values[$i]}] | from_entries) |
    .spanID as $spans |
    ($spans | index("3333333333333333")) as $child |
    .traceID == [$trace, $trace] and ($spans | sort) == ["2222222222222222", "3333333333333333"]
    and .parentSpanID[$child] == "2222222222222222" and .operationName[$child] == "exec_command"
    and .statusCode[$child] == 2 and .instrumentationLibraryName == ["plow.codex","plow.codex"])
' "$PLOW_LGTM_WORKDIR/exact.json" > /dev/null || {
  printf 'Grafana exact lookup lost spans. Check the Alloy resource marker in grafana/traces.md.\n' >&2
  exit 1
}
if rg -qF "$canary" "$PLOW_LGTM_WORKDIR"/{legacy,tempo,search,exact}.json; then
  printf 'Private canary reached a stored or queried output.\n' >&2
  exit 1
fi

account=$(grafana_api -H 'Content-Type: application/json' \
  --data '{"name":"tempo-fixture","role":"Viewer"}' "http://$grafana/api/serviceaccounts" | jq -er .id)
grafana_api -H 'Content-Type: application/json' \
  --data '{"name":"verification","secondsToLive":300}' "http://$grafana/api/serviceaccounts/$account/tokens" |
  jq -er .key > "$PLOW_LGTM_WORKDIR/mcp-token"
node verify/tempo-mcp.ts "http://$grafana" "$PLOW_LGTM_WORKDIR"

compose stop alloy
outage_id=44444444444444444444444444444444
fixture "$outage_id"
[[ $(post "$outage_id" "$source_token") == 200 ]]
legacy_proof "$outage_id" > "$PLOW_LGTM_WORKDIR/legacy-during-alloy-outage.json"
printf 'Verified Collector auth, both outputs, legacy writes during Alloy outage, Grafana search and exact trace.\n'
