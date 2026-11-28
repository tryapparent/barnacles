package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

type runRecord struct {
	ID          string `json:"id"`
	ThreadID    string `json:"threadId"`
	SessionID   string `json:"sessionId"`
	TurnID      string `json:"codexTurnId,omitempty"`
	StartedMS   *int64 `json:"startedMs"`
	CompletedMS *int64 `json:"completedMs"`
}

type eventRecord struct {
	EventID     string `json:"eventId"`
	SessionID   string `json:"sessionId"`
	CallID      string `json:"callId"`
	Kind        string `json:"kind"`
	TimestampMS *int64 `json:"timestampMs"`
}

type policyInput struct {
	Run     runRecord     `json:"run"`
	Events  []eventRecord `json:"events"`
	History bool          `json:"history,omitempty"`
}

type policyOutput struct {
	RunID     string `json:"runId"`
	Intervals []struct {
		CallID     string `json:"callId"`
		Kind       string `json:"kind"`
		StartMS    *int64 `json:"startMs"`
		EndMS      *int64 `json:"endMs"`
		DurationMS *int64 `json:"durationMs"`
	} `json:"intervals"`
	Findings []struct {
		CallID string `json:"callId"`
		Reason string `json:"reason"`
	} `json:"findings"`
	Coverage struct {
		Events  *int64 `json:"events"`
		Paired  *int64 `json:"paired"`
		Unknown *int64 `json:"unknown"`
		Gap     string `json:"gap"`
	} `json:"coverage"`
}

func runPolicy(ctx context.Context, path string, input any) ([]byte, *backend.DataResponse) {
	return runPolicyWithin(ctx, path, input, ioTimeout)
}

func runPolicyWithin(ctx context.Context, path string, input any, timeout time.Duration) ([]byte, *backend.DataResponse) {
	body, err := json.Marshal(input)
	if err != nil {
		return nil, policyFailure(backend.StatusInternal, "Could not encode the policy input")
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stdout := &boundedOutput{}
	command := exec.CommandContext(ctx, path)
	command.WaitDelay = 250 * time.Millisecond
	command.Stdin = bytes.NewReader(body)
	command.Stdout = stdout
	if err := command.Run(); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return nil, policyFailure(backend.StatusTimeout, "Policy executable timed out")
		case errors.Is(ctx.Err(), context.Canceled):
			return nil, policyFailure(backend.StatusTimeout, "Policy execution was canceled")
		case stdout.exceeded:
			return nil, policyFailure(backend.StatusInternal, "Policy output exceeded 4 MiB")
		default:
			return nil, policyFailure(backend.StatusInternal, "Policy executable failed")
		}
	}

	return stdout.buffer.Bytes(), nil
}

func executePolicy(ctx context.Context, path string, input policyInput) (policyOutput, *backend.DataResponse) {
	var output policyOutput
	raw, failure := runPolicy(ctx, path, input)
	if failure != nil {
		return output, failure
	}

	if json.Unmarshal(raw, &output) != nil || output.RunID != input.Run.ID ||
		output.Intervals == nil || output.Findings == nil || output.Coverage.Events == nil ||
		output.Coverage.Paired == nil || output.Coverage.Unknown == nil {
		return output, policyFailure(backend.StatusInternal, "Policy executable returned an invalid result")
	}
	for _, interval := range output.Intervals {
		if interval.Kind == "" {
			return output, policyFailure(backend.StatusInternal, "Policy executable returned an invalid interval")
		}
	}
	for _, finding := range output.Findings {
		if finding.Reason == "" {
			return output, policyFailure(backend.StatusInternal, "Policy executable returned an invalid finding")
		}
	}
	return output, nil
}

type boundedOutput struct {
	buffer   bytes.Buffer
	exceeded bool
}

func (o *boundedOutput) Write(p []byte) (int, error) {
	if o.buffer.Len()+len(p) > maxResponseBytes {
		o.exceeded = true
		return 0, errors.New("policy output exceeds byte limit")
	}
	return o.buffer.Write(p)
}

func policyFailure(status backend.Status, message string) *backend.DataResponse {
	response := backend.ErrDataResponseWithSource(status, backend.ErrorSourcePlugin, message)
	return &response
}

func historyGap(reason string) string {
	switch reason {
	case "missing_run":
		return "T3 run history is unavailable in the selected time range"
	case "run_open":
		return "T3 has no terminal run snapshot in the selected time range"
	case "missing_clocks":
		return "T3 run history has no valid start and completion clocks"
	case "missing_binding":
		return "T3 run history has no unique strong Codex session binding"
	case "conflicting_run":
		return "T3 run history contains conflicting run records"
	case "unreadable_run":
		return "T3 run history contains unreadable records"
	case "missing_events":
		return "No Codex tool events were observed inside the run window"
	default:
		return ""
	}
}

func renderUnavailable(id, gap string) backend.DataResponse {
	var output policyOutput
	var zero int64
	output.RunID = id
	output.Coverage.Events = &zero
	output.Coverage.Paired = &zero
	output.Coverage.Unknown = &zero
	return render(output, []string{gap})
}

func render(output policyOutput, gaps []string) backend.DataResponse {
	intervals := data.NewFrame("intervals",
		data.NewField("callId", nil, []string{}),
		data.NewField("kind", nil, []string{}),
		data.NewField("startMs", nil, []*int64{}),
		data.NewField("endMs", nil, []*int64{}),
		data.NewField("durationMs", nil, []*int64{}),
	)
	for _, interval := range output.Intervals {
		intervals.AppendRow(interval.CallID, interval.Kind, interval.StartMS, interval.EndMS, interval.DurationMS)
	}

	findings := data.NewFrame("findings",
		data.NewField("callId", nil, []string{}),
		data.NewField("reason", nil, []string{}),
	)
	for _, finding := range output.Findings {
		findings.AppendRow(finding.CallID, finding.Reason)
	}

	sourceGaps := strings.Join(gaps, ". ")
	coverage := data.NewFrame("coverage",
		data.NewField("runId", nil, []string{output.RunID}),
		data.NewField("events", nil, []int64{*output.Coverage.Events}),
		data.NewField("paired", nil, []int64{*output.Coverage.Paired}),
		data.NewField("unknown", nil, []int64{*output.Coverage.Unknown}),
		data.NewField("sourceComplete", nil, []bool{len(gaps) == 0}),
		data.NewField("sourceGaps", nil, []string{sourceGaps}),
	)
	for _, frame := range []*data.Frame{intervals, findings, coverage} {
		if len(gaps) != 0 {
			frame.Meta = &data.FrameMeta{
				Notices: []data.Notice{{Severity: data.NoticeSeverityWarning, Text: sourceGaps}},
			}
		}
	}
	return backend.DataResponse{Frames: data.Frames{intervals, findings, coverage}}
}

type activityLane struct {
	ID    string
	Spans []struct {
		First     int64  `json:"a"`
		Last      int64  `json:"b"`
		Operation string `json:"n"`
	}
}

type activityTotal struct {
	Category  string
	Operation string
	MS        int64
}

type activityOutput struct {
	Partial         bool
	DecodeGap       bool
	notices         []data.Notice
	From            int64
	Cutoff          int64
	Oldest          int64
	T3Coverage      string
	CodexCoverage   string
	CICoverage      string
	OutcomeCoverage string
	UnknownRuns     int64
	Conflicts       int64
	Threads         []activityLane
	Links           []struct {
		Thread string
		Run    string
		Source string
		First  int64
		Last   int64
	}
	CI         []activityLane
	Totals     []activityTotal
	Categories []activityTotal
	Buckets    []struct {
		Time    int64
		Threads int64
		Share   *float64
	}
	Findings []struct {
		Kind        string
		Occurrences int64
		Measured    int64
		MS          *int64
		Next        string
	}
}

func activityNotices(gaps map[string]activityGap, report activityOutput) []data.Notice {
	labels := map[string]string{
		"t3": "legacy T3", "t3_history": "T3 history", "codex_history": "Codex checkpoints", "github_history": "GitHub CI",
	}
	var reasons []string
	add := func(message string) {
		reasons = append(reasons, message)
	}
	for _, source := range slices.Sorted(maps.Keys(gaps)) {
		label := labels[source]
		flags := gaps[source]
		if flags&activityWarning != 0 {
			add("Loki warned about " + label + ". Evidence may be missing.")
		}
		if flags&activityPageLines != 0 {
			add("A " + label + " query still hit Loki’s entry limit after splitting.")
		}
		if flags&activityPageBytes != 0 {
			add("A " + label + " response exceeded the Loki reply size limit.")
		}
		if flags&activitySliceBytes != 0 {
			add("A " + label + " time slice exceeded the Activity size limit.")
		}
		if flags&activityTotalLines != 0 {
			add("The Activity row limit omitted " + label + " slices.")
		}
		if flags&activityTotalBytes != 0 {
			add("The Activity size limit omitted " + label + " slices.")
		}
		if flags&activityReadDeadline != 0 {
			add("Activity ran out of time to read " + label + ".")
		}
	}
	if report.DecodeGap {
		add("Activity skipped unreadable Loki evidence.")
	}
	if report.Partial && len(reasons) == 0 {
		add("Partial Loki read. Activity may omit evidence.")
	}
	if len(reasons) == 0 {
		return nil
	}
	return []data.Notice{{Severity: data.NoticeSeverityWarning, Text: strings.Join(reasons, " "), Inspect: data.InspectTypeData}}
}

func timeField(ms int64) *time.Time {
	if ms == 0 {
		return nil
	}
	at := time.UnixMilli(ms).UTC()
	return &at
}

func renderActivity(report activityOutput, view string) data.Frames {
	switch view {
	case "coverage":
		return data.Frames{data.NewFrame("Source coverage",
			data.NewField("Source", nil, []string{"T3", "Codex", "GitHub CI", "Outcome delay"}),
			data.NewField("Coverage", nil, []string{report.T3Coverage, report.CodexCoverage, report.CICoverage, report.OutcomeCoverage}),
			data.NewField("Cutoff (UTC)", nil, []*time.Time{timeField(report.Cutoff), nil, nil, nil}),
			data.NewField("Oldest source clock", nil, []*time.Time{timeField(report.Oldest), nil, nil, nil}),
			data.NewField("Clock gaps", nil, []*int64{&report.UnknownRuns, nil, nil, nil}),
			data.NewField("Conflicts", nil, []*int64{&report.Conflicts, nil, nil, nil}),
		)}
	case "breakdown":
		categories := data.NewFrame("Categories",
			data.NewField("Category", nil, []string{}),
			data.NewField("Elapsed", nil, []int64{}))
		operations := data.NewFrame("Operations",
			data.NewField("Category", nil, []string{}),
			data.NewField("Operation", nil, []string{}),
			data.NewField("Elapsed", nil, []int64{}))
		for _, total := range report.Categories {
			categories.AppendRow(total.Category, total.MS)
		}
		for _, total := range report.Totals {
			operations.AppendRow(total.Category, total.Operation, total.MS)
		}
		return data.Frames{categories, operations}
	case "share":
		frame := data.NewFrame("Mean per-thread work share",
			data.NewField("Time", nil, []time.Time{}),
			data.NewField("Agent work share", nil, []*float64{}))
		for _, bucket := range report.Buckets {
			var share *float64
			if bucket.Share != nil {
				value := *bucket.Share / 100
				share = &value
			}
			frame.AppendRow(time.UnixMilli(bucket.Time).UTC(), share)
		}
		return data.Frames{frame}
	case "timeline":
		return renderTimeline(report.Threads)
	case "ci":
		return renderTimeline(report.CI)
	case "runs":
		frame := data.NewFrame("Exact run links",
			data.NewField("Thread", nil, []string{}),
			data.NewField("Run", nil, []string{}),
			data.NewField("History", nil, []string{}),
			data.NewField("From (UTC)", nil, []time.Time{}),
			data.NewField("To (UTC)", nil, []time.Time{}))
		for _, link := range report.Links {
			history := ""
			if link.Source == "t3_history" {
				history = "1"
			}
			frame.AppendRow(link.Thread, link.Run, history, time.UnixMilli(link.First).UTC(), time.UnixMilli(link.Last).UTC())
		}
		return data.Frames{frame}
	case "findings":
		frame := data.NewFrame("Ranked findings",
			data.NewField("Finding", nil, []string{}),
			data.NewField("Occurrences", nil, []int64{}),
			data.NewField("Measured", nil, []int64{}),
			data.NewField("Measured impact", nil, []*int64{}),
			data.NewField("Next step", nil, []string{}))
		for _, finding := range report.Findings {
			frame.AppendRow(finding.Kind, finding.Occurrences, finding.Measured, finding.MS, finding.Next)
		}
		return data.Frames{frame}
	default:
		return nil
	}
}

func renderTimeline(lanes []activityLane) data.Frames {
	frames := make(data.Frames, 0, len(lanes))
	for _, lane := range lanes {
		frame := data.NewFrame(lane.ID,
			data.NewField("Start time", nil, []time.Time{}),
			data.NewField("End time", nil, []time.Time{}),
			data.NewField(lane.ID, nil, []string{}))
		frame.Fields[2].Config = &data.FieldConfig{DisplayName: lane.ID}
		for _, span := range lane.Spans {
			frame.AppendRow(time.UnixMilli(span.First).UTC(), time.UnixMilli(span.Last).UTC(), span.Operation)
		}
		frames = append(frames, frame)
	}
	return frames
}

type traceLink struct {
	ID    string
	Start int64
	End   int64
	Gap   string
}

func (ds *datasource) runTrace(ctx context.Context, window backend.TimeRange, id string, history bool) backend.DataResponse {
	if !history {
		return traceFrame(traceLink{}, "No exact Codex turn was recorded for this run")
	}
	run, gap, failure := ds.readHistoryRun(ctx, window, id, "traceBinding")
	if failure != nil {
		return traceFrame(traceLink{}, "T3 run evidence is unavailable")
	}
	if gap != "" {
		return traceFrame(traceLink{}, gap)
	}
	if !nativeUUID.MatchString(run.SessionID) || !nativeUUID.MatchString(run.TurnID) {
		return traceFrame(traceLink{}, "No exact Codex turn was recorded for this run")
	}

	now := time.Now().UTC().Truncate(time.Second).Add(time.Second)
	middle := now.Add(-maxRange)
	oldest := middle.Add(-maxRange)
	if ds.tempo == nil || time.UnixMilli(*run.StartedMS).Before(oldest) {
		return traceFrame(traceLink{}, "The retained Tempo search cannot cover this run")
	}
	recent, recentComplete := ds.tempoSearch(ctx, middle, now, run)
	var older []tempoMatch
	var olderComplete bool
	if recentComplete {
		older, olderComplete = ds.tempoSearch(ctx, oldest, middle, run)
	}
	matches := append(make([]tempoMatch, 0, len(recent)+len(older)), recent...)
	raw, failure := runPolicy(ctx, ds.policy, map[string]any{
		"view": "exactTrace", "session": run.SessionID, "turn": run.TurnID,
		"matches": append(matches, older...), "complete": recentComplete && olderComplete,
	})
	var trace traceLink
	if failure != nil || json.Unmarshal(raw, &trace) != nil {
		return traceFrame(traceLink{}, "Trace verification is unavailable")
	}
	switch trace.Gap {
	case "missing":
		return traceFrame(traceLink{}, "Tempo has no retained trace for this Codex turn")
	case "ambiguous":
		return traceFrame(traceLink{}, "Tempo has conflicting traces or clocks for this Codex turn")
	case "incomplete":
		return traceFrame(traceLink{}, "Tempo could not complete the search. Refresh to retry")
	}
	if trace.Gap != "" || !nativeTraceID.MatchString(trace.ID) || trace.Start <= 0 || trace.End <= trace.Start {
		return traceFrame(traceLink{}, "Trace verification is unavailable")
	}
	return traceFrame(trace, "Matched the run’s exact Codex turn")
}

func traceFrame(trace traceLink, status string) backend.DataResponse {
	label := "Unknown"
	field := data.NewField("Trace", nil, []string{label})
	if trace.ID != "" {
		field.Set(0, "Open Codex trace")
		field.Config = &data.FieldConfig{Links: []data.DataLink{{
			Title: "Open Codex trace",
			URL:   fmt.Sprintf("/d/plow-codex-trace/plow-codex-trace?var-traceId=%s&from=%d&to=%d", trace.ID, trace.Start, trace.End),
		}}}
	}
	return backend.DataResponse{Frames: data.Frames{
		data.NewFrame("trace", field, data.NewField("Evidence", nil, []string{status})),
	}}
}
