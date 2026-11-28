import Base
import ../dashboard/plow/policy/preview.bend as Dashboard
import ../dashboard/plow/policy/spans.bend as Spans
import ../dashboard/plow/policy/summary.bend as Summary
import ../dashboard/plow/policy/trend.bend as Trend

type ChartTrace is Data:
  ChartRow{start: Nat, duration: Nat, extent: Nat, intervals: List<&2, Spans.Interval>}

type DashboardCharts is Data:
  Charts{from: Nat, to: Nat, time_summary: Summary.TimeSummary, agent_work_trend: List<&2, Trend.TrendPoint>}

type ActivityFrame is Data:
  Activity{from: Nat, to: Nat, covered: Bool, indices: List<&2,Nat>}

def utc_spans(rows: List<&2, ChartTrace>) -> List<&2, Dashboard.UtcSpan>:
  match rows:
    case []: []
    case ChartRow{+start,_,extent,_} <> rest:
      Dashboard.UtcSpan{start,Nat.add(start,extent)} <> utc_spans(rest)

def frame_start(frame: Dashboard.UtcSpan) -> Nat:
  match frame:
    case Dashboard.UtcSpan{from,_}: from

def activity(rows: List<&2, ChartTrace>, +range: String, +to: Nat, has_from: Bool, feed_from: Nat) -> ActivityFrame:
  +frame = Dashboard.dashboard_frame(range,to)
  +default_from = frame_start(Dashboard.dashboard_frame("24h",to))
  +covered = Dashboard.feed_covers(range,frame,Bool.pick(Nat,has_from,feed_from,default_from))
  Activity{frame_start(frame),to,covered,Dashboard.timeline_indices(utc_spans(rows),10n,frame,0n)}

def summary_rows(rows: List<&2, ChartTrace>, +index: Nat) -> List<&2, Summary.SummaryTrace>:
  match rows:
    case []: []
    case ChartRow{start,duration,_,intervals} <> rest:
      Summary.SummaryTrace{index,start,Dashboard.evidence(intervals,duration)} <> summary_rows(rest,Nat.add(index,1n))

def charts(overview: List<&2, ChartTrace>, range: String, +from: Nat, +to: Nat) -> DashboardCharts:
  +traces = summary_rows(overview,1n)
  Charts{from,to,Dashboard.time_summary(traces,from,to),Dashboard.agent_work_trend(traces,range,from,to)}
