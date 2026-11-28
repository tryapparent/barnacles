package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	grafanads "github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

const (
	pluginID              = "plow-agent-observability-datasource"
	runLimit              = 100
	eventLimit            = 2000
	maxQueries            = 8
	maxRange              = 7 * 24 * time.Hour
	queryTimeout          = 12 * time.Second
	ioTimeout             = 4 * time.Second
	activityCacheTTL      = 5 * time.Second
	activityPolicyTimeout = 8 * time.Second
)

var (
	identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	historyID  = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9:_-]|%[0-9A-Fa-f]{2})*$`)
	tenantID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	minTime    = time.Unix(0, 0)
	maxTime    = time.Unix(0, 1<<63-2)
)

type datasource struct {
	loki          lokiClient
	tempo         *url.URL
	policy        string
	activityCache activityCache
}

func newDatasource(_ context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	var config struct {
		LokiURL    string `json:"lokiUrl"`
		LokiTenant string `json:"lokiTenant"`
		TempoURL   string `json:"tempoUrl"`
	}
	if err := json.Unmarshal(settings.JSONData, &config); err != nil {
		return nil, errors.New("Invalid Plow datasource settings")
	}

	endpoint, err := url.Parse(config.LokiURL)
	if err != nil || (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Hostname() == "" ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" {
		return nil, errors.New("Configure lokiUrl as an HTTP or HTTPS base URL")
	}
	if !tenantID.MatchString(config.LokiTenant) {
		return nil, errors.New("Configure lokiTenant as a single tenant ID")
	}
	var tempo *url.URL
	if config.TempoURL != "" {
		tempo, err = url.Parse(config.TempoURL)
		if err != nil || (tempo.Scheme != "http" && tempo.Scheme != "https") || tempo.Hostname() == "" ||
			tempo.User != nil || tempo.RawQuery != "" || tempo.ForceQuery || tempo.Fragment != "" {
			return nil, errors.New("Configure tempoUrl as an HTTP or HTTPS base URL")
		}
		tempo = tempo.JoinPath("api", "search")
	}
	token := settings.DecryptedSecureJSONData["lokiBearerToken"]
	if len(token) > 4096 || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("Invalid Loki bearer token setting")
	}
	policy := os.Getenv("PLOW_POLICY_COMMAND")
	if !filepath.IsAbs(policy) {
		return nil, errors.New("Set PLOW_POLICY_COMMAND to an absolute executable path")
	}

	return &datasource{
		loki: lokiClient{
			endpoint: endpoint.JoinPath("loki", "api", "v1", "query_range"),
			tenant:   config.LokiTenant,
			token:    token,
			http: &http.Client{
				Timeout: ioTimeout,
				CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
					return http.ErrUseLastResponse
				},
			},
		},
		tempo:         tempo,
		policy:        policy,
		activityCache: activityCache{gate: make(chan struct{}, 1)},
	}, nil
}

func (ds *datasource) QueryData(ctx context.Context, req *backend.QueryDataRequest) (*backend.QueryDataResponse, error) {
	if len(req.Queries) > maxQueries {
		return nil, errors.New("Plow accepts at most 8 queries per request")
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	response := backend.NewQueryDataResponse()
	for _, query := range req.Queries {
		response.Responses[query.RefID] = ds.query(ctx, query)
	}
	return response, nil
}

func (ds *datasource) query(ctx context.Context, query backend.DataQuery) backend.DataResponse {
	var model struct {
		RunID        string `json:"runId"`
		History      string `json:"history"`
		Trace        bool   `json:"trace"`
		ActivityView string `json:"activityView"`
		Range        string `json:"range"`
		Operation    string `json:"operation"`
	}
	if len(query.JSON) > 8<<10 || json.Unmarshal(query.JSON, &model) != nil {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Invalid Plow query")
	}
	validID := identifier.MatchString(model.RunID)
	if model.History == "1" {
		validID = len(model.RunID) <= 512 && historyID.MatchString(model.RunID)
	}
	if model.ActivityView == "" && !validID {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Enter a valid run ID")
	}

	window := query.TimeRange
	if window.From.Before(minTime) || window.To.After(maxTime) || !window.To.After(window.From) || window.To.Sub(window.From) > maxRange {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Select a valid time range of at most 7 days")
	}

	if model.ActivityView != "" {
		return ds.activity(ctx, window.To, model.ActivityView, model.Range, model.Operation)
	}
	if model.Trace {
		return ds.runTrace(ctx, window, model.RunID, model.History == "1")
	}

	var run runRecord
	var failure *backend.DataResponse
	history := model.History == "1"
	if history {
		var gap string
		run, gap, failure = ds.readHistoryRun(ctx, window, model.RunID, "lookup")
		if gap != "" {
			return renderUnavailable(model.RunID, gap)
		}
	} else {
		run, failure = ds.loki.readRun(ctx, window, model.RunID)
	}
	if failure != nil {
		return *failure
	}
	events, gaps, failure := ds.loki.readEvents(ctx, window, run.SessionID)
	if failure != nil {
		return *failure
	}
	if time.UnixMilli(*run.StartedMS).Before(window.From) || time.UnixMilli(*run.CompletedMS).After(window.To) {
		gaps = append(gaps, "Selected time range excludes part of the run")
	}

	output, failure := executePolicy(ctx, ds.policy, policyInput{Run: run, Events: events, History: history})
	if failure != nil {
		return *failure
	}
	if gap := historyGap(output.Coverage.Gap); gap != "" {
		gaps = append(gaps, gap)
	}
	return render(output, gaps)
}

func (ds *datasource) CheckHealth(ctx context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	info, err := os.Stat(ds.policy)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "Configured policy executable is unavailable"}, nil
	}
	now := time.Now()
	_, _, failure := ds.loki.read(ctx, backend.TimeRange{From: now.Add(-time.Minute), To: now}, t3Selector, "t3", 1)
	if failure != nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: failure.Error.Error()}, nil
	}
	return &backend.CheckHealthResult{Status: backend.HealthStatusOk, Message: "Loki is reachable and the policy executable exists"}, nil
}

func main() {
	if err := grafanads.Manage(pluginID, newDatasource, grafanads.ManageOpts{}); err != nil {
		log.Fatal(err)
	}
}

type activityKey struct {
	cutoff    time.Time
	period    string
	operation string
}

type activityCache struct {
	gate    chan struct{}
	key     activityKey
	expires time.Time
	report  activityOutput
	failure *backend.DataResponse
}

func (ds *datasource) activity(ctx context.Context, cutoff time.Time, view, period, operation string) backend.DataResponse {
	if period != "24h" && period != "7d" || len(operation) > 128 {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Select Last 24h or Last 7 days")
	}
	switch view {
	case "breakdown", "share", "timeline", "ci", "runs", "coverage", "findings":
	default:
		return backend.ErrDataResponse(backend.StatusBadRequest, "Unknown Activity view")
	}

	report, failure := ds.activityReport(ctx, activityKey{cutoff.UTC(), period, operation})
	if failure != nil {
		return *failure
	}
	frames := renderActivity(report, view)
	if report.Partial {
		for _, frame := range frames {
			frame.Meta = &data.FrameMeta{Notices: []data.Notice{
				{Severity: data.NoticeSeverityWarning, Text: "Partial Loki read. Activity may omit evidence."},
			}}
		}
	}
	return backend.DataResponse{Frames: frames}
}

func (ds *datasource) activityReport(ctx context.Context, key activityKey) (activityOutput, *backend.DataResponse) {
	cache := &ds.activityCache
	select {
	case cache.gate <- struct{}{}:
		defer func() { <-cache.gate }()
	case <-ctx.Done():
		return activityOutput{}, lokiTransportFailure(ctx.Err())
	}
	if key == cache.key && time.Now().Before(cache.expires) {
		return cache.report, cache.failure
	}
	report, failure := ds.loadActivityReport(ctx, key)
	if ctx.Err() == nil {
		cache.key, cache.report, cache.failure = key, report, failure
		cache.expires = time.Now().Add(activityCacheTTL)
	}
	return report, failure
}

func (ds *datasource) loadActivityReport(ctx context.Context, key activityKey) (activityOutput, *backend.DataResponse) {
	records, partial, failure := ds.loki.readActivity(ctx, key.cutoff)
	if failure != nil {
		return activityOutput{}, failure
	}
	raw, failure := runPolicyWithin(ctx, ds.policy, map[string]any{
		"to": key.cutoff.UnixMilli(), "view": "activity", "range": key.period, "operation": key.operation,
		"records": records, "partial": partial,
	}, activityPolicyTimeout)
	if failure != nil {
		return activityOutput{}, failure
	}
	var report activityOutput
	if json.Unmarshal(raw, &report) != nil || report.From == 0 {
		return activityOutput{}, policyFailure(backend.StatusInternal, "Policy executable returned an invalid Activity result")
	}
	return report, nil
}
