package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
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
		assertQueryFrames(t, policyPath, false)
	})
	t.Run("compiled Bend2 policy", func(t *testing.T) {
		policyPath := os.Getenv("PLOW_TEST_POLICY_COMMAND")
		if policyPath == "" {
			t.Skip("set PLOW_TEST_POLICY_COMMAND to the absolute path of the Bend2 CLI wrapper")
		}
		assertQueryFrames(t, policyPath, true)
	})
}

func assertQueryFrames(t *testing.T, policyPath string, replay bool) {
	t.Helper()
	ds := newFixtureDatasource(t, policyPath, func(w http.ResponseWriter, r *http.Request) {
		checkRequest(t, r)
		switch r.URL.Query().Get("query") {
		case `{plow_source="t3"} | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_run" | plow_run_id="fixture-run"`:
			if r.URL.Query().Get("limit") != "100" {
				t.Error("run lookup did not use configured cap")
			}
			lokiReply(t, w, "t3", []string{fixtureRun, fixtureRun}, nil)
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

	result := queryFixture(t, ds)
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
		*'"partial":true'*) printf '%s' '{"from":1,"partial":true}';;
		*) printf '%s' '{"from":1}';;
	esac`)
	ds := newFixtureDatasource(t, policy, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("X-Scope-OrgID") != "fixture-tenant" {
			t.Error("wrong tenant")
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
	if result := query(cutoff, "coverage"); result.Error != nil || requests.Load() != int64(len(activityReads(cutoff))) {
		t.Fatalf("matching views repeated source work: %d requests, %v", requests.Load(), result.Error)
	}
	warned.Store(true)
	partial := query(cutoff.Add(time.Second), "coverage")
	if partial.Error != nil || partial.Frames[0].Meta == nil {
		t.Fatalf("missing partial-read notice: %v", partial)
	}
	status.Store(http.StatusGatewayTimeout)
	assertFailure(t, query(cutoff.Add(2*time.Second), "coverage"), backend.StatusTimeout, "Loki query timed out")
}
