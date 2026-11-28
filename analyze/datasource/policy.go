package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

type runRecord struct {
	ID          string `json:"id"`
	ThreadID    string `json:"threadId"`
	SessionID   string `json:"sessionId"`
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
	Run    runRecord     `json:"run"`
	Events []eventRecord `json:"events"`
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
	} `json:"coverage"`
}

func executePolicy(ctx context.Context, path string, input policyInput) (policyOutput, *backend.DataResponse) {
	var output policyOutput
	body, err := json.Marshal(input)
	if err != nil {
		return output, policyFailure(backend.StatusInternal, "Could not encode the policy input")
	}

	ctx, cancel := context.WithTimeout(ctx, ioTimeout)
	defer cancel()
	stdout := &boundedOutput{}
	command := exec.CommandContext(ctx, path)
	command.WaitDelay = 250 * time.Millisecond
	command.Stdin = bytes.NewReader(body)
	command.Stdout = stdout
	if err := command.Run(); err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return output, policyFailure(backend.StatusTimeout, "Policy executable timed out")
		case errors.Is(ctx.Err(), context.Canceled):
			return output, policyFailure(backend.StatusTimeout, "Policy execution was canceled")
		case stdout.exceeded:
			return output, policyFailure(backend.StatusInternal, "Policy output exceeded 4 MiB")
		default:
			return output, policyFailure(backend.StatusInternal, "Policy executable failed")
		}
	}

	if json.Unmarshal(stdout.buffer.Bytes(), &output) != nil || output.RunID != input.Run.ID ||
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
