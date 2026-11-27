import Base
import ../dashboard/plow/policy/preview.bend as Dashboard
import ../dashboard/plow/policy/spans.bend as Spans
import ../dashboard/plow/policy/summary.bend as Summary
import ../dashboard/plow/policy/trend.bend as Trend

type ChartTrace is Data:
  ChartRow{index: Nat, start: Nat, duration: Nat, intervals: List<&2, Spans.Interval>}

type DashboardCharts is Data:
  Charts{from: Nat, to: Nat, time_summary: Summary.TimeSummary, agent_work_trend: List<&2, Trend.TrendPoint>}

def summary_rows(rows: List<&2, ChartTrace>) -> List<&2, Summary.SummaryTrace>:
  match rows:
    case []: []
    case ChartRow{index,start,duration,intervals} <> rest:
      Summary.SummaryTrace{index,start,Dashboard.evidence(intervals,duration)} <> summary_rows(rest)

def charts(rows: List<&2, ChartTrace>, +to: Nat) -> DashboardCharts:
  +from = Dashboard.overview_start(to)
  +traces = summary_rows(rows)
  Charts{from,to,Dashboard.time_summary(traces,from,to),Dashboard.agent_work_trend(traces,from)}
