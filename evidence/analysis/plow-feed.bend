import Base
import ./joined/range.bend as Range

type Run is Data:
  Run{requested: Nat, started: Nat, completed: Nat, status: String}
type Thread is Data:
  Thread{created: Nat, updated: Nat, runs: List<&2,Run>, detail: List<&2,ProviderSpan>, ci: List<&2,CiPoll>}
type ProviderSpan is Data:
  ProviderSpan{a: Nat, b: Nat, operation: String}
type CiPoll is Data:
  CiPoll{a: Nat, b: Nat}
type Span is Data:
  Span{a: Nat, b: Nat, name: String}
type Trace is Data:
  Trace{start: Nat, end: Nat, work: List<&2,Span>, wait: List<&2,Span>, errors: List<&2,Nat>, detail: List<&2,Span>, ci: List<&2,Span>}
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
    case Thread{x,_,_,_,_} Thread{y,_,_,_,_}: Nat.is_le(y,x)

def detail_name(operation: String) -> String:
  match operation:
    case "codex.sampling": "Model sampling"
    case "codex.tool_blocking": "Tool wait"
    case "dispatch_tool_call_with_state": "Tool call"
    case "unified_exec.exec_command": "Command"
    case "exec_command": "Command"
    case _: ""

def contains_span(+a: Nat, +b: Nat, work: List<&2,Span>) -> Bool:
  match work:
    case []: False{}
    case Span{x,y,_} <> rest:
      Bool.or(Bool.and(Nat.is_le(x,a),Nat.is_le(b,y)),contains_span(a,b,rest))

def provider_detail(input: List<&2,ProviderSpan>, +origin: Nat, +work: List<&2,Span>) -> List<&2,Span>:
  match input:
    case []: []
    case ProviderSpan{+a,+b,operation} <> rest:
      +name = detail_name(operation)
      +start = Nat.sub(a,origin)
      +end = Nat.sub(b,origin)
      +tail = provider_detail(rest,origin,work)
      +valid = Bool.and(Bool.not(String.eq(name,"")),Bool.and(Nat.is_le(origin,a),Nat.is_lt(start,end)))
      Bool.pick(List<&2,Span>,Bool.and(valid,contains_span(start,end,work)),Span{start,end,name} <> tail,tail)

def ci_observations(input: List<&2,CiPoll>, +created: Nat, +last: Nat) -> List<&2,Span>:
  match input:
    case []: []
    case CiPoll{+a,+b} <> rest:
      +tail = ci_observations(rest,created,last)
      +valid = within(a,b,created,Nat.add(created,last))
      Bool.pick(List<&2,Span>,valid,Span{Nat.sub(a,created),Nat.sub(b,created),"CI watcher observation"} <> tail,tail)

type PublishedFeed is Data:
  PublishedFeed{observed: Nat, traces: List<&2,Trace>, overview: List<&2,Trace>, from: Nat, as_of: Nat}

type Projection is Data:
  Projection{remaining: Nat, observed: Nat, traces: List<&2,Trace>, overview: List<&2,Trace>}

def include_trace(clocks: Clocks, +created: Nat, +updated: Nat, +from: Nat, +to: Nat,
  detail: List<&2,ProviderSpan>, ci: List<&2,CiPoll>, projection: Projection) -> Projection:
  match clocks projection:
    case Clocks{+last,+work,wait,errors} Projection{+remaining,+observed,+traces,+overview}:
      +known = Nat.is_lt(0n,last)
      +latest = Bool.and(known,Nat.is_lt(0n,remaining))
      +in_week = Bool.and(known,Bool.and(Nat.is_lt(created,to),Nat.is_lt(from,Nat.add(created,last))))
      +trace : Trace = Trace{created,last,work,wait,errors,provider_detail(detail,created,work),ci_observations(ci,created,last)}
      Projection{Bool.pick(Nat,latest,Nat.sub(remaining,1n),remaining),
        Bool.pick(Nat,latest,Nat.max(observed,updated),observed),
        Bool.pick(List<&2,Trace>,latest,trace <> traces,traces),
        Bool.pick(List<&2,Trace>,in_week,trace <> overview,overview)}

def collect(threads: List<&2,Thread>, +from: Nat, +to: Nat, projection: Projection) -> Projection:
  match threads:
    case []: projection
    case Thread{+created,+updated,runs,detail,ci} <> rest:
      +clocks = run_clocks(runs,created,updated,Clocks{0n,[],[],[]})
      collect(rest,from,to,include_trace(clocks,created,updated,from,to,detail,ci,projection))

def publish(projection: Projection, from: Nat, as_of: Nat) -> PublishedFeed:
  match projection:
    case Projection{_,observed,traces,overview}:
      PublishedFeed{observed,List.reverse(&2,Trace,traces),List.reverse(&2,Trace,overview),from,as_of}

def project_feed(threads: List<&2,Thread>, +as_of: Nat) -> PublishedFeed:
  +newest = List.sort(~Thread,~thread_before,threads)
  +from = Range.start("7d",as_of)
  publish(collect(newest,from,as_of,Projection{10n,0n,[],[]}),from,as_of)
