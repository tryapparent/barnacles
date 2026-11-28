package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const (
	t3Selector            = `{plow_source="t3"}`
	t3HistorySelector     = `{plow_source="t3_history"}`
	historySelector       = `{plow_source="codex_history"}`
	maxResponseBytes      = 4 << 20
	maxLineBytes          = 16 << 10
	activityDay           = 24 * time.Hour
	activityPageLimit     = 2000
	activityCheckpointCap = 32
	activitySplitDepth    = 6
	activityReaders       = 4
	activityReadTimeout   = 7 * time.Second
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
	clocks            []int64
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
	var clocks []int64
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
			clocks = append(clocks, ns)
		}
	}
	return lokiPage{lines: lines, clocks: clocks, warned: len(payload.Warnings) != 0}, nil
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

func (ds *datasource) readHistoryRun(ctx context.Context, window backend.TimeRange, id, view string) (runRecord, string, *backend.DataResponse) {
	selector := t3HistorySelector + ` | json plow_kind="kind", plow_run_id="run.id" | plow_kind="t3_activity_run" | plow_run_id=` + strconv.Quote(id)
	lines, gaps, failure := ds.loki.read(ctx, window, selector, "t3_history", eventLimit)
	if failure != nil {
		return runRecord{}, "", failure
	}
	if len(gaps) != 0 {
		return runRecord{}, "T3 run history lookup is incomplete. " + strings.Join(gaps, ". "), nil
	}
	raw, failure := runPolicy(ctx, ds.policy, map[string]any{
		"range": "24h", "view": view, "to": time.Now().UnixMilli(), "runId": id,
		"records": map[string][]string{"t3_history": lines},
	})
	if failure != nil {
		return runRecord{}, "", failure
	}
	var row struct {
		Thread  string
		Run     string
		Session string
		Turn    string
		Start   *int64
		End     *int64
		Gap     string
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return runRecord{}, "", policyFailure(backend.StatusInternal, "Invalid T3 history result")
	}
	if message := historyGap(row.Gap); message != "" {
		return runRecord{}, message, nil
	}
	if row.Run != id || !identifier.MatchString(row.Session) || row.Start == nil || row.End == nil || row.Gap != "" {
		return runRecord{}, "", policyFailure(backend.StatusInternal, "Invalid T3 history result")
	}
	return runRecord{ID: row.Run, ThreadID: row.Thread, SessionID: row.Session, StartedMS: row.Start, CompletedMS: row.End, TurnID: row.Turn}, "", nil
}

type activityRead struct {
	window backend.TimeRange
	source string
	kinds  string
	latest bool
	query  string
}

func (r activityRead) selector() string {
	expr := `{plow_source="` + r.source + `"}`
	if r.kinds != "" {
		expr += " |~ `\"(" + r.kinds + ")\"`" +
			` | json plow_kind="kind" | plow_kind=~"` + r.kinds + `"`
	}
	return expr + r.query + ` | drop plow_kind, event_id, observed_timestamp, detected_level, run_id, session_id, call_id`
}

func activityReads(cutoff time.Time, operationQuery string) []activityRead {
	window := backend.TimeRange{From: cutoff.Add(-maxRange - activityDay), To: cutoff}
	if window.From.Before(minTime) {
		window.From = minTime
	}
	reads := []activityRead{
		{window, "t3_history", "t3_coverage", true, ""},
		{window, "codex_history", "codex_coverage", true, ""},
		{window, "t3", "", false, ""},
	}
	for to := cutoff; !to.Before(window.From); {
		from := to.Truncate(activityDay)
		if from.Before(window.From) {
			from = window.From
		}
		shard := backend.TimeRange{From: from, To: to}
		reads = append(reads,
			activityRead{shard, "t3_history", "t3_activity_run|t3_pr_link|t3_ci_link|confirmed_delay|operation", false, operationQuery},
			activityRead{shard, "github_history", "github_actions_attempt|github_actions_job", false, ""})
		to = from.Add(-time.Nanosecond)
	}
	return reads
}

type activityRows struct {
	lines   []string
	bytes   int
	gaps    activityGap
	failure *backend.DataResponse
}

type activityGap uint8

const (
	activityWarning activityGap = 1 << iota
	activityPageLines
	activityPageBytes
	activitySliceBytes
	activityTotalLines
	activityTotalBytes
	activityReadDeadline
)

func (l lokiClient) readActivity(ctx context.Context, cutoff time.Time, operationQuery string) (map[string][]string, map[string]activityGap, *backend.DataResponse) {
	readContext, cancel := context.WithTimeout(ctx, activityReadTimeout)
	defer cancel()
	records := make(map[string][]string)
	gaps := make(map[string]activityGap)
	var bytes, count int
	reads := activityReads(cutoff, operationQuery)
	for first := 0; first < len(reads); first += activityReaders {
		if ctx.Err() != nil {
			return nil, nil, lokiTransportFailure(ctx.Err())
		}
		if readContext.Err() != nil {
			for _, read := range reads[first:] {
				gaps[read.source] |= activityReadDeadline
			}
			break
		}
		batch := reads[first:min(first+activityReaders, len(reads))]
		results := make([]activityRows, len(batch))
		var readers sync.WaitGroup
		for i, read := range batch {
			readers.Go(func() {
				pages := 1<<(activitySplitDepth+1) - 1
				results[i] = l.readActivityShard(readContext, read, activitySplitDepth, activityShardBytes, &pages)
			})
		}
		readers.Wait()
		if ctx.Err() != nil {
			return nil, nil, lokiTransportFailure(ctx.Err())
		}
		for i, result := range results {
			if result.failure != nil {
				return nil, nil, result.failure
			}
			source := batch[i].source
			var omitted activityGap
			if bytes+result.bytes > activitySnapshotBytes {
				omitted |= activityTotalBytes
			}
			if count+len(result.lines) > activitySnapshotLines {
				omitted |= activityTotalLines
			}
			if result.gaps|omitted != 0 {
				gaps[source] |= result.gaps | omitted
			}
			if omitted != 0 {
				continue
			}
			records[source] = append(records[source], result.lines...)
			bytes += result.bytes
			count += len(result.lines)
		}
	}
	return records, gaps, nil
}

func (l lokiClient) readActivityShard(ctx context.Context, read activityRead, depth, remaining int, pages *int) activityRows {
	if *pages == 0 {
		return activityRows{gaps: activityPageLines}
	}
	if ctx.Err() != nil {
		return activityRows{gaps: activityReadDeadline}
	}
	(*pages)--
	limit := activityPageLimit
	if read.latest {
		limit = activityCheckpointCap
	}
	page, failure := l.readPage(ctx, read.window, read.selector(), read.source, limit, read.latest)
	if failure != nil {
		if failure.Status == backend.StatusTimeout && ctx.Err() != nil {
			return activityRows{gaps: activityReadDeadline}
		}
		return activityRows{failure: failure}
	}
	var gaps activityGap
	if page.warned {
		gaps |= activityWarning
	}
	saturated := page.oversized || !read.latest && len(page.lines) == limit
	if saturated && !page.oversized {
		last := slices.Max(page.clocks)
		if last > read.window.From.UnixNano() && *pages > 0 {
			var prefix []string
			for i, ns := range page.clocks {
				if ns < last {
					prefix = append(prefix, page.lines[i])
				}
			}
			older := activitySlice(prefix, remaining, gaps)
			if older.gaps&activitySliceBytes != 0 {
				return older
			}
			read.window.From = time.Unix(0, last)
			newer := l.readActivityShard(ctx, read, depth, remaining-older.bytes, pages)
			return mergeActivitySlices(older, newer)
		}
	}
	if saturated && depth > 0 && !read.latest && read.window.To.After(read.window.From) {
		middle := read.window.From.Add(read.window.To.Sub(read.window.From) / 2)
		left, right := read, read
		left.window.To, right.window.From = middle, middle.Add(time.Nanosecond)
		older := l.readActivityShard(ctx, left, depth-1, remaining, pages)
		if older.failure != nil {
			return older
		}
		older.gaps |= gaps
		newer := l.readActivityShard(ctx, right, depth-1, remaining-older.bytes, pages)
		return mergeActivitySlices(older, newer)
	}

	switch {
	case page.oversized:
		gaps |= activityPageBytes
	case saturated:
		gaps |= activityPageLines
	}
	return activitySlice(page.lines, remaining, gaps)
}

func mergeActivitySlices(older, newer activityRows) activityRows {
	if newer.failure != nil {
		return newer
	}
	return activityRows{lines: append(older.lines, newer.lines...), bytes: older.bytes + newer.bytes,
		gaps: older.gaps | newer.gaps}
}

func activitySlice(lines []string, remaining int, gaps activityGap) activityRows {
	slices.Sort(lines)
	bytes := 0
	for i, line := range lines {
		bytes += len(line)
		if bytes > remaining {
			return activityRows{lines: lines[:i], bytes: bytes - len(line), gaps: gaps | activitySliceBytes}
		}
	}
	return activityRows{lines: lines, bytes: bytes, gaps: gaps}
}

var (
	nativeUUID    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	nativeTraceID = regexp.MustCompile(`^[0-9a-f]{32}$`)
)

type tempoMatch struct {
	ID      string `json:"id"`
	Session string `json:"session"`
	Turn    string `json:"turn"`
	Start   int64  `json:"start"`
	End     int64  `json:"end"`
}

func (ds *datasource) tempoSearch(ctx context.Context, from, to time.Time, run runRecord) ([]tempoMatch, bool) {
	const limit = 3
	endpoint := *ds.tempo
	params := url.Values{}
	params.Set("q", `{ instrumentation:name = "plow.codex" && span.conversation.id = `+strconv.Quote(run.SessionID)+
		` && span.turn.id = `+strconv.Quote(run.TurnID)+` } | select(span.conversation.id, span.turn.id)`)
	params.Set("start", strconv.FormatInt(from.Unix(), 10))
	params.Set("end", strconv.FormatInt(to.Unix(), 10))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("spss", "1")
	endpoint.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, false
	}
	resp, err := ds.loki.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10+1))
	if err != nil || len(body) > 256<<10 {
		return nil, false
	}
	var payload struct {
		Metrics *struct {
			CompletedJobs int `json:"completedJobs"`
			TotalJobs     int `json:"totalJobs"`
		} `json:"metrics"`
		Traces []struct {
			ID       string `json:"traceID"`
			Start    string `json:"startTimeUnixNano"`
			Duration uint32 `json:"durationMs"`
			SpanSets []struct {
				Spans []struct {
					Attributes []struct {
						Key   string `json:"key"`
						Value struct {
							String string `json:"stringValue"`
						} `json:"value"`
					} `json:"attributes"`
				} `json:"spans"`
			} `json:"spanSets"`
		} `json:"traces"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Metrics == nil ||
		payload.Traces == nil || payload.Metrics.TotalJobs < 0 || payload.Metrics.CompletedJobs != payload.Metrics.TotalJobs ||
		(payload.Metrics.TotalJobs == 0 && len(payload.Traces) != 0) ||
		len(payload.Traces) >= limit {
		return nil, false
	}
	rows := make([]tempoMatch, 0, len(payload.Traces))
	for _, candidate := range payload.Traces {
		ns, err := strconv.ParseInt(candidate.Start, 10, 64)
		if err != nil || !nativeTraceID.MatchString(candidate.ID) || candidate.ID == strings.Repeat("0", 32) ||
			len(candidate.SpanSets) != 1 || len(candidate.SpanSets[0].Spans) != 1 {
			return nil, false
		}
		row := tempoMatch{ID: candidate.ID, Start: ns / 1_000_000}
		row.End = row.Start + int64(candidate.Duration) + 1
		var sessionCount, turnCount int
		for _, attribute := range candidate.SpanSets[0].Spans[0].Attributes {
			switch attribute.Key {
			case "conversation.id":
				row.Session = attribute.Value.String
				sessionCount++
			case "turn.id":
				row.Turn = attribute.Value.String
				turnCount++
			}
		}
		if sessionCount != 1 || turnCount != 1 {
			return nil, false
		}
		rows = append(rows, row)
	}
	return rows, true
}
