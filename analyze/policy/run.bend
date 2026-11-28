import Base

type Run is Data:
  Run{id: String, threadId: String, sessionId: String, startedMs: Nat, completedMs: Nat}

type ToolEvent is Data:
  ToolEvent{eventId: String, sessionId: String, callId: String, kind: String, timestampMs: Nat}

type Receipt is Data:
  Unseen{}
  Receipt{sessionId: String, callId: String, kind: String, timestampMs: Nat, in_scope: Bool}
  Collision{in_scope: Bool}

type Endpoint is Data:
  Missing{}
  Observed{eventId: String, at: Nat}
  Ambiguous{}

type Call is Data:
  Call{callId: String, start: Endpoint, end: Endpoint, collision: Bool, invalid: Bool}

type Interval is Data:
  Interval{callId: String, kind: String, startMs: Maybe<&2, Nat>, endMs: Maybe<&2, Nat>, durationMs: Maybe<&2, Nat>}

type Finding is Data:
  Finding{callId: String, reason: String}

type Report is Data:
  Rejected{}
  Report{runId: String, intervals: List<&2, Interval>, findings: List<&2, Finding>, events: Nat, paired: Nat, unknown: Nat}

def named(value: String) -> Bool:
  Bool.not(String.is_empty(value))

def in_scope(run: Run, event: ToolEvent) -> Bool:
  match run event:
    case Run{_, _, session, from, until} ToolEvent{_, owner, _, _, +at}:
      Bool.and(String.eq(session, owner), Bool.and(Nat.is_le(from, at), Nat.is_le(at, until)))

def receive(prior: Receipt, +session: String, +call: String, +kind: String, +at: Nat, +scoped: Bool) -> Receipt:
  match prior:
    case Unseen{}: Receipt{session, call, kind, at, scoped}
    case Collision{seen}: Collision{Bool.or(seen, scoped)}
    case Receipt{owner, previous_call, previous_kind, previous_at, seen}:
      +same = Bool.and(String.eq(owner, session), Bool.and(String.eq(previous_call, call),
        Bool.and(String.eq(previous_kind, kind), Nat.is_eq(previous_at, at))))
      +visible = Bool.or(seen, scoped)
      Bool.pick(Receipt, same, Receipt{session, call, kind, at, visible}, Collision{visible})

def index_event(entry: Map<&2, Receipt> & Receipt, id: String, session: String, call: String, kind: String, at: Nat, scoped: Bool) -> Map<&2, Receipt>:
  match entry:
    case (table, prior):
      Map.set(&2, Receipt, table, id, receive(prior, session, call, kind, at, scoped))

def index_events(+run: Run, +events: List<&2, ToolEvent>, +receipts: Map<&2, Receipt>) -> Map<&2, Receipt>:
  match events:
    case []: receipts
    case ToolEvent{+id, +session, +call, +kind, +at} <> rest:
      +scoped = in_scope(run, ToolEvent{id, session, call, kind, at})
      +updated = index_event(Map.get(Receipt, Unseen{}, receipts, id), id, session, call, kind, at, scoped)
      index_events(run, rest, updated)

def visible(receipt: Receipt) -> Bool:
  match receipt:
    case Unseen{}: False{}
    case Receipt{_, _, _, _, scoped}: scoped
    case Collision{scoped}: scoped

def event_count(receipts: List<&2, Receipt>, +count: Nat) -> Nat:
  match receipts:
    case []: count
    case receipt <> rest:
      event_count(rest, Bool.pick(Nat, visible(receipt), Nat.add(count, 1n), count))

def observe(endpoint: Endpoint, +id: String, +at: Nat) -> Endpoint:
  match endpoint:
    case Missing{}: Observed{id, at}
    case Ambiguous{}: Ambiguous{}
    case Observed{prior, _}:
      Bool.pick(Endpoint, String.eq(prior, id), Observed{id, at}, Ambiguous{})

def disputed(receipt: Receipt) -> Bool:
  match receipt:
    case Receipt{_, _, _, _, _}: False{}
    case _: True{}

def observe_call(+call: Call, +id: String, +kind: String, +at: Nat, receipt: Receipt) -> Call:
  match call:
    case Call{+key, +start, +end, +collision, +invalid}:
      +conflict = disputed(receipt)
      +valid_id = Bool.and(named(key), named(id))
      +start_kind = String.eq(kind, "function_call")
      +end_kind = String.eq(kind, "function_call_output")
      +trusted = Bool.and(valid_id, Bool.not(conflict))
      +next_start = Bool.pick(Endpoint, start_kind,
        Bool.pick(Endpoint, trusted, observe(start, id, at), Ambiguous{}), start)
      +next_end = Bool.pick(Endpoint, end_kind,
        Bool.pick(Endpoint, trusted, observe(end, id, at), Ambiguous{}), end)
      +unsupported = Bool.not(Bool.and(valid_id, Bool.or(start_kind, end_kind)))
      Call{key, next_start, next_end, Bool.or(collision, conflict), Bool.or(invalid, unsupported)}

def record_call(entry: Map<&2, Call> & Call, receipt: Map<&2, Receipt> & Receipt, key: String, id: String, kind: String, at: Nat) -> Map<&2, Call>:
  match entry:
    case (table, call):
      match receipt:
        case (_, observed):
          Map.set(&2, Call, table, key, observe_call(call, id, kind, at, observed))

def group_event(+receipts: Map<&2, Receipt>, +calls: Map<&2, Call>, event: ToolEvent) -> Map<&2, Call>:
  match event:
    case ToolEvent{+id, _, +key, kind, at}:
      record_call(Map.get(Call, Call{key, Missing{}, Missing{}, False{}, False{}}, calls, key),
        Map.get(Receipt, Unseen{}, receipts, id), key, id, kind, at)

def group_scoped(scoped: Bool, receipts: Map<&2, Receipt>, calls: Map<&2, Call>, event: ToolEvent) -> Map<&2, Call>:
  match scoped:
    case True{}: group_event(receipts, calls, event)
    case False{}: calls

def group_calls(+run: Run, +events: List<&2, ToolEvent>, +receipts: Map<&2, Receipt>, +calls: Map<&2, Call>) -> Map<&2, Call>:
  match events:
    case []: calls
    case +event <> rest:
      group_calls(run, rest, receipts, group_scoped(in_scope(run, event), receipts, calls, event))

def call_before(a: Call, b: Call) -> Bool:
  match a b:
    case Call{first, _, _, _, _} Call{second, _, _, _, _}: String.is_lt(first, second)

def clock_reason(start: Endpoint, end: Endpoint) -> String:
  match start end:
    case Ambiguous{} _: "ambiguous_start"
    case _ Ambiguous{}: "ambiguous_end"
    case Missing{} _: "missing_start"
    case _ Missing{}: "missing_end"
    case Observed{_, from} Observed{_, until}:
      Bool.pick(String, Nat.is_le(from, until), "", "reversed_clock")

def reason(start: Endpoint, end: Endpoint, collision: Bool, invalid: Bool) -> String:
  Bool.pick(String, collision, "conflicting_event_id",
    Bool.pick(String, invalid, "invalid_event", clock_reason(start, end)))

def clock(endpoint: Endpoint) -> Maybe<&2, Nat>:
  match endpoint:
    case Observed{_, at}: Some{at}
    case _: None{}

def duration(start: Endpoint, end: Endpoint, issue: String) -> Maybe<&2, Nat>:
  match start end:
    case Observed{_, from} Observed{_, until}:
      Bool.pick(Maybe<&2, Nat>, String.is_empty(issue), Some{Nat.sub(until, from)}, None{})
    case _ _: None{}

def summarize(calls: List<&2, Call>, +report: Report) -> Report:
  match calls report:
    case Call{+id, +start, +end, collision, invalid} <> rest Report{+run_id, +intervals, +findings, +events, +paired, +unknown}:
      +issue = reason(start, end, collision, invalid)
      +interval: Interval = Interval{id, "function_call", clock(start), clock(end), duration(start, end, issue)}
      summarize(rest, Bool.pick(Report, String.is_empty(issue),
        Report{run_id, interval <> intervals, findings, events, Nat.add(paired, 1n), unknown},
        Report{run_id, interval <> intervals, Finding{id, issue} <> findings, events, paired, Nat.add(unknown, 1n)}))
    case [] Report{run_id, intervals, findings, events, paired, unknown}:
      Report{run_id, List.reverse(&2, Interval, intervals), List.reverse(&2, Finding, findings), events, paired, unknown}
    case _ Rejected{}: Rejected{}

def analyze_valid(valid: Bool, +id: String, +run: Run, +events: List<&2, ToolEvent>) -> Report:
  match valid:
    case False{}: Rejected{}
    case True{}:
      +receipts = index_events(run, events, Map.new(&2, Receipt))
      +calls = group_calls(run, events, receipts, Map.new(&2, Call))
      +count = event_count(Map.values(&2, Receipt, receipts), 0n)
      summarize(List.sort(~Call, ~call_before, Map.values(&2, Call, calls)), Report{id, [], [], count, 0n, 0n})

def analyze(+run: Run, +events: List<&2, ToolEvent>) -> Report:
  match run:
    case Run{+id, thread, session, from, until}:
      +valid = Bool.and(Nat.is_le(from, until), Bool.and(named(id), Bool.and(named(thread), named(session))))
      analyze_valid(valid, id, run, events)

def evidence_gap(events: Nat) -> String:
  Bool.pick(String,Nat.is_eq(events,0n),"missing_events","")

type TraceMatch is Data:
  TraceMatch{id: String, session: String, turn: String, start: Nat, end: Nat}

type TraceLink is Data:
  TraceLink{id: String, start: Nat, end: Nat, gap: String}

def trace_candidates(+session: String,+turn: String,rows: List<&2,TraceMatch>,+prior: TraceLink) -> TraceLink:
  match rows prior:
    case [] _: prior
    case _ TraceLink{"",_,_,"incomplete"}: prior
    case TraceMatch{+id,owner,key,+a,+b} <> rest TraceLink{+prev,+x,+y,previous_gap}:
      +valid = Bool.and(Bool.and(named(id),Nat.is_lt(0n,a)),Bool.and(Nat.is_lt(a,b),
        Bool.and(String.eq(session,owner),String.eq(turn,key))))
      +same = Bool.or(String.is_empty(prev),Bool.and(String.eq(id,prev),Bool.and(Nat.is_eq(a,x),Nat.is_eq(b,y))))
      +next = Bool.pick(TraceLink,Bool.not(valid),TraceLink{"",0n,0n,"incomplete"},
        Bool.pick(TraceLink,Bool.and(same,Bool.not(String.eq(previous_gap,"ambiguous"))),
          TraceLink{id,a,b,""},TraceLink{"",0n,0n,"ambiguous"}))
      trace_candidates(session,turn,rest,next)

def trace(+session: String,+turn: String,complete: Bool,rows: List<&2,TraceMatch>) -> TraceLink:
  Bool.pick(TraceLink,Bool.and(complete,Bool.and(named(session),named(turn))),
    trace_candidates(session,turn,rows,TraceLink{"",0n,0n,"missing"}),TraceLink{"",0n,0n,"incomplete"})
