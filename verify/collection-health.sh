set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
export PLOW_LGTM_WORKDIR
PLOW_LGTM_WORKDIR=$(mktemp -d /tmp/apparent-dev-plow-collection-health-XXXXXX)
printf 'Collection health evidence: %s\n' "$PLOW_LGTM_WORKDIR"
job=${PLOW_LGTM_WORKDIR##*-}
compose() {
  docker compose -p "plow-collection-health-${job,,}" -f infra/lgtm/compose.yaml -f "$PLOW_LGTM_WORKDIR/compose.yaml" "$@"
}
cleanup() {
  status=$?
  if (( status != 0 )); then compose logs > "$PLOW_LGTM_WORKDIR/compose.log" 2>&1 || true; fi
  rm -f "$PLOW_LGTM_WORKDIR/mcp/token"
  compose down --volumes > "$PLOW_LGTM_WORKDIR/cleanup.log" 2>&1
}
trap cleanup EXIT

mkdir -p "$PLOW_LGTM_WORKDIR/spool/health"
openssl rand -hex 24 > "$PLOW_LGTM_WORKDIR/grafana-password"
chmod 444 "$PLOW_LGTM_WORKDIR/grafana-password"
cat > "$PLOW_LGTM_WORKDIR/compose.yaml" <<YAML
services:
  grafana:
    environment:
      GOMAXPROCS: "2"
  loki:
    environment:
      GOMAXPROCS: "2"
  mimir:
    environment:
      GOMAXPROCS: "2"
  tempo:
    environment:
      GOMAXPROCS: "2"
  alloy:
    environment:
      GOMAXPROCS: "2"
YAML

compose config -q
compose build grafana-mcp
compose run --rm --no-deps alloy validate --stability.level=public-preview /etc/alloy/config.alloy
compose up -d --no-build --wait --wait-timeout 90
grafana=$(compose port grafana 3000)
loki=$(compose port loki 3100)
alloy=$(compose port alloy 4318)
[[ $grafana == 127.0.0.1:* && $loki == 127.0.0.1:* && $alloy == 127.0.0.1:* ]]
api() {
  curl -fsS --max-time 20 --netrc-file <(printf 'machine 127.0.0.1 login admin password %s\n' "$(cat "$PLOW_LGTM_WORKDIR/grafana-password")") \
    -H 'Content-Type: application/json' "http://$grafana/api/$1" "${@:2}"
}
await() {
  local check=$1 predicate=$2 output=$3
  for ((attempt=0; attempt<30; attempt++)); do
    if "$check" > "$output" && jq -e "$predicate" "$output" >/dev/null; then return; fi
    sleep 1
  done
  printf 'Fixture check failed. See %s\n' "$output" >&2
  return 1
}

api dashboards/uid/plow-collection-health > "$PLOW_LGTM_WORKDIR/dashboard.json"
jq -e '.meta.provisioned and .dashboard.title == "Collection Health"' "$PLOW_LGTM_WORKDIR/dashboard.json"
api datasources/uid/plow-collection-status > "$PLOW_LGTM_WORKDIR/datasource.json"
jq -e '.type == "loki" and .jsonData.httpHeaderName1 == "X-Scope-OrgID" and .secureJsonFields.httpHeaderValue1 and (.isDefault | not)' "$PLOW_LGTM_WORKDIR/datasource.json"
now=$(date +%s%3N)
from=$((now - 7200000))
to=$((now + 5000))
jq -c --arg from "$from" --arg to "$to" '
  {from:$from,to:$to,queries:[
    (.dashboard.panels[] | select(.id==3).targets[0] | .expr |= sub("\\$__range";"7205s")),
    (.dashboard.panels[] | select(.id==4).targets[0] | .refId="D" | .expr |= sub("\\$__range";"7205s")),
    (.dashboard.panels[] | select(.id==11).targets[0] | .refId="B"),
    (.dashboard.panels[] | select(.id==10).targets[0] | .refId="C" | .expr |= sub("\\$__interval";"1m") | .intervalMs=60000)
  ]}
' "$PLOW_LGTM_WORKDIR/dashboard.json" > "$PLOW_LGTM_WORKDIR/query.json"
query() { api ds/query --data-binary @"$PLOW_LGTM_WORKDIR/query.json"; }
query > "$PLOW_LGTM_WORKDIR/empty.json"
jq -e 'all(.results[]; .status==200 and all(.frames[]?; all(.data.values[]; length==0)))' "$PLOW_LGTM_WORKDIR/empty.json"

jq -nc --argjson t "$now" '
  def report($source;$lane;$status;$age;$last;$latest;$oldest;$scanned;$eligible;$ingested;$unit;$gap):
    {kind:"collector_health", schemaVersion:1, collector:$source, scope:"Pilot", lane:$lane, status:$status,
      observedMs:($t-$age),lastSuccessMs:$last,newestSourceMs:$latest,oldestScannedMs:$oldest,
      scannedUnits:$scanned,eligibleUnits:$eligible,ingestedRecords:$ingested,unit:$unit,gapCode:$gap};
  (report("github";"live";"idle";5400000;($t-5400500);($t-9000000);null;null;null;null;null;null) | del(.unit)),
  report("t3";"live";"working";90000;($t-95000);($t-120000);null;8;10;8;"thread";null),
  report("t3";"backfill";"working";85000;($t-86000);($t-130000);($t-70000000);95;100;60;"thread";null),
  report("github";"backfill";"retrying";80000;($t-9000000);($t-8000000);($t-970000000);3;null;14;"page";"rate_limited"),
  report("codex_history";"backfill";"complete";75000;($t-75500);($t-175000);($t-600000000);51;51;720;"session";"retention_limited"),
  (report("codex_history";"live";"retrying";65000;null;null;null;null;null;null;"session";null) | del(.lastSuccessMs,.scannedUnits,.ingestedRecords)),
  report("github";"backfill";"blocked";60000;($t-9000000);($t-8000000);($t-970000000);3;null;14;"page";"permission_denied"),
  (report("t3";"backfill";"working";50000;($t-51000);($t-125000);($t-80000000);99;100;75;"thread";null) + {scanProgress:"99.0%"}),
  report("t3";"live";"idle";2000;($t-2500);($t-120000);null;0;null;0;"thread";null)
' > "$PLOW_LGTM_WORKDIR/reports.jsonl"
jq -c '
  if .collector=="codex_history" and .lane=="live"
  then (.schemaVersion = {private:"INVALID_ENVELOPE"}), del(.observedMs), (.observedMs += 0.5),
    (.lastSuccessMs = {private:"INVALID_CLOCK"} | .scannedUnits = -1 | .ingestedRecords = 1.5)
  else . + {privateField:"HEALTH_PRIVATE_CANARY"}
  end
' "$PLOW_LGTM_WORKDIR/reports.jsonl" > "$PLOW_LGTM_WORKDIR/spool/health/.publish"
mv "$PLOW_LGTM_WORKDIR/spool/health/.publish" "$PLOW_LGTM_WORKDIR/spool/health/pilot-mixed.jsonl"

await query '(.results.A.frames | length)==6 and (.results.B.frames[0].data.values[2] | length)==9 and (.results.C.frames | length)>0' "$PLOW_LGTM_WORKDIR/health.json"
jq -e --slurpfile reports "$PLOW_LGTM_WORKDIR/reports.jsonl" '
  [.results.A.frames[] | .schema.fields[1].labels as $labels | .data.values[1][0] as $observed
    | $reports[] | select(.observedMs==$observed and .collector==$labels.collector and .scope==$labels.scope and .lane==$labels.lane)
    | . as $report | select(all(["status","lastSuccessMs","newestSourceMs","oldestScannedMs","scannedUnits","eligibleUnits","ingestedRecords","unit","gapCode"][];
      . as $key | ($labels[$key] // "") == (if $report[$key]!=null then ($report[$key]|tostring) elif $key=="gapCode" or $key=="unit" then "" else "Unknown" end)))]
  | sort_by(.observedMs) == ($reports | group_by([.collector,.scope,.lane]) | map(max_by(.observedMs)) | sort_by(.observedMs))
' "$PLOW_LGTM_WORKDIR/health.json"
jq -e --slurpfile reports "$PLOW_LGTM_WORKDIR/reports.jsonl" '
  .results.B.frames[0].data.values as $columns
  | ([$columns[2][] | fromjson] | sort_by(.observedMs)) == ($reports | sort_by(.observedMs))
    and all(range(0; $columns[1] | length); . as $index | $columns[1][$index] == ($columns[2][$index] | fromjson | .observedMs))
' "$PLOW_LGTM_WORKDIR/health.json"
jq -e '[.results.D.frames[].schema.fields[1].labels | .scanProgress // ""] | sort == ["","","","","","99.0%"]' "$PLOW_LGTM_WORKDIR/health.json"
curl -fsSG --max-time 15 -H 'X-Scope-OrgID: plow-fixture' \
  --data-urlencode 'query={plow_source="collector_health"}' \
  "http://$loki/loki/api/v1/query_range" > "$PLOW_LGTM_WORKDIR/raw-tenant.json"
jq -e '.data.result==[]' "$PLOW_LGTM_WORKDIR/raw-tenant.json"
jq -e '([.results.C.frames[].data.values[1][]] | add) == 3' "$PLOW_LGTM_WORKDIR/health.json"

mkdir -p "$PLOW_LGTM_WORKDIR/spool/github"
jq -nc --argjson now "$now" '
  {kind:"github_coverage",eventId:"fixture-github-clockless",repository:"fixture/repo",
   lane:"actions_retention",availability:"unknown",timestampMs:null,observedMs:$now}
' > "$PLOW_LGTM_WORKDIR/spool/github/clockless.jsonl"
clockless_loki() {
  curl -fsSG --max-time 6 -H 'X-Scope-OrgID: plow-fixture' \
    --data-urlencode 'query={plow_source="github_history"}' "http://$loki/loki/api/v1/query_range"
}
await clockless_loki 'any(.data.result[].values[][1] | fromjson; .eventId=="fixture-github-clockless"
  and has("timestampMs") and .timestampMs==null)' "$PLOW_LGTM_WORKDIR/github-clockless.json"

before=$(compose ps -q | sort)
compose up -d --no-build --wait --wait-timeout 90
[[ $(compose ps -q | sort) == "$before" ]]
compose up -d --no-deps --force-recreate --wait --wait-timeout 90 alloy
alloy=$(compose port alloy 4318)
[[ $alloy == 127.0.0.1:* ]]
tail -n 1 "$PLOW_LGTM_WORKDIR/spool/health/pilot-mixed.jsonl" >> "$PLOW_LGTM_WORKDIR/spool/health/pilot-mixed.jsonl"
received() {
  curl -fsS --max-time 5 "http://$loki/metrics" |
    awk '/^loki_distributor_lines_received_total\{format="otlp".*tenant="plow-collection-health"/ { print $NF }'
}
await received '. == 10' "$PLOW_LGTM_WORKDIR/received-count.json"
account=$(api serviceaccounts --data '{"name":"plow-health-mcp","role":"Viewer"}' | jq -er .id)
export PLOW_MCP_TOKEN_FILE="$PLOW_LGTM_WORKDIR/mcp/token"
mkdir -m 0700 "$(dirname "$PLOW_MCP_TOKEN_FILE")"
(umask 077; api "serviceaccounts/$account/tokens" --data '{"name":"verification","secondsToLive":300}' | jq -er .key > "$PLOW_MCP_TOKEN_FILE")
chmod 0444 "$PLOW_MCP_TOKEN_FILE"
query > "$PLOW_LGTM_WORKDIR/replay.json"
jq -S '[.results.A.frames[]] | map(del(.schema.meta.stats)) | sort_by(.data.values[1][0])' "$PLOW_LGTM_WORKDIR/health.json" > "$PLOW_LGTM_WORKDIR/snapshot.json"
jq -S '[.results.A.frames[]] | map(del(.schema.meta.stats)) | sort_by(.data.values[1][0])' "$PLOW_LGTM_WORKDIR/replay.json" | diff -u "$PLOW_LGTM_WORKDIR/snapshot.json" -
node verify/grafana-mcp.ts "$PLOW_LGTM_WORKDIR/query.json" "$PLOW_LGTM_WORKDIR/replay.json" \
  "$PLOW_LGTM_WORKDIR/mcp.json" --ignore-query-stats -p "plow-collection-health-${job,,}" \
  -f infra/lgtm/compose.yaml -f "$PLOW_LGTM_WORKDIR/compose.yaml"
rm "$PLOW_MCP_TOKEN_FILE"

send_span() {
  local trace_time
  trace_time=$(date +%s%N)
  jq -nc --arg time "$trace_time" --arg span "$1" '
  {resourceSpans:[{scopeSpans:[{spans:[{traceId:"11111111111111111111111111111111",
    spanId:$span,name:"codex.sampling",startTimeUnixNano:$time,endTimeUnixNano:$time}]}]}]}
' | curl -fsS --max-time 10 -H 'Content-Type: application/json' --data-binary @- "http://$alloy/v1/traces" > "$PLOW_LGTM_WORKDIR/trace-receipt-$1.json"
}

send_span 2222222222222222
metrics() {
  local end
  end=$(date +%s%3N)
  jq -c --arg from "$((end - 60000))" --arg to "$end" '
    {from:$from,to:$to,queries:[.dashboard.panels[] | select(.id>=5 and .id<=8) | .targets[0] | .refId=(.expr | capture("(?<metric>up|otelcol_[a-z_]+)\\{").metric)]}
  ' "$PLOW_LGTM_WORKDIR/dashboard.json" | api ds/query --data-binary @-
}
await metrics '
  all(.results[]; .status == 200)
  and .results.up.frames[0].data.values[1] == [1]
  and .results.otelcol_exporter_queue_size.frames[0].data.values[1] == [0]
  and .results.otelcol_receiver_accepted_spans_total.frames[0].data.values[1] == [1]
' "$PLOW_LGTM_WORKDIR/transport.json"

send_span 3333333333333333
receipt_rate() {
  local end
  end=$(date +%s%3N)
  jq -c --arg from "$((end - 60000))" --arg to "$end" '
    {from:$from,to:$to,queries:[.dashboard.panels[] | select(.id==12).targets[0] |
      .expr |= sub("\\$__rate_interval"; "1m") | .intervalMs=15000]}
  ' "$PLOW_LGTM_WORKDIR/dashboard.json" | api ds/query --data-binary @-
}
await receipt_rate '.results.A.status==200 and any(.results.A.frames[]?.data.values[1][]?; .>0)' "$PLOW_LGTM_WORKDIR/receipt-rate.json"

if (( $# > 0 )); then "$@" "$PLOW_LGTM_WORKDIR" "http://$grafana"; fi
printf 'Verified Collection Health snapshot, tenant isolation, history, replay, transport metrics, and Grafana MCP.\n'
