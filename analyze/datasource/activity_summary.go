package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

const (
	activitySummarySource = "activity_summary"
	summaryEntryLimit     = 12
	summaryLineBytes      = 128 << 10
	summaryLookback       = 24 * time.Hour
)

type activitySummaryMeta struct {
	Version     int    `json:"version"`
	Period      string `json:"period"`
	CutoffMS    int64  `json:"cutoffMs"`
	PublishedMS int64  `json:"publishedMs"`
	Revision    string `json:"revision"`
	WatermarkMS int64  `json:"watermarkMs"`
}

type activitySnapshot struct {
	activitySummaryMeta
	Report activityOutput `json:"report"`
}

type activitySummaryResult struct {
	snapshot activitySnapshot
	status   string
	partial  bool
}

type activitySummaryCache struct {
	cutoff  time.Time
	expires time.Time
	result  activitySummaryResult
}

type activitySummaries struct {
	loki  lokiClient
	gate  chan struct{}
	cache map[string]activitySummaryCache
}

func (ds *datasource) activitySummary(ctx context.Context, cutoff time.Time, view, period string) backend.DataResponse {
	summaries := ds.summaries
	cutoff = cutoff.UTC().Truncate(time.Minute)
	select {
	case summaries.gate <- struct{}{}:
		defer func() { <-summaries.gate }()
	case <-ctx.Done():
		return *lokiTransportFailure(ctx.Err())
	}
	now := time.Now()
	cached := summaries.cache[period]
	if cached.cutoff.Equal(cutoff) && now.Before(cached.expires) {
		return cached.result.render(view)
	}
	result, failure := summaries.load(ctx, ds.policy, now, cutoff, period)
	if failure != nil {
		return *failure
	}
	summaries.cache[period] = activitySummaryCache{cutoff, time.Now().Add(activityCacheTTL), result}
	return result.render(view)
}

func (s *activitySummaries) load(ctx context.Context, policy string, now, cutoff time.Time, period string) (activitySummaryResult, *backend.DataResponse) {
	selector := `{plow_source="activity_summary",period="` + period + `"}`
	page, failure := s.loki.readPage(ctx, backend.TimeRange{From: now.Add(-summaryLookback), To: now}, selector, activitySummarySource, summaryEntryLimit, true)
	if failure != nil {
		return activitySummaryResult{}, failure
	}
	if page.oversized {
		return activitySummaryResult{}, lokiFailure(backend.StatusBadGateway, "Activity summary response exceeded 4 MiB. Refresh to retry.")
	}
	snapshots := make([]activitySnapshot, 0, len(page.lines))
	metadata := make([]activitySummaryMeta, 0, len(page.lines))
	partial := page.warned
	for i, line := range page.lines {
		snapshot, ok := decodeActivitySnapshot(line, page.clocks[i])
		if !ok {
			partial = true
			continue
		}
		snapshots = append(snapshots, snapshot)
		metadata = append(metadata, snapshot.activitySummaryMeta)
	}
	raw, failure := runPolicy(ctx, policy, map[string]any{
		"view": "activity_summary", "range": period, "to": cutoff.UnixMilli(),
		"snapshots": metadata, "partial": partial,
	})
	if failure != nil {
		return activitySummaryResult{}, failure
	}
	var selection struct {
		Index   int
		Status  string
		Partial bool
	}
	if json.Unmarshal(raw, &selection) != nil || selection.Status == "" || selection.Index < 0 || selection.Index > len(snapshots) {
		return activitySummaryResult{}, policyFailure(backend.StatusInternal, "Policy executable returned an invalid Activity summary selection")
	}
	result := activitySummaryResult{status: selection.Status, partial: selection.Partial}
	if selection.Index > 0 {
		result.snapshot = snapshots[selection.Index-1]
	}
	return result, nil
}

func decodeActivitySnapshot(line string, ns int64) (activitySnapshot, bool) {
	var snapshot activitySnapshot
	if len(line) > summaryLineBytes || json.Unmarshal([]byte(line), &snapshot) != nil ||
		snapshot.PublishedMS != ns/int64(time.Millisecond) {
		return activitySnapshot{}, false
	}
	report := snapshot.Report
	if report.Totals == nil || report.Categories == nil || report.Buckets == nil || report.Findings == nil {
		return activitySnapshot{}, false
	}
	if len(snapshot.Revision) != 64 {
		return activitySnapshot{}, false
	}
	if _, err := hex.DecodeString(snapshot.Revision); err != nil {
		return activitySnapshot{}, false
	}
	snapshot.Revision = strings.ToLower(snapshot.Revision)
	snapshot.WatermarkMS = report.Cutoff
	return snapshot, true
}

func (result activitySummaryResult) render(view string) backend.DataResponse {
	snapshot := result.snapshot
	report := snapshot.Report
	frames := renderActivity(report, view)
	available := snapshot.Revision != ""
	status := result.status
	if !available {
		status += ". Refresh to retry."
	}
	if result.partial || report.Partial {
		status += " · Partial"
	}
	if view == "coverage" {
		frame := frames[0]
		if available {
			frame.InsertRow(0, "Published", "Snapshot publication", timeField(snapshot.PublishedMS), nil, nil, nil)
			frame.InsertRow(0, "Summary input", status, timeField(snapshot.CutoffMS), nil, nil, nil)
		} else {
			frame.Clear()
			frame.AppendRow("Summary", status, nil, nil, nil, nil)
		}
	}
	for _, frame := range frames {
		frame.Meta = &data.FrameMeta{Custom: map[string]any{
			"status": result.status, "partial": result.partial || report.Partial,
			"summaryCutoff": timeField(snapshot.CutoffMS), "published": timeField(snapshot.PublishedMS),
			"watermark": timeField(report.Cutoff), "revision": snapshot.Revision,
		}}
		if status != "Fresh" {
			frame.Meta.Notices = []data.Notice{{Severity: data.NoticeSeverityWarning, Text: status}}
		}
	}
	return backend.DataResponse{Frames: frames}
}

const (
	refreshTenant       = "plow-activity"
	refreshTimeout      = 2 * time.Minute
	refreshPolicyBudget = 90 * time.Second
)

var buildMode string

type summaryContent struct {
	Period   string          `json:"period"`
	CutoffMS int64           `json:"cutoffMs"`
	Report   json.RawMessage `json:"report"`
}

type summaryEnvelope struct {
	summaryContent
	Version     int    `json:"version"`
	PublishedMS int64  `json:"publishedMs"`
	Revision    string `json:"revision"`
}

func refreshLokiClient(prefix, api, tenant string) (lokiClient, error) {
	base, err := url.Parse(os.Getenv(prefix + "_URL"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Hostname() == "" ||
		base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" {
		return lokiClient{}, fmt.Errorf("set %s_URL to an HTTP or HTTPS Loki base URL", prefix)
	}
	token := os.Getenv(prefix + "_TOKEN")
	if len(token) > 4096 || strings.ContainsAny(token, "\r\n") {
		return lokiClient{}, fmt.Errorf("invalid %s_TOKEN", prefix)
	}
	return lokiClient{
		endpoint: base.JoinPath("loki", "api", "v1", api),
		tenant:   tenant,
		token:    token,
		http: &http.Client{
			Timeout: ioTimeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func runActivityRefresh(args []string) error {
	observed := time.Now().UTC()
	flags := flag.NewFlagSet("plow-activity-refresh", flag.ContinueOnError)
	cutoffMS := flags.Int64("cutoff-ms", observed.Truncate(time.Minute).UnixMilli(), "UTC minute boundary in Unix milliseconds")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	cutoff := time.UnixMilli(*cutoffMS).UTC()
	if flags.NArg() != 0 || *cutoffMS%time.Minute.Milliseconds() != 0 ||
		!cutoff.After(minTime.Add(maxRange+activityDay)) || cutoff.After(observed) {
		return errors.New("expected a supported UTC minute cutoff at or before the refresh start")
	}
	sourceTenant := os.Getenv("PLOW_ACTIVITY_SOURCE_TENANT")
	if !tenantID.MatchString(sourceTenant) || sourceTenant == refreshTenant {
		return errors.New("set PLOW_ACTIVITY_SOURCE_TENANT to a raw evidence tenant")
	}
	policy := os.Getenv("PLOW_POLICY_COMMAND")
	if !filepath.IsAbs(policy) {
		return errors.New("set PLOW_POLICY_COMMAND to an absolute executable path")
	}
	source, err := refreshLokiClient("PLOW_ACTIVITY_SOURCE", "query_range", sourceTenant)
	if err != nil {
		return err
	}
	sink, err := refreshLokiClient("PLOW_ACTIVITY_SINK", "push", refreshTenant)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), refreshTimeout)
	defer cancel()
	return refreshActivity(ctx, source, sink, policy, cutoff, observed)
}

func refreshActivity(ctx context.Context, source, sink lokiClient, policy string, cutoff, observed time.Time) error {
	query, failure := activityOperationQuery(ctx, policy, observed)
	if failure != nil {
		return failure.Error
	}
	records, gaps, failure := source.readActivity(ctx, cutoff, query)
	if failure != nil {
		return failure.Error
	}
	raw, failure := runPolicyWithin(ctx, policy, map[string]any{
		"view": "summaries", "to": cutoff.UnixMilli(), "observedMs": observed.UnixMilli(),
		"records": records, "partial": len(gaps) != 0,
	}, refreshPolicyBudget)
	if failure != nil {
		return failure.Error
	}
	var summaries struct {
		Day  json.RawMessage
		Week json.RawMessage
	}
	if err := json.Unmarshal(raw, &summaries); err != nil {
		return errors.New("policy executable returned invalid Activity summaries")
	}
	var failures []error
	for _, content := range []summaryContent{
		{"24h", cutoff.UnixMilli(), summaries.Day},
		{"7d", cutoff.UnixMilli(), summaries.Week},
	} {
		if err := pushSummary(ctx, sink, content, time.Now()); err != nil {
			failures = append(failures, fmt.Errorf("refresh %s: %w", content.Period, err))
		}
	}
	return errors.Join(failures...)
}

func pushSummary(ctx context.Context, sink lokiClient, content summaryContent, published time.Time) error {
	var overview map[string]json.RawMessage
	var report activityOutput
	if json.Unmarshal(content.Report, &overview) != nil || len(overview) != 14 ||
		json.Unmarshal(content.Report, &report) != nil || report.From == 0 ||
		report.Totals == nil || report.Categories == nil || report.Buckets == nil || report.Findings == nil {
		return errors.New("policy executable returned an invalid Activity overview")
	}
	for _, key := range []string{"from", "cutoff", "oldest", "t3Coverage", "codexCoverage", "ciCoverage",
		"outcomeCoverage", "partial", "unknownRuns", "conflicts", "totals", "categories", "buckets", "findings"} {
		if _, ok := overview[key]; !ok {
			return errors.New("policy executable returned an invalid Activity overview")
		}
	}

	stable, err := json.Marshal(content)
	if err != nil {
		return errors.New("could not encode Activity summary content")
	}
	digest := sha256.Sum256(stable)
	line, err := json.Marshal(summaryEnvelope{
		summaryContent: content,
		Version:        1,
		PublishedMS:    published.UnixMilli(),
		Revision:       hex.EncodeToString(digest[:]),
	})
	if err != nil {
		return errors.New("could not encode Activity summary envelope")
	}
	if len(line) > summaryLineBytes {
		return errors.New("Activity summary envelope exceeds 128 KiB")
	}

	type stream struct {
		Labels map[string]string `json:"stream"`
		Values [][2]string       `json:"values"`
	}
	payload := map[string][]stream{"streams": {{
		Labels: map[string]string{"plow_source": activitySummarySource, "period": content.Period},
		Values: [][2]string{{strconv.FormatInt(published.UnixNano(), 10), string(line)}},
	}}}
	body, err := json.Marshal(payload)
	if err != nil {
		return errors.New("could not encode Loki push request")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, sink.endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return errors.New("could not build Loki push request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Scope-OrgID", sink.tenant)
	if sink.token != "" {
		request.Header.Set("Authorization", "Bearer "+sink.token)
	}
	response, err := sink.http.Do(request)
	if err != nil {
		return lokiTransportFailure(err).Error
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("Loki push returned HTTP %d", response.StatusCode)
	}
	return nil
}
