package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

const fixtureRun = `{"kind":"t3_run","run":{"id":"fixture-run","threadId":"fixture-thread","sessionId":"fixture-session","startedMs":1000,"completedMs":7000},"prompt":"private fixture field"}`

var fixtureEvents = []string{
	`{"kind":"function_call","eventId":"e1","sessionId":"fixture-session","callId":"paired-call","timestampMs":2000,"arguments":"private fixture field"}`,
	`{"kind":"function_call_output","eventId":"e2","sessionId":"fixture-session","callId":"paired-call","timestampMs":4000}`,
	`{"kind":"function_call","eventId":"e3","sessionId":"fixture-session","callId":"unknown-call","timestampMs":5000}`,
}

const fixturePolicyOutput = `{"runId":"fixture-run","intervals":[{"callId":"paired-call","kind":"function_call","startMs":2000,"endMs":4000,"durationMs":2000},{"callId":"unknown-call","kind":"function_call","startMs":5000,"endMs":null,"durationMs":null}],"findings":[{"callId":"unknown-call","reason":"missing_end"}],"coverage":{"events":3,"paired":1,"unknown":1}}`

func TestQueryDataFramesAndReplay(t *testing.T) {
	t.Run("wire contract", func(t *testing.T) {
		policyPath := writePolicy(t, "input=$(cat)\ncase \"$input\" in *'private fixture field'*) exit 7;; esac\nprintf '%s' '"+fixturePolicyOutput+"'")
		assertQueryFrames(t, policyPath, false, false)
	})
	t.Run("compiled Bend2 policy", func(t *testing.T) {
		policyPath := os.Getenv("PLOW_TEST_POLICY_COMMAND")
		if policyPath == "" {
			t.Skip("set PLOW_TEST_POLICY_COMMAND to the absolute path of the Bend2 CLI wrapper")
		}
		assertQueryFrames(t, policyPath, true, false)
		assertQueryFrames(t, policyPath, true, true)
	})
}

func assertQueryFrames(t *testing.T, policyPath string, replay, history bool) {
	t.Helper()
	ds := newFixtureDatasource(t, policyPath, func(w http.ResponseWriter, r *http.Request) {
		checkRequest(t, r)
		switch r.URL.Query().Get("query") {
		case `{plow_source="t3"} | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_run" | plow_run_id="fixture-run"`:
			if history || r.URL.Query().Get("limit") != "100" {
				t.Error("run lookup did not use configured cap")
			}
			lokiReply(t, w, "t3", []string{fixtureRun, fixtureRun}, nil)
		case `{plow_source="t3_history"} | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_activity_run" | plow_run_id="fixture-run"`:
			if !history || r.URL.Query().Get("limit") != "2000" {
				t.Error("history lookup did not use configured cap")
			}
			terminal := `{"kind":"t3_activity_run","eventId":"history-fixture","revisionMs":7000,"run":{"id":"fixture-run","threadId":"fixture-thread","sessionId":"fixture-session","status":"completed","startedMs":1000,"completedMs":7000}}`
			prior := `{"kind":"t3_activity_run","eventId":"history-fixture","revisionMs":1000,"run":{"id":"fixture-run","threadId":"fixture-thread","status":"running","startedMs":1000}}`
			lokiReply(t, w, "t3_history", []string{prior, terminal, terminal}, nil)
		case `{plow_source="codex_history"} | json plow_session_id="sessionId" | plow_session_id="fixture-session"`:
			if r.URL.Query().Get("limit") != "2000" {
				t.Error("event lookup did not use configured cap")
			}
			events := append([]string{}, fixtureEvents...)
			if replay {
				events = append(events, fixtureEvents...)
			}
			lokiReply(t, w, "codex_history", events, nil)
		default:
			t.Errorf("unexpected LogQL: %s", r.URL.Query().Get("query"))
			w.WriteHeader(http.StatusBadRequest)
		}
	})

	query := fixtureQuery()
	if history {
		query.JSON = json.RawMessage(`{"runId":"fixture-run","history":"1"}`)
	}
	response, err := ds.QueryData(context.Background(), &backend.QueryDataRequest{Queries: []backend.DataQuery{query}})
	if err != nil {
		t.Fatal(err)
	}
	result := response.Responses["A"]
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	if len(result.Frames) != 3 {
		t.Fatalf("got %d frames", len(result.Frames))
	}
	intervals, findings, coverage := result.Frames[0], result.Frames[1], result.Frames[2]
	if intervals.Name != "intervals" || intervals.Rows() != 2 ||
		findings.Name != "findings" || findings.Rows() != 1 || coverage.Name != "coverage" || coverage.Rows() != 1 {
		t.Fatalf("unexpected frames: %v", result.Frames)
	}
	assertCell(t, intervals, 0, 0, "paired-call")
	assertCell(t, intervals, 4, 0, int64Ptr(2000))
	assertCell(t, intervals, 3, 1, (*int64)(nil))
	assertCell(t, intervals, 4, 1, (*int64)(nil))
	assertCell(t, findings, 0, 0, "unknown-call")
	assertCell(t, findings, 1, 0, "missing_end")
	assertCell(t, coverage, 0, 0, "fixture-run")
	assertCell(t, coverage, 1, 0, int64(3))
	assertCell(t, coverage, 2, 0, int64(1))
	assertCell(t, coverage, 3, 0, int64(1))
	assertCell(t, coverage, 4, 0, true)
}

func TestSourceIncomplete(t *testing.T) {
	ds := newFixtureDatasource(t, writePolicy(t, "cat >/dev/null\nprintf '%s' '"+fixturePolicyOutput+"'"), func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Query().Get("query"), t3Selector) {
			lokiReply(t, w, "t3", []string{strings.Replace(fixtureRun, "7000", "9000", 1)}, nil)
			return
		}
		events := make([]string, eventLimit)
		for i := range events {
			events[i] = fixtureEvents[i%len(fixtureEvents)]
		}
		events[0] = `{"sessionId":"fixture-session"}`
		lokiReply(t, w, "codex_history", events, []string{"private fixture warning"})
	})
	result := queryFixture(t, ds)
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	coverage := result.Frames[2]
	assertCell(t, coverage, 4, 0, false)
	assertCell(t, coverage, 5, 0, "Loki entry limit reached. Narrow the time range. Loki returned query warnings. Loki returned malformed session events. Selected time range excludes part of the run")
	if len(coverage.Meta.Notices) != 1 || coverage.Meta.Notices[0].Severity != data.NoticeSeverityWarning {
		t.Fatalf("expected a warning on partial source coverage")
	}
}

func TestLokiFailures(t *testing.T) {
	tests := []struct {
		name   string
		reply  func(http.ResponseWriter, *http.Request)
		status backend.Status
		want   string
	}{
		{"denied", func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "private fixture field", http.StatusUnauthorized)
		}, backend.StatusForbidden, "denied access"},
		{"redirect", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/redirect", http.StatusFound)
		}, backend.StatusBadGateway, "HTTP 302"},
		{"bad envelope", func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, `{"status":"success","data":{"resultType":"streams","result":null}}`)
		}, backend.StatusBadGateway, "invalid stream response"},
		{"body cap", func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, strings.Repeat("x", maxResponseBytes+1))
		}, backend.StatusBadGateway, "exceeded 4 MiB"},
		{"not found", func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, `{"status":"success","data":{"resultType":"streams","result":[]}}`)
		}, backend.StatusNotFound, "was not found"},
		{"conflicting run", func(w http.ResponseWriter, _ *http.Request) {
			lokiReply(t, w, "t3", []string{fixtureRun, strings.Replace(fixtureRun, "fixture-session", "other-session", 1)}, nil)
		}, backend.Status(http.StatusConflict), "conflicting records"},
		{"uncertain run", func(w http.ResponseWriter, _ *http.Request) {
			lokiReply(t, w, "t3", []string{fixtureRun}, []string{"private fixture warning"})
		}, backend.StatusBadGateway, "lookup is incomplete"},
		{"unsafe session identifier", func(w http.ResponseWriter, _ *http.Request) {
			lokiReply(t, w, "t3", []string{strings.Replace(fixtureRun, "fixture-session", `fixture\" |~ \"unsafe`, 1)}, nil)
		}, backend.StatusBadGateway, "malformed run record"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := queryFixture(t, newFixtureDatasource(t, "/unreachable", tc.reply))
			assertFailure(t, result, tc.status, tc.want)
			if result.ErrorSource != backend.ErrorSourceDownstream || strings.Contains(result.Error.Error(), "private fixture") {
				t.Fatalf("unexpected error source or content: %v", result.Error)
			}
		})
	}
}

func TestInputBounds(t *testing.T) {
	ds := newFixtureDatasource(t, "/unreachable", func(w http.ResponseWriter, _ *http.Request) {
		t.Error("invalid request reached Loki")
		w.WriteHeader(http.StatusBadRequest)
	})
	query := fixtureQuery()
	query.JSON = json.RawMessage(`{"runId":"injected\" |~ \"expression"}`)
	assertFailure(t, ds.query(context.Background(), query), backend.StatusBadRequest, "valid run ID")

	query = fixtureQuery()
	query.TimeRange.To = query.TimeRange.From.Add(maxRange + time.Second)
	assertFailure(t, ds.query(context.Background(), query), backend.StatusBadRequest, "valid time range")
	if _, err := ds.QueryData(context.Background(), &backend.QueryDataRequest{Queries: make([]backend.DataQuery, maxQueries+1)}); err == nil {
		t.Fatal("oversized query batch was accepted")
	}
}

func TestPolicyFailures(t *testing.T) {
	tests := []struct {
		name   string
		script string
		want   string
	}{
		{"nonzero exit", "echo 'private fixture field' >&2; exit 2", "executable failed"},
		{"bad output", "printf '%s' '{\"runId\":\"fixture-run\"}'", "invalid result"},
		{"output cap", "head -c 4194305 /dev/zero", "output exceeded 4 MiB"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, failure := executePolicy(context.Background(), writePolicy(t, tc.script), policyInput{Run: runRecord{ID: "fixture-run"}})
			if failure == nil {
				t.Fatal("bad policy invocation succeeded")
			}
			assertFailure(t, *failure, backend.StatusInternal, tc.want)
			if strings.Contains(failure.Error.Error(), "private fixture") {
				t.Fatalf("unexpected error content: %v", failure.Error)
			}
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	_, failure := executePolicy(ctx, writePolicy(t, "exec sleep 10"), policyInput{})
	if failure == nil {
		t.Fatal("policy invocation ignored timeout")
	}
	assertFailure(t, *failure, backend.StatusTimeout, "timed out")
}

func TestLokiTimeout(t *testing.T) {
	ds := newFixtureDatasource(t, "/unreachable", func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	assertFailure(t, ds.query(ctx, fixtureQuery()), backend.StatusTimeout, "Loki query timed out")
}

func checkRequest(t *testing.T, r *http.Request) {
	t.Helper()
	params := r.URL.Query()
	if r.Method != http.MethodGet || r.URL.Path != "/proxy/loki/api/v1/query_range" ||
		r.Header.Get("X-Scope-OrgID") != "fixture-tenant" || r.Header.Get("Authorization") != "Bearer synthetic-token" ||
		params.Get("start") != "1000000000" || params.Get("end") != "8000000001" || params.Get("direction") != "forward" {
		t.Errorf("Loki request did not use the required endpoint, tenant, and time bounds: %s", r.URL)
	}
}

func lokiReply(t *testing.T, w http.ResponseWriter, source string, lines []string, warnings []string) {
	t.Helper()
	values := make([][2]string, 0, len(lines))
	for i, line := range lines {
		values = append(values, [2]string{strconv.Itoa(1000000000 + i), line})
	}
	w.Header().Set("Content-Type", "application/json")
	err := json.NewEncoder(w).Encode(map[string]any{
		"status": "success", "warnings": warnings,
		"data": map[string]any{"resultType": "streams", "result": []any{
			map[string]any{"stream": map[string]string{"plow_source": source}, "values": values},
		}},
	})
	if err != nil {
		t.Error(err)
	}
}

func newFixtureDatasource(t *testing.T, policyPath string, handler http.HandlerFunc) *datasource {
	t.Helper()
	t.Setenv("PLOW_POLICY_COMMAND", policyPath)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	settings, err := json.Marshal(map[string]string{"lokiUrl": server.URL + "/proxy", "lokiTenant": "fixture-tenant"})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := newDatasource(context.Background(), backend.DataSourceInstanceSettings{
		JSONData: settings, DecryptedSecureJSONData: map[string]string{"lokiBearerToken": "synthetic-token"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return instance.(*datasource)
}

func fixtureQuery() backend.DataQuery {
	return backend.DataQuery{
		RefID: "A", JSON: json.RawMessage(`{"runId":"fixture-run"}`),
		TimeRange: backend.TimeRange{From: time.UnixMilli(1000), To: time.UnixMilli(8000)},
	}
}

func queryFixture(t *testing.T, ds *datasource) backend.DataResponse {
	t.Helper()
	response, err := ds.QueryData(context.Background(), &backend.QueryDataRequest{Queries: []backend.DataQuery{fixtureQuery()}})
	if err != nil {
		t.Fatal(err)
	}
	return response.Responses["A"]
}

func writePolicy(t *testing.T, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "policy")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path
}

func assertFailure(t *testing.T, result backend.DataResponse, status backend.Status, text string) {
	t.Helper()
	if result.Status != status || result.Error == nil || !strings.Contains(result.Error.Error(), text) || len(result.Frames) != 0 {
		t.Fatalf("got status %d and error %v, want status %d and error containing %q", result.Status, result.Error, status, text)
	}
}

func assertCell(t *testing.T, frame *data.Frame, field, row int, want any) {
	t.Helper()
	if value := frame.Fields[field].At(row); !reflect.DeepEqual(value, want) {
		t.Fatalf("%s.%s row %d = %v, want %v", frame.Name, frame.Fields[field].Name, row, value, want)
	}
}

func int64Ptr(value int64) *int64 {
	return &value
}

func TestActivityReadContracts(t *testing.T) {
	cutoff := time.UnixMilli(1800000000000)
	var requests atomic.Int64
	var status atomic.Int64
	var warned atomic.Bool
	policy := writePolicy(t, `case "$(cat)" in
		*'"view":"operationQuery"'*) printf '%s' '" | fixture_operation_projection"';;
		*'"partial":true'*) printf '%s' '{"from":1,"partial":true}';;
		*) printf '%s' '{"from":1}';;
	esac`)
	ds := newFixtureDatasource(t, policy, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("X-Scope-OrgID") != "fixture-tenant" {
			t.Error("wrong tenant")
		}
		expr := r.URL.Query().Get("query")
		if strings.Contains(expr, "fixture_operation_projection") != strings.Contains(expr, "confirmed_delay") {
			t.Error("operation projection applied outside Activity data slices")
		}
		if code := status.Load(); code != 0 {
			w.WriteHeader(int(code))
			return
		}
		warning := ""
		if warned.Load() {
			warning = `,"warnings":["fixture warning"]`
		}
		io.WriteString(w, `{"status":"success","data":{"resultType":"streams","result":[]}`+warning+`}`)
	})
	query := func(end time.Time, view string) backend.DataResponse {
		return ds.activity(context.Background(), end, view, "24h", "all")
	}
	if result := query(cutoff, "timeline"); result.Error != nil || len(result.Frames) != 0 {
		t.Fatalf("empty timeline: %v", result)
	}
	if result := query(cutoff, "coverage"); result.Error != nil || requests.Load() != int64(len(activityReads(cutoff, ""))) {
		t.Fatalf("matching views repeated source work: %d requests, %v", requests.Load(), result.Error)
	}
	warned.Store(true)
	partial := query(cutoff.Add(time.Second), "coverage")
	if partial.Error != nil || partial.Frames[0].Meta == nil {
		t.Fatalf("missing partial-read notice: %v", partial)
	}
	var notices []string
	for _, notice := range partial.Frames[0].Meta.Notices {
		notices = append(notices, notice.Text)
	}
	if !strings.Contains(strings.Join(notices, " "), "Loki warned about T3 history.") ||
		strings.Contains(strings.Join(notices, " "), "fixture warning") {
		t.Fatalf("expected a source-specific notice with sanitized text, got %v", notices)
	}
	status.Store(http.StatusGatewayTimeout)
	assertFailure(t, query(cutoff.Add(2*time.Second), "coverage"), backend.StatusTimeout, "Loki query timed out")
}

func TestActivityReportsSliceAndSnapshotLimits(t *testing.T) {
	cutoff := time.UnixMilli(1800000000000).UTC()
	source := "t3_history"
	policy := writePolicy(t, `case "$(cat)" in
		*'"view":"operationQuery"'*) printf '%s' '" | fixture_operation_projection"';;
		*) printf '%s' '{"from":1,"partial":true}';;
	esac`)
	ds := newFixtureDatasource(t, policy, func(w http.ResponseWriter, r *http.Request) {
		params := r.URL.Query()
		var values [][2]string
		if strings.Contains(params.Get("query"), "t3_activity_run") {
			start, _ := strconv.ParseInt(params.Get("start"), 10, 64)
			end, _ := strconv.ParseInt(params.Get("end"), 10, 64)
			limit, _ := strconv.Atoi(params.Get("limit"))
			for clock := cutoff.Add(-8 * activityDay); clock.Before(cutoff); clock = clock.Add(3 * time.Hour) {
				if clock.UnixNano() < start || clock.UnixNano() >= end {
					continue
				}
				rows := 1000
				if clock.Equal(cutoff.Add(-3 * time.Hour)) {
					rows = limit
				}
				for i := 0; i < rows && len(values) < limit; i++ {
					values = append(values, [2]string{strconv.FormatInt(clock.UnixNano(), 10), "{}"})
				}
			}
		}
		if len(values) == 0 {
			io.WriteString(w, `{"status":"success","data":{"resultType":"streams","result":[]}}`)
			return
		}
		stream := map[string]any{"stream": map[string]string{"plow_source": source}, "values": values}
		json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{
			"resultType": "streams", "result": []any{stream},
		}})
	})
	result := ds.activity(context.Background(), cutoff, "coverage", "7d", "all")
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	if result.Frames[0].Meta == nil {
		t.Fatal("missing Activity read notices")
	}
	want := []data.Notice{{Severity: data.NoticeSeverityWarning, Inspect: data.InspectTypeData,
		Text: "A T3 history query still hit Loki’s entry limit after splitting. The Activity row limit omitted T3 history slices."}}
	got := result.Frames[0].Meta.Notices
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Activity notices = %v, want %v", got, want)
	}
}

func TestActivityContinuationKeepsTimestampTies(t *testing.T) {
	from := time.UnixMilli(1800000000000)
	tie := from.Add(time.Minute).UnixNano()
	var requests atomic.Int64
	ds := newFixtureDatasource(t, "/bin/false", func(w http.ResponseWriter, r *http.Request) {
		var values [][2]string
		switch requests.Add(1) {
		case 1:
			for i := 0; i < activityPageLimit-1; i++ {
				values = append(values, [2]string{strconv.FormatInt(from.UnixNano(), 10), "prefix"})
			}
			values = append(values, [2]string{strconv.FormatInt(tie, 10), "tie-a"})
		case 2:
			if got := r.URL.Query().Get("start"); got != strconv.FormatInt(tie, 10) {
				t.Errorf("continuation start = %s, want %d", got, tie)
			}
			values = append(values, [2]string{strconv.FormatInt(tie, 10), "tie-a"},
				[2]string{strconv.FormatInt(tie, 10), "tie-b"})
		default:
			t.Error("unexpected extra request")
		}
		stream := map[string]any{"stream": map[string]string{"plow_source": "t3_history"}, "values": values}
		json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{
			"resultType": "streams", "result": []any{stream},
		}})
	})
	pages := 2
	read := activityRead{window: backend.TimeRange{From: from, To: from.Add(time.Hour)}, source: "t3_history"}
	got := ds.loki.readActivityShard(context.Background(), read, 0, activityShardBytes, &pages)
	if got.failure != nil || got.gaps != 0 || len(got.lines) != activityPageLimit+1 {
		t.Fatalf("continuation returned %d rows with gaps %v and error %v", len(got.lines), got.gaps, got.failure)
	}
	if tail := got.lines[len(got.lines)-2:]; !reflect.DeepEqual(tail, []string{"tie-a", "tie-b"}) {
		t.Fatalf("continuation ties = %v", tail)
	}
}

func TestActivityContinuationKeepsPrefixAfterReadDeadline(t *testing.T) {
	var requests atomic.Int64
	ds := newFixtureDatasource(t, "/bin/false", func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 2 {
			<-r.Context().Done()
			return
		}
		values := make([][2]string, activityPageLimit)
		for i := range values {
			values[i] = [2]string{"1000000000", "prefix"}
		}
		values[len(values)-1] = [2]string{"2000000000", "unresolved-boundary"}
		stream := map[string]any{"stream": map[string]string{"plow_source": "t3_history"}, "values": values}
		json.NewEncoder(w).Encode(map[string]any{"status": "success", "data": map[string]any{
			"resultType": "streams", "result": []any{stream},
		}})
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	pages := 2
	read := activityRead{window: fixtureQuery().TimeRange, source: "t3_history"}
	got := ds.loki.readActivityShard(ctx, read, 0, activityShardBytes, &pages)
	if requests.Load() != 2 || got.failure != nil || got.gaps != activityReadDeadline || len(got.lines) != activityPageLimit-1 {
		t.Fatalf("deadline returned %d rows with gaps %v and error %v after %d requests", len(got.lines), got.gaps, got.failure, requests.Load())
	}

}

func TestActivitySummaryWire(t *testing.T) {
	t.Setenv("PLOW_ACTIVITY_SUMMARIES", "1")
	policy := writePolicy(t, `case "$(cat)" in
		*'"revision":"ababab'*) printf '%s' '{"index":1,"status":"Stale","partial":false}';;
		*) exit 2;;
	esac`)
	cutoff := time.Now().UTC().Truncate(time.Minute).Add(-time.Minute)
	var reads atomic.Int64
	var fail atomic.Bool
	ds := newFixtureDatasource(t, policy, func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		if r.Method != "GET" || r.Header.Get("X-Scope-OrgID") != "plow-activity" ||
			r.Header.Get("Authorization") != "Bearer synthetic-token" || r.URL.Path != "/proxy/loki/api/v1/query_range" ||
			r.URL.Query().Get("query") != `{plow_source="activity_summary",period="24h"}` ||
			r.URL.Query().Get("direction") != "backward" || r.URL.Query().Get("limit") != strconv.Itoa(summaryEntryLimit) {
			t.Error("Overview used an unexpected source request")
		}
		if fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		summary := summaryFixture(cutoff, cutoff, cutoff.Add(-time.Hour), "ab")
		writeSummaryFixture(t, w, summaryEntry{cutoff.Add(time.Microsecond), summary})
	})
	for _, view := range []string{"breakdown", "share", "findings", "coverage"} {
		result := ds.activity(context.Background(), cutoff.Add(5*time.Second), view, "24h", "all")
		if result.Error != nil || len(result.Frames) == 0 || len(result.Frames[0].Meta.Notices) == 0 {
			t.Fatalf("%s: expected frames with stale notice: %+v", view, result)
		}
		switch view {
		case "share":
			assertCell(t, result.Frames[0], 1, 0, (*float64)(nil))
		case "findings":
			assertCell(t, result.Frames[0], 3, 0, (*int64)(nil))
		case "coverage":
			assertCell(t, result.Frames[0], 1, 0, "Stale · Partial")
			assertCell(t, result.Frames[0], 2, 0, &cutoff)
			assertCell(t, result.Frames[0], 2, 2, timeField(cutoff.Add(-time.Hour).UnixMilli()))
		}
	}
	if reads.Load() != 1 {
		t.Fatalf("matching Overview panels used %d Loki requests", reads.Load())
	}
	fail.Store(true)
	assertFailure(t, ds.activity(context.Background(), cutoff.Add(time.Minute), "coverage", "24h", "all"), backend.StatusBadGateway, "Loki returned HTTP 503")
	if reads.Load() != 2 {
		t.Fatalf("failed Overview query retried another source: %d requests", reads.Load())
	}
}

func TestCompiledActivitySummarySelection(t *testing.T) {
	policy := os.Getenv("PLOW_TEST_POLICY_COMMAND")
	if policy == "" {
		t.Skip("set PLOW_TEST_POLICY_COMMAND to exercise the compiled Activity policy")
	}
	cutoff := time.Now().UTC().Truncate(time.Minute).Add(-2 * time.Minute)
	published := cutoff.Add(10 * time.Second)
	corrected := published.Add(time.Minute)
	ds := newFixtureDatasource(t, policy, func(w http.ResponseWriter, _ *http.Request) {
		future := corrected.Add(time.Second)
		writeSummaryFixture(t, w,
			summaryEntry{future, summaryFixture(cutoff.Add(time.Minute), future, cutoff, "cd")},
			summaryEntry{corrected, summaryFixture(cutoff, corrected, cutoff, "ef")},
			summaryEntry{published, summaryFixture(cutoff, published, cutoff.Add(-time.Hour), "ab")})
	})
	ds.summaries = &activitySummaries{loki: ds.loki, gate: make(chan struct{}, 1), cache: make(map[string]activitySummaryCache)}
	result := ds.activity(context.Background(), cutoff, "coverage", "24h", "all")
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	custom := result.Frames[0].Meta.Custom.(map[string]any)
	if custom["revision"] != strings.Repeat("ef", 32) || custom["status"] != "Fresh" {
		t.Fatalf("expected corrected same-cutoff snapshot, got %v", custom)
	}
	result = ds.activity(context.Background(), cutoff.Add(-time.Minute), "coverage", "24h", "all")
	if result.Error != nil {
		t.Fatal(result.Error)
	}
	assertCell(t, result.Frames[0], 1, 0, "Snapshot missing. Refresh to retry.")
}

func summaryFixture(cutoff, published, watermark time.Time, revision string) string {
	return fmt.Sprintf(`{"version":1,"period":"24h","cutoffMs":%d,"publishedMs":%d,"revision":%q,"report":{
		"cutoff":%d,"t3Coverage":"fixture","codexCoverage":"fixture","ciCoverage":"fixture","outcomeCoverage":"fixture",
		"partial":true,"categories":[],"totals":[],"buckets":[{"time":%d,"share":null}],
		"findings":[{"kind":"Fixture","occurrences":1,"measured":0,"ms":null}],"padding":%q}}`,
		cutoff.UnixMilli(), published.UnixMilli(), strings.Repeat(revision, 32), watermark.UnixMilli(), watermark.UnixMilli(), strings.Repeat("a", 17<<10))
}

type summaryEntry struct {
	published time.Time
	line      string
}

func writeSummaryFixture(t *testing.T, w http.ResponseWriter, entries ...summaryEntry) {
	t.Helper()
	values := make([][]string, 0, len(entries))
	for _, entry := range entries {
		values = append(values, []string{strconv.FormatInt(entry.published.UnixNano(), 10), entry.line})
	}
	stream := map[string]any{"stream": map[string]string{"plow_source": activitySummarySource, "period": "24h"}, "values": values}
	if err := json.NewEncoder(w).Encode(map[string]any{"status": "success",
		"data": map[string]any{"resultType": "streams", "result": []any{stream}}}); err != nil {
		t.Error(err)
	}
}

type retainedRow struct {
	at   int64
	kind string
	line string
}

func TestActivityRefresh(t *testing.T) {
	policy := os.Getenv("PLOW_TEST_POLICY_COMMAND")
	if policy == "" {
		t.Skip("set PLOW_TEST_POLICY_COMMAND to the compiled Bend2 CLI wrapper")
	}
	cutoff := time.Now().UTC().Truncate(time.Minute).Add(-2 * time.Minute)
	at := cutoff.UnixMilli()
	oldest := cutoff.Add(-7 * activityDay).UnixMilli()
	watermark := cutoff.Add(-time.Hour).UnixMilli()
	seen := at - 1
	retained := make(map[string][]retainedRow)
	add := func(source, kind string, stamp int64, fields string) {
		line := fmt.Sprintf(`{"kind":%q,"timestampMs":%d,%s}`, kind, stamp, fields)
		retained[source] = append(retained[source], retainedRow{stamp * int64(time.Millisecond), kind, line})
	}

	for lane := range 120 {
		start := at - int64(7+lane)*time.Hour.Milliseconds()
		thread := fmt.Sprintf("retained-thread-%03d", lane/2)
		end := start + 20_000
		add("t3_history", "t3_activity_run", end, fmt.Sprintf(
			`"eventId":"run-%d","revisionMs":%d,"observedMs":%d,"run":{"id":"run-%d","threadId":%q,"sessionId":"bound-%d","requestedMs":%d,"startedMs":%d,"completedMs":%d}`,
			lane, end, seen, lane, thread, lane, start-1_000, start, end))
		for operation := range 180 {
			clock := start + 100*int64(operation)
			add("t3_history", "operation", clock+180, fmt.Sprintf(
				`"eventId":"op-%d-%d","threadId":%q,"t3RunId":"run-%d","operation":"command_execution","startedMs":%d,"completedMs":%d,"observedMs":%d`,
				lane, operation, thread, lane, clock, clock+180, seen))
		}
	}
	add("t3_history", "t3_coverage", seen, fmt.Sprintf(
		`"eventId":"t3-checkpoint","status":"idle","cutoffMs":%d,"oldestSourceMs":%d,"observedMs":%d`, watermark, oldest, seen))
	add("codex_history", "codex_coverage", seen, `"eventId":"codex-checkpoint","status":"working"`)
	start := cutoff.Add(-3 * time.Hour).UnixMilli()
	add("t3_history", "t3_activity_run", start+60_000, fmt.Sprintf(
		`"eventId":"unknown-run","observedMs":%d,"run":{"id":"unknown-run","threadId":"missing-clock","requestedMs":%d,"startedMs":null,"completedMs":%d}`,
		seen, start, start+60_000))
	add("t3_history", "t3_pr_link", start, `"eventId":"pr-link","threadId":"retained-thread-000","repository":"sample/project","prNumber":"42"`)
	ci := fmt.Sprintf(`"repository":"sample/project","runId":4,"attempt":2,"headSha":%q,"observedMs":%d`, strings.Repeat("a", 40), seen)
	add("github_history", "github_actions_attempt", start, ci+fmt.Sprintf(
		`,"eventId":"attempt","prNumber":"42","createdMs":%d,"startedMs":%d,"completedMs":%d`, start-2000, start-1000, start))
	add("github_history", "github_actions_job", start, ci+fmt.Sprintf(
		`,"eventId":"job","jobId":5,"executionStartedMs":%d,"executionCompletedMs":%d,"conclusion":"failure"`, start-900, start))
	retained["github_history"] = append(retained["github_history"], retained["github_history"][1])

	late := retainedRow{start * int64(time.Millisecond), "confirmed_delay", fmt.Sprintf(
		`{"kind":"confirmed_delay","eventId":"late-delay","timestampMs":%d,"observedMs":%d,"startedMs":%d,"completedMs":%d}`,
		start, at+1, start-789, start)}
	var mode atomic.Int32
	var cappedPages atomic.Int32
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/read/loki/api/v1/query_range" ||
			r.Header.Get("X-Scope-OrgID") != "fixture" || r.Header.Get("Authorization") != "Bearer fixture-reader" {
			t.Errorf("unexpected source request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		stage := mode.Load()
		if stage == 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		params := r.URL.Query()
		query := params.Get("query")
		_, rest, _ := strings.Cut(query, `plow_source="`)
		source, _, _ := strings.Cut(rest, `"`)
		from, _ := strconv.ParseInt(params.Get("start"), 10, 64)
		end, _ := strconv.ParseInt(params.Get("end"), 10, 64)
		limit, _ := strconv.Atoi(params.Get("limit"))
		if end > cutoff.UnixNano()+1 || from < cutoff.Add(-8*activityDay).UnixNano() ||
			limit < 1 || limit > activityPageLimit || !strings.Contains(query, " | drop plow_kind") {
			t.Errorf("unexpected read bounds: %s", params.Encode())
		}
		rows := retained[source]
		if stage == 1 && source == "t3_history" {
			rows = append(slices.Clone(rows), late, late)
		}
		var matches []retainedRow
		for _, row := range rows {
			if row.at >= from && row.at < end && strings.Contains(query, row.kind) {
				matches = append(matches, row)
			}
		}
		sort.SliceStable(matches, func(i, j int) bool { return matches[i].at < matches[j].at })
		if params.Get("direction") == "backward" {
			slices.Reverse(matches)
		}
		if len(matches) >= limit {
			cappedPages.Add(1)
			matches = matches[:limit]
		}
		values := make([][2]string, 0, len(matches))
		for _, row := range matches {
			values = append(values, [2]string{strconv.FormatInt(row.at, 10), row.line})
		}
		reply := map[string]any{"status": "success", "data": map[string]any{
			"resultType": "streams", "result": []any{map[string]any{
				"stream": map[string]string{"plow_source": source}, "values": values,
			}},
		}}
		if stage == 2 && strings.Contains(query, "codex_coverage") {
			reply["warnings"] = []string{"synthetic bounded-read gap"}
		}
		if err := json.NewEncoder(w).Encode(reply); err != nil {
			t.Error(err)
		}
	}))
	defer source.Close()

	writes := make(chan summaryEnvelope, 16)
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/write/loki/api/v1/push" ||
			r.Header.Get("X-Scope-OrgID") != "plow-activity" || r.Header.Get("Authorization") != "Bearer fixture-writer" ||
			r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected sink request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var payload struct {
			Streams []struct {
				Stream map[string]string
				Values [][2]string
			}
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Streams) != 1 || len(payload.Streams[0].Values) != 1 {
			t.Errorf("invalid atomic push: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		stream := payload.Streams[0]
		value := stream.Values[0]
		var got summaryEnvelope
		publishedNS, clockErr := strconv.ParseInt(value[0], 10, 64)
		clock := time.Unix(0, publishedNS).UnixMilli()
		if err := json.Unmarshal([]byte(value[1]), &got); err != nil || clockErr != nil ||
			clock != got.PublishedMS || clock <= at || got.CutoffMS != at || got.Version != 1 || len(value[1]) > 128<<10 {
			t.Errorf("invalid summary envelope: %v", err)
		}
		stable, _ := json.Marshal(got.summaryContent)
		if got.Revision != fmt.Sprintf("%x", sha256.Sum256(stable)) ||
			!reflect.DeepEqual(stream.Stream, map[string]string{"plow_source": "activity_summary", "period": got.Period}) {
			t.Error("incorrect content hash or stream labels")
		}
		if mode.Load() == 4 && got.Period == "7d" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		t.Logf("published %s envelope, %d bytes", got.Period, len(value[1]))
		writes <- got
		w.WriteHeader(http.StatusNoContent)
	}))
	defer sink.Close()

	t.Setenv("PLOW_POLICY_COMMAND", policy)
	t.Setenv("PLOW_ACTIVITY_SOURCE_URL", source.URL+"/read")
	t.Setenv("PLOW_ACTIVITY_SOURCE_TOKEN", "fixture-reader")
	t.Setenv("PLOW_ACTIVITY_SOURCE_TENANT", "fixture")
	t.Setenv("PLOW_ACTIVITY_SINK_URL", sink.URL+"/write")
	t.Setenv("PLOW_ACTIVITY_SINK_TOKEN", "fixture-writer")
	refresh := func(stage int32, want int, failure string) map[string]summaryEnvelope {
		t.Helper()
		mode.Store(stage)
		args := []string{"--cutoff-ms", strconv.FormatInt(at, 10)}
		started := time.Now()
		var err error
		if binary := os.Getenv("PLOW_TEST_REFRESH_BINARY"); binary != "" {
			out, childErr := exec.Command(binary, args...).CombinedOutput()
			if childErr != nil {
				err = fmt.Errorf("%w: %s", childErr, out)
			}
		} else {
			err = runActivityRefresh(args)
		}
		if failure == "" && err != nil || failure != "" && (err == nil || !strings.Contains(err.Error(), failure)) {
			t.Fatalf("refresh stage %d, expected failure %q, got %v", stage, failure, err)
		}
		t.Logf("refresh stage %d took %s", stage, time.Since(started).Round(time.Millisecond))
		if len(writes) != want {
			t.Fatalf("expected %d accepted writes, got %d", want, len(writes))
		}
		results := make(map[string]summaryEnvelope, want)
		for range want {
			report := <-writes
			results[report.Period] = report
		}
		return results
	}

	initial := refresh(0, 2, "")
	reader, err := refreshLokiClient("PLOW_ACTIVITY_SOURCE", "query_range", "fixture")
	if err != nil {
		t.Fatal(err)
	}
	ds := &datasource{loki: reader, policy: policy}
	for _, period := range []string{"24h", "7d"} {
		started := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
		raw, failure := ds.loadActivityReport(ctx, activityKey{cutoff, period, "all"})
		cancel()
		if failure != nil {
			t.Fatal(failure.Error)
		}
		t.Logf("raw %s report took %s", period, time.Since(started).Round(time.Millisecond))
		if len(raw.Threads) == 0 || len(raw.Links) == 0 || len(raw.CI) != 2 ||
			raw.Cutoff != watermark || raw.Oldest != oldest || raw.UnknownRuns != 1 || raw.Partial ||
			!strings.Contains(string(initial[period].Report), `"share":null`) {
			t.Fatalf("insufficient fixture coverage for %s", period)
		}
		if !slices.ContainsFunc(raw.Findings, func(finding struct {
			Kind        string
			Occurrences int64
			Measured    int64
			MS          *int64
			Next        string
		}) bool {
			return finding.Kind == "CI failures" && finding.Occurrences == 1 && finding.MS != nil && *finding.MS == 900
		}) {
			t.Fatalf("missing exact deduplicated CI finding for %s", period)
		}
		var overview activityOutput
		if err := json.Unmarshal(initial[period].Report, &overview); err != nil {
			t.Fatal(err)
		}
		raw.Threads, raw.Links, raw.CI = nil, nil, nil
		if !reflect.DeepEqual(raw, overview) {
			t.Fatalf("summary differs from raw Activity overview for %s", period)
		}
	}
	if cappedPages.Load() == 0 {
		t.Fatal("fixture did not exercise bounded Loki page splitting")
	}

	revised := refresh(1, 2, "")
	replay := refresh(1, 2, "")
	partial := refresh(2, 2, "")
	refresh(3, 0, "Loki returned HTTP 503")
	refresh(4, 1, "refresh 7d: Loki push returned HTTP 503")
	t.Setenv("PLOW_POLICY_COMMAND", t.TempDir()+"/missing-policy")
	refresh(0, 0, "Policy executable failed")

	for _, period := range []string{"24h", "7d"} {
		next, again := revised[period], replay[period]
		if next.Revision == initial[period].Revision || next.Revision != again.Revision ||
			next.PublishedMS <= initial[period].PublishedMS || again.PublishedMS <= next.PublishedMS ||
			!strings.Contains(string(next.Report), `"ms":789`) || !reflect.DeepEqual(next.Report, again.Report) {
			t.Fatalf("late backfill or replay lost revision semantics for %s", period)
		}
		if !strings.Contains(string(partial[period].Report), `"partial":true`) ||
			!strings.Contains(string(partial[period].Report), `"t3Coverage":"idle"`) ||
			!strings.Contains(string(partial[period].Report), `"codexCoverage":"working"`) {
			t.Fatalf("partial result lost coverage for %s", period)
		}
	}
}

func TestActivityRefreshRejectsOversizedOrInvalidResult(t *testing.T) {
	report := `{"from":1,"cutoff":0,"oldest":0,"t3Coverage":"%s","codexCoverage":"","ciCoverage":"","outcomeCoverage":"","partial":false,"unknownRuns":0,"conflicts":0,"totals":[],"categories":[],"buckets":[],"findings":[]}`
	for _, tc := range []struct{ body, want string }{
		{"{}", "invalid Activity overview"},
		{fmt.Sprintf(report, strings.Repeat("x", 128<<10)), "exceeds 128 KiB"},
	} {
		err := pushSummary(context.Background(), lokiClient{}, summaryContent{"24h", 60_000, json.RawMessage(tc.body)}, time.Now())
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("expected %q, got %v", tc.want, err)
		}
	}
}
