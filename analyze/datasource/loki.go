package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const (
	t3Selector            = `{plow_source="t3"}`
	historySelector       = `{plow_source="codex_history"}`
	maxResponseBytes      = 4 << 20
	maxLineBytes          = 16 << 10
	activityDay           = 24 * time.Hour
	activityPageLimit     = 2000
	activityCheckpointCap = 32
	activitySplitDepth    = 6
	activityReaders       = 4
	activityShardBytes    = 8 << 20
	activitySnapshotBytes = 32 << 20
	activitySnapshotLines = 50000
)

type lokiClient struct {
	endpoint *url.URL
	tenant   string
	token    string
	http     *http.Client
}

func (l lokiClient) readRun(ctx context.Context, window backend.TimeRange, id string) (runRecord, *backend.DataResponse) {
	query := t3Selector + ` | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_run" | plow_run_id=` + strconv.Quote(id)
	lines, gaps, failure := l.read(ctx, window, query, "t3", runLimit)
	if failure != nil {
		return runRecord{}, failure
	}
	if len(gaps) != 0 {
		return runRecord{}, lokiFailure(backend.StatusBadGateway, "Loki run lookup is incomplete. Narrow the time range or check Loki")
	}

	var run runRecord
	for _, line := range lines {
		var record struct {
			Kind string    `json:"kind"`
			Run  runRecord `json:"run"`
		}
		if json.Unmarshal([]byte(line), &record) != nil || record.Kind != "t3_run" ||
			record.Run.ID != id || len(record.Run.ThreadID) > 128 ||
			!identifier.MatchString(record.Run.SessionID) || record.Run.StartedMS == nil || record.Run.CompletedMS == nil {
			return runRecord{}, lokiFailure(backend.StatusBadGateway, "Loki returned a malformed run record")
		}
		if run.ID != "" && (run.ThreadID != record.Run.ThreadID || run.SessionID != record.Run.SessionID ||
			*run.StartedMS != *record.Run.StartedMS || *run.CompletedMS != *record.Run.CompletedMS) {
			return runRecord{}, lokiFailure(backend.Status(http.StatusConflict), "Loki returned conflicting records for this run ID")
		}
		run = record.Run
	}
	if run.ID == "" {
		return runRecord{}, lokiFailure(backend.StatusNotFound, "Run ID was not found in the selected time range")
	}
	return run, nil
}

func (l lokiClient) readEvents(ctx context.Context, window backend.TimeRange, session string) ([]eventRecord, []string, *backend.DataResponse) {
	query := historySelector + ` | json plow_session_id="sessionId" | plow_session_id=` + strconv.Quote(session)
	lines, gaps, failure := l.read(ctx, window, query, "codex_history", eventLimit)
	if failure != nil {
		return nil, nil, failure
	}

	events := make([]eventRecord, 0, len(lines))
	malformed := false
	for _, line := range lines {
		var event eventRecord
		if json.Unmarshal([]byte(line), &event) != nil || event.SessionID != session || event.TimestampMS == nil ||
			len(event.EventID) > 128 || len(event.CallID) > 128 || len(event.Kind) > 32 {
			malformed = true
			continue
		}
		events = append(events, event)
	}
	if malformed {
		gaps = append(gaps, "Loki returned malformed session events")
	}
	return events, gaps, nil
}

func (l lokiClient) read(ctx context.Context, window backend.TimeRange, query, source string, limit int) ([]string, []string, *backend.DataResponse) {
	return l.readDirection(ctx, window, query, source, limit, false)
}

func (l lokiClient) readDirection(ctx context.Context, window backend.TimeRange, query, source string, limit int, latest bool) ([]string, []string, *backend.DataResponse) {
	page, failure := l.readPage(ctx, window, query, source, limit, latest)
	if failure != nil {
		return nil, nil, failure
	}
	if page.oversized {
		return nil, nil, lokiFailure(backend.StatusBadGateway, "Loki response exceeded 4 MiB. Narrow the time range")
	}
	var gaps []string
	if !latest && len(page.lines) == limit {
		gaps = append(gaps, "Loki entry limit reached. Narrow the time range")
	}
	if page.warned {
		gaps = append(gaps, "Loki returned query warnings")
	}
	return page.lines, gaps, nil
}

type lokiPage struct {
	lines             []string
	warned, oversized bool
}

func (l lokiClient) readPage(ctx context.Context, window backend.TimeRange, query, source string, limit int, latest bool) (lokiPage, *backend.DataResponse) {
	endpoint := *l.endpoint
	params := endpoint.Query()
	params.Set("query", query)
	params.Set("start", strconv.FormatInt(window.From.UnixNano(), 10))
	params.Set("end", strconv.FormatInt(window.To.UnixNano()+1, 10))
	if latest {
		params.Set("direction", "backward")
	} else {
		params.Set("direction", "forward")
	}
	params.Set("limit", strconv.Itoa(limit))
	endpoint.RawQuery = params.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return lokiPage{}, lokiFailure(backend.StatusInternal, "Could not build the Loki request")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("X-Loki-Response-Encoding-Flags", "categorize-labels")
	request.Header.Set("X-Scope-OrgID", l.tenant)
	if l.token != "" {
		request.Header.Set("Authorization", "Bearer "+l.token)
	}
	response, err := l.http.Do(request)
	if err != nil {
		return lokiPage{}, lokiTransportFailure(err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return lokiPage{}, lokiFailure(backend.StatusForbidden, "Loki denied access. Check the configured tenant and credentials")
	case http.StatusTooManyRequests:
		return lokiPage{}, lokiFailure(backend.StatusTooManyRequests, "Loki rate limited the request")
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return lokiPage{}, lokiFailure(backend.StatusTimeout, "Loki query timed out")
	default:
		return lokiPage{}, lokiFailure(backend.StatusBadGateway, "Loki returned HTTP "+strconv.Itoa(response.StatusCode))
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return lokiPage{}, lokiTransportFailure(err)
	}
	if len(body) > maxResponseBytes {
		return lokiPage{oversized: true}, nil
	}
	var payload struct {
		Status   string   `json:"status"`
		Warnings []string `json:"warnings"`
		Data     struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Stream map[string]string   `json:"stream"`
				Values [][]json.RawMessage `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Status != "success" || payload.Data.ResultType != "streams" || payload.Data.Result == nil {
		return lokiPage{}, lokiFailure(backend.StatusBadGateway, "Loki returned an invalid stream response")
	}

	var lines []string
	for _, stream := range payload.Data.Result {
		if stream.Stream["plow_source"] != source || stream.Values == nil {
			return lokiPage{}, lokiFailure(backend.StatusBadGateway, "Loki returned an unexpected stream")
		}
		for _, value := range stream.Values {
			if len(lines) == limit {
				return lokiPage{}, lokiFailure(backend.StatusBadGateway, "Loki returned more entries than requested")
			}
			var timestamp, line string
			if len(value) < 2 || len(value) > 3 || json.Unmarshal(value[0], &timestamp) != nil ||
				json.Unmarshal(value[1], &line) != nil || len(line) > maxLineBytes {
				return lokiPage{}, lokiFailure(backend.StatusBadGateway, "Loki returned an invalid log entry")
			}
			ns, err := strconv.ParseInt(timestamp, 10, 64)
			if err != nil || ns < window.From.UnixNano() || ns > window.To.UnixNano() {
				return lokiPage{}, lokiFailure(backend.StatusBadGateway, "Loki returned a log entry with an invalid query timestamp")
			}
			lines = append(lines, line)
		}
	}
	return lokiPage{lines: lines, warned: len(payload.Warnings) != 0}, nil
}

func lokiFailure(status backend.Status, message string) *backend.DataResponse {
	response := backend.ErrDataResponseWithSource(status, backend.ErrorSourceDownstream, message)
	return &response
}

func lokiTransportFailure(err error) *backend.DataResponse {
	var networkError net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return lokiFailure(backend.StatusTimeout, "Loki query was canceled")
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &networkError) && networkError.Timeout():
		return lokiFailure(backend.StatusTimeout, "Loki query timed out")
	default:
		return lokiFailure(backend.StatusBadGateway, "Loki request failed. Check the configured endpoint")
	}
}

func (ds *datasource) readHistoryRun(ctx context.Context, window backend.TimeRange, id string) (runRecord, *backend.DataResponse) {
	selector := `{plow_source="t3_history"} | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_activity_run" | plow_run_id=` + strconv.Quote(id)
	lines, gaps, failure := ds.loki.read(ctx, window, selector, "t3_history", runLimit)
	if failure != nil {
		return runRecord{}, failure
	}
	if len(gaps) != 0 {
		return runRecord{}, lokiFailure(backend.StatusBadGateway, "Incomplete T3 history lookup")
	}
	raw, failure := runPolicy(ctx, ds.policy, map[string]any{
		"range": "24h", "view": "lookup", "to": time.Now().UnixMilli(),
		"records": map[string][]string{"t3_history": lines},
	})
	if failure != nil {
		return runRecord{}, failure
	}
	var rows []struct {
		Thread  string
		Run     string
		Session string
		Start   *int64
		End     *int64
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return runRecord{}, policyFailure(backend.StatusInternal, "Invalid T3 history result")
	}
	if len(rows) != 1 || rows[0].Run != id || !identifier.MatchString(rows[0].Session) ||
		rows[0].Start == nil || rows[0].End == nil || *rows[0].Start == 0 || *rows[0].End == 0 {
		return runRecord{}, lokiFailure(backend.StatusNotFound, "No unambiguous, strongly bound run in this time range")
	}
	row := rows[0]
	return runRecord{ID: row.Run, ThreadID: row.Thread, SessionID: row.Session, StartedMS: row.Start, CompletedMS: row.End}, nil
}

type activityRead struct {
	window backend.TimeRange
	source string
	kinds  string
	latest bool
}

func (r activityRead) selector() string {
	expr := `{plow_source="` + r.source + `"}`
	if r.kinds != "" {
		expr += " |~ `\"(" + r.kinds + ")\"`" +
			` | json plow_kind="kind" | plow_kind=~"` + r.kinds + `"`
	}
	return expr + ` | drop plow_kind, event_id, observed_timestamp, detected_level, run_id, session_id, call_id`
}

func activityReads(cutoff time.Time) []activityRead {
	window := backend.TimeRange{From: cutoff.Add(-maxRange - activityDay), To: cutoff}
	if window.From.Before(minTime) {
		window.From = minTime
	}
	reads := []activityRead{
		{window, "t3_history", "t3_coverage", true},
		{window, "codex_history", "codex_coverage", true},
		{window, "t3", "", false},
	}
	for to := cutoff; !to.Before(window.From); {
		from := to.Truncate(activityDay)
		if from.Before(window.From) {
			from = window.From
		}
		shard := backend.TimeRange{From: from, To: to}
		reads = append(reads,
			activityRead{shard, "t3_history", "t3_activity_run|t3_pr_link|t3_ci_link|confirmed_delay|operation", false},
			activityRead{shard, "github_history", "github_actions_attempt|github_actions_job", false})
		to = from.Add(-time.Nanosecond)
	}
	return reads
}

type activityRows struct {
	lines   []string
	bytes   int
	partial bool
	failure *backend.DataResponse
}

func (l lokiClient) readActivity(ctx context.Context, cutoff time.Time) (map[string][]string, bool, *backend.DataResponse) {
	records := make(map[string][]string)
	var bytes, count int
	partial := false
	reads := activityReads(cutoff)
	for first := 0; first < len(reads); first += activityReaders {
		batch := reads[first:min(first+activityReaders, len(reads))]
		results := make([]activityRows, len(batch))
		var readers sync.WaitGroup
		for i, read := range batch {
			readers.Go(func() {
				results[i] = l.readActivityShard(ctx, read, activitySplitDepth, activityShardBytes)
			})
		}
		readers.Wait()
		for i, result := range results {
			if result.failure != nil {
				return nil, false, result.failure
			}
			if bytes+result.bytes > activitySnapshotBytes || count+len(result.lines) > activitySnapshotLines {
				partial = true
				continue
			}
			records[batch[i].source] = append(records[batch[i].source], result.lines...)
			bytes += result.bytes
			count += len(result.lines)
			partial = partial || result.partial
		}
	}
	return records, partial, nil
}

func (l lokiClient) readActivityShard(ctx context.Context, read activityRead, depth, remaining int) activityRows {
	limit := activityPageLimit
	if read.latest {
		limit = activityCheckpointCap
	}
	page, failure := l.readPage(ctx, read.window, read.selector(), read.source, limit, read.latest)
	if failure != nil {
		return activityRows{failure: failure}
	}
	saturated := page.oversized || !read.latest && len(page.lines) == limit
	if saturated && depth > 0 && !read.latest && read.window.To.After(read.window.From) {
		middle := read.window.From.Add(read.window.To.Sub(read.window.From) / 2)
		left, right := read, read
		left.window.To, right.window.From = middle, middle.Add(time.Nanosecond)
		older := l.readActivityShard(ctx, left, depth-1, remaining)
		if older.failure != nil {
			return older
		}
		newer := l.readActivityShard(ctx, right, depth-1, remaining-older.bytes)
		if newer.failure != nil {
			return newer
		}
		return activityRows{lines: append(older.lines, newer.lines...), bytes: older.bytes + newer.bytes,
			partial: page.warned || older.partial || newer.partial}
	}

	lines := page.lines
	slices.Sort(lines)
	bytes := 0
	for i, line := range lines {
		bytes += len(line)
		if bytes > remaining {
			return activityRows{lines: lines[:i], bytes: bytes - len(line), partial: true}
		}
	}
	return activityRows{lines: lines, bytes: bytes, partial: saturated || page.warned}
}
