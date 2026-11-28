import Base
import ../plow/policy/preview.bend as Chart
import ../plow/policy/spans.bend as Spans
import ../plow/policy/summary.bend as Summary
import ./policy/snapshot.bend as Snapshot

type Trace is Data:
  Trace{start: Nat, end: Nat, intervals: List<&2,Spans.Interval>, errors: List<&2,Nat>}

type Row is Data:
  Row{start: Nat, end: Nat, parts: List<&2,Spans.Part>, failures: List<&2,Nat>}

type Scene is Data:
  Scene{frame: Chart.UtcSpan, summary: Summary.TimeSummary, rows: List<&2,Row>, batches: List<&2,Snapshot.TrendBatch>}

def bounded(intervals: List<&2,Spans.Interval>, +end: Nat) -> List<&2,Spans.Interval>:
  match intervals:
    case []: []
    case Spans.Interval{+a,+b,k,name} <> tail:
      +stop = Nat.min(b,end)
      +rest = bounded(tail,end)
      Bool.pick(List<&2,Spans.Interval>,Nat.is_lt(a,stop),Spans.Interval{a,stop,k,name} <> rest,rest)

def event_points(times: List<&2,Nat>, +end: Nat) -> List<&2,Nat>:
  match times:
    case []: []
    case +time <> tail:
      +rest = event_points(tail,end)
      Bool.pick(List<&2,Nat>,Nat.is_le(time,end),time <> rest,rest)

def rows(traces: List<&2,Trace>) -> List<&2,Row>:
  match traces:
    case []: []
    case Trace{start,+end,intervals,errors} <> tail:
      Row{start,end,Spans.evidence(bounded(intervals,end),end),event_points(errors,end)} <> rows(tail)

def clocks(input: List<&2,Row>) -> List<&2,Chart.UtcSpan>:
  match input:
    case []: []
    case Row{+start,end,_,_} <> rest: Chart.UtcSpan{start,Nat.add(start,end)} <> clocks(rest)

def summaries(input: List<&2,Row>, +index: Nat) -> List<&2,Summary.SummaryTrace>:
  match input:
    case []: []
    case Row{start,_,parts,_} <> rest: Summary.SummaryTrace{index,start,parts} <> summaries(rest,Nat.add(index,1n))

def compose(+input: List<&2,Row>, history: List<&2,Snapshot.TrendThread>, first: Nat, frame: Chart.UtcSpan) -> Scene:
  match frame:
    case Chart.UtcSpan{+a,+b}:
      Scene{Chart.UtcSpan{a,b},Summary.time_summary(summaries(input,1n),a,b),input,Snapshot.agent_work_trend(history,first)}

def landscape(traces: List<&2,Trace>, history: List<&2,Snapshot.TrendThread>, first: Nat) -> Scene:
  +input = rows(traces)
  compose(input,history,first,Snapshot.utc_frame(clocks(input)))

def ticks(frame: Chart.UtcSpan, +width: Nat) -> List<&2,Nat>:
  match frame:
    case Chart.UtcSpan{+a,+b}: Chart.chart_ticks(Chart.UtcSpan{a,b},Nat.max(1n,Nat.sub(b,a)),Nat.max(1n,width))


type Target is Data:
  Target{key: String, parent: String, section: String, toggle: Bool}

def enter(previous: String, target: Target) -> String:
  match target:
    case Target{+key,parent,_,toggle}:
      Bool.pick(String,Bool.and(toggle,String.eq(previous,key)),parent,key)

def contains(keys: List<&2,String>, +key: String) -> Bool:
  match keys:
    case []: False{}
    case first <> rest: Bool.or(String.eq(first,key),contains(rest,key))

def restore(target: Target, +keys: List<&2,String>) -> String:
  match target:
    case Target{+key,+parent,section,_}:
      Bool.pick(String,contains(keys,key),key,Bool.pick(String,contains(keys,parent),parent,section))
