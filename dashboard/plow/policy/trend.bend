import Base
import ./summary.bend as Summary

type TrendPoint is Data:
  TrendPoint{from: Nat, to: Nat, measured: Nat, basis_points: Nat}

type TrendScore is Data:
  TrendScore{measured: Nat, total: Nat}

def record_score(+spans: List<&2, Summary.SummarySpan>, score: TrendScore) -> TrendScore:
  match score:
    case TrendScore{measured,total}:
      +work = Summary.span_time(Summary.category_spans(spans,2))
      +classified = Nat.add(work,Summary.span_time(Summary.category_spans(spans,1)))
      +known = Bool.pick(Nat,Nat.is_lt(0n,classified),1n,0n)
      +share = Nat.div(Nat.mul(work,1000000n),Nat.max(1n,classified))
      TrendScore{Nat.add(measured,known),Nat.add(total,share)}

def score_traces(traces: List<&2, Summary.SummaryTrace>, +from: Nat, +to: Nat, score: TrendScore) -> TrendScore:
  match traces:
    case []: score
    case trace <> rest:
      score_traces(rest,from,to,record_score(Summary.clip_traces([trace],from,to),score))

def point(+from: Nat, +to: Nat, score: TrendScore) -> TrendPoint:
  match score:
    case TrendScore{+measured,total}:
      +mean = Nat.div(Nat.add(total,Nat.mul(measured,50n)),Nat.mul(Nat.max(1n,measured),100n))
      TrendPoint{from,to,measured,mean}

def trend_points(buckets: Nat, +traces: List<&2,Summary.SummaryTrace>, +from: Nat) -> List<&2,TrendPoint>:
  match buckets:
    case 0n: []
    case 1n+rest:
      +to = Nat.add(from,14400000n)
      point(from,to,score_traces(traces,from,to,TrendScore{0n,0n})) <> trend_points(rest,traces,to)

def agent_work_trend(traces: List<&2,Summary.SummaryTrace>, from: Nat) -> List<&2,TrendPoint>:
  trend_points(6n,traces,from)
