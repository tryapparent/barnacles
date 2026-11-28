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
)

const (
	pluginID     = "plow-agent-observability-datasource"
	runLimit     = 100
	eventLimit   = 2000
	maxQueries   = 8
	maxRange     = 7 * 24 * time.Hour
	queryTimeout = 12 * time.Second
	ioTimeout    = 4 * time.Second
)

var (
	identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	tenantID   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	minTime    = time.Unix(0, 0)
	maxTime    = time.Unix(0, 1<<63-2)
)

type datasource struct {
	loki   lokiClient
	policy string
}

func newDatasource(_ context.Context, settings backend.DataSourceInstanceSettings) (instancemgmt.Instance, error) {
	var config struct {
		LokiURL    string `json:"lokiUrl"`
		LokiTenant string `json:"lokiTenant"`
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
		policy: policy,
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
		RunID string `json:"runId"`
	}
	if len(query.JSON) > 8<<10 || json.Unmarshal(query.JSON, &model) != nil || !identifier.MatchString(model.RunID) {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Enter a valid run ID")
	}

	window := query.TimeRange
	if window.From.Before(minTime) || window.To.After(maxTime) || !window.To.After(window.From) || window.To.Sub(window.From) > maxRange {
		return backend.ErrDataResponse(backend.StatusBadRequest, "Select a valid time range of at most 7 days")
	}

	run, failure := ds.loki.readRun(ctx, window, model.RunID)
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

	output, failure := executePolicy(ctx, ds.policy, policyInput{Run: run, Events: events})
	if failure != nil {
		return *failure
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
