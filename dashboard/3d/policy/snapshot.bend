import Base
import ../../plow/policy/preview.bend as Chart

type TrendThread is Data:
  TrendThread{start: Nat, position: Nat, work: Nat, workflow: Nat}

type TrendBatch is Data:
  TrendBatch{first: Nat, last: Nat, measured: Nat, basis_points: Nat}

def trend_before(a: TrendThread, b: TrendThread) -> Bool:
  match a b:
    case TrendThread{+x,i,_,_} TrendThread{+y,j,_,_}:
      Bool.or(Nat.is_lt(x,y),Bool.and(Nat.is_eq(x,y),Nat.is_le(i,j)))

type TrendScore is Data:
  TrendScore{measured: Nat, total: Nat}

def record_trend(+work: Nat, workflow: Nat, score: TrendScore) -> TrendScore:
  match score:
    case TrendScore{measured,total}:
      +classified = Nat.add(work,workflow)
      +known = Bool.pick(Nat,Nat.is_lt(0n,classified),1n,0n)
      +share = Nat.div(Nat.mul(work,1000000n),Nat.max(1n,classified))
      TrendScore{Nat.add(measured,known),Nat.add(total,share)}

def completed_trend(+first: Nat, score: TrendScore) -> TrendBatch:
  match score:
    case TrendScore{+measured,total}:
      +mean = Nat.div(Nat.add(total,Nat.mul(measured,50n)),Nat.mul(Nat.max(1n,measured),100n))
      TrendBatch{first,Nat.add(first,9n),measured,mean}

def collect_trend(input: List<&2,TrendThread>, +first: Nat, size: Nat, score: TrendScore) -> List<&2,TrendBatch>:
  match input size:
    case [] _: []
    case TrendThread{_,_,work,workflow} <> rest 0n:
      completed_trend(first,record_trend(work,workflow,score)) <> collect_trend(rest,Nat.add(first,10n),9n,TrendScore{0n,0n})
    case TrendThread{_,_,work,workflow} <> rest 1n+left:
      collect_trend(rest,first,left,record_trend(work,workflow,score))

def agent_work_trend(threads: List<&2,TrendThread>, first: Nat) -> List<&2,TrendBatch>:
  collect_trend(List.sort(~TrendThread,~trend_before,threads),first,9n,TrendScore{0n,0n})

def expand_utc(current: Chart.UtcSpan, next: Chart.UtcSpan) -> Chart.UtcSpan:
  match current next:
    case Chart.UtcSpan{+a,+b} Chart.UtcSpan{+x,+y}:
      Chart.UtcSpan{Bool.pick(Nat,Nat.is_lt(x,a),x,a),Bool.pick(Nat,Nat.is_lt(b,y),y,b)}

def scan_utc(rest: List<&2,Chart.UtcSpan>, bounds: Chart.UtcSpan) -> Chart.UtcSpan:
  match rest:
    case []: bounds
    case entry <> tail: scan_utc(tail,expand_utc(bounds,entry))

def rounded_utc(bounds: Chart.UtcSpan) -> Chart.UtcSpan:
  match bounds:
    case Chart.UtcSpan{a,b}:
      Chart.UtcSpan{Nat.mul(Nat.div(a,21600000n),21600000n),Nat.mul(Nat.div(Nat.add(b,21599999n),21600000n),21600000n)}

def utc_frame(input: List<&2,Chart.UtcSpan>) -> Chart.UtcSpan:
  match input:
    case []: Chart.UtcSpan{0n,21600000n}
    case first <> rest: rounded_utc(scan_utc(rest,first))
