import Base

type Run is Data:
  Run{requested: Nat, started: Nat, completed: Nat, status: String}
type Thread is Data:
  Thread{created: Nat, updated: Nat, runs: List<&2,Run>}
type Span is Data:
  Span{a: Nat, b: Nat, name: String}
type Trace is Data:
  Trace{start: Nat, end: Nat, work: List<&2,Span>, wait: List<&2,Span>, errors: List<&2,Nat>}
type Feed is Data:
  Feed{observed: Nat, traces: List<&2,Trace>}
type Progress is Data:
  Progress{remaining: Nat, feed: Feed}
type Clocks is Data:
  Clocks{last: Nat, work: List<&2,Span>, wait: List<&2,Span>, errors: List<&2,Nat>}

def within(+a: Nat, +b: Nat, +created: Nat, +updated: Nat) -> Bool:
  Bool.and(Nat.is_le(created,a),Bool.and(Nat.is_lt(a,b),Nat.is_le(b,updated)))

def run_failed(status: String) -> Bool:
  String.eq(status,"failed")

def record_run(run: Run, +created: Nat, +updated: Nat, clocks: Clocks) -> Clocks:
  match run clocks:
    case Run{+requested,+started,+completed,status} Clocks{last,+work,+wait,+errors}:
      +wait_known = within(requested,started,created,updated)
      +work_known = within(started,completed,created,updated)
      +a = Nat.sub(started,created)
      +b = Nat.sub(completed,created)
      +last_wait = Bool.pick(Nat,wait_known,a,0n)
      +last_work = Bool.pick(Nat,work_known,b,0n)
      Clocks{Nat.max(last,Nat.max(last_wait,last_work)),
        Bool.pick(List<&2,Span>,work_known,Span{a,b,"Provider run"} <> work,work),
        Bool.pick(List<&2,Span>,wait_known,Span{Nat.sub(requested,created),a,"T3 admission"} <> wait,wait),
        Bool.pick(List<&2,Nat>,Bool.and(work_known,run_failed(status)),b <> errors,errors)}

def run_clocks(runs: List<&2,Run>, +created: Nat, +updated: Nat, clocks: Clocks) -> Clocks:
  match runs:
    case []: clocks
    case run <> rest: run_clocks(rest,created,updated,record_run(run,created,updated,clocks))

def thread_before(a: Thread, b: Thread) -> Bool:
  match a b:
    case Thread{x,_,_} Thread{y,_,_}: Nat.is_le(y,x)

def with_clocks(clocks: Clocks, +created: Nat, +updated: Nat, +remaining: Nat, feed: Feed) -> Progress:
  match clocks feed:
    case Clocks{+last,work,wait,errors} Feed{+observed,+traces}:
      +known = Nat.is_lt(0n,last)
      +kept = Bool.pick(List<&2,Trace>,known,Trace{created,last,work,wait,errors} <> traces,traces)
      +through = Bool.pick(Nat,known,Nat.max(observed,updated),observed)
      Progress{Bool.pick(Nat,known,Nat.sub(remaining,1n),remaining),Feed{through,kept}}

def collect(threads: List<&2,Thread>, progress: Progress) -> Feed:
  match threads progress:
    case [] Progress{_,feed}: feed
    case _ Progress{0n,feed}: feed
    case Thread{+created,+updated,runs} <> rest Progress{remaining,feed}:
      collect(rest,with_clocks(run_clocks(runs,created,updated,Clocks{0n,[],[],[]}),created,updated,remaining,feed))

def ordered_feed(feed: Feed) -> Feed:
  match feed:
    case Feed{observed,traces}: Feed{observed,List.reverse(&2,Trace,traces)}

def project_feed(threads: List<&2,Thread>) -> Feed:
  ordered_feed(collect(List.sort(~Thread,~thread_before,threads),Progress{10n,Feed{0n,[]}}))
