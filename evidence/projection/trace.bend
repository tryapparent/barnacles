import Base
import ./metrics.bend as Metrics
import ./trace-wire.bend as Wire

type Span is Data:
  Span{call: String, terminal: Maybe<&2, String>, line: Nat, tool: String, clock: String,
    start: Maybe<&2, Nat>, end: Maybe<&2, Nat>, attribution: Metrics.ProcessAttribution}

type Marker is Data:
  Marker{line: Nat, at: Nat}

type ResultClock is Data:
  ResultClock{at: Nat, line: Nat}

type Reasoning is Data:
  Reasoning{line: Nat, at: Nat, result_at: Nat, result_call_line: Nat}

type SessionKey is Data:
  SessionKey{instance: String, session: String}

type TraceSession is Data:
  TraceSession{identity: SessionKey, spans: List<&2, Span>, markers: List<&2, Marker>}

type Sessions is Data:
  Sessions{keys: List<&2, SessionKey>, groups: Map<&2, TraceSession>}

type TraceFacts is Data:
  TraceFacts{labels: Map<&2, String>, inputs: Map<&2, String>, results: Map<&2, ResultClock>, clean: Map<&2, Bool>}

def indexed(-A: Data, pair: Map<&2, A> & A) -> A:
  match pair:
    case (table, value): value

def key_part(+value: String) -> String:
  String.append(Nat.show(String.length(value)), String.append(":", value))

def session_key(identity: SessionKey) -> String:
  match identity:
    case SessionKey{instance, session}: String.append(key_part(instance), key_part(session))

def detail_key(identity: SessionKey, name: String, id: String) -> String:
  String.append(session_key(identity), String.append(key_part(name), id))

def empty_sessions() -> Sessions:
  Sessions{[], Map.new(&2, TraceSession)}

def empty_trace_facts() -> TraceFacts:
  TraceFacts{Map.new(&2, String), Map.new(&2, String), Map.new(&2, ResultClock), Map.new(&2, Bool)}

def note_trace_label(facts: TraceFacts, identity: SessionKey, name: String, id: String, value: String) -> TraceFacts:
  match facts:
    case TraceFacts{labels, inputs, results, clean}:
      TraceFacts{Map.set(&2, String, labels, detail_key(identity, name, id), value), inputs, results, clean}

def note_reasoning_input(facts: TraceFacts, identity: SessionKey, line: Nat, call: String) -> TraceFacts:
  match facts:
    case TraceFacts{labels, inputs, results, clean}:
      TraceFacts{labels, Map.set(&2, String, inputs, detail_key(identity, "reasoning", Nat.show(line)),
        String.append(":", call)), results, clean}

def note_result_clock(facts: TraceFacts, identity: SessionKey, call: String, result: ResultClock) -> TraceFacts:
  match facts:
    case TraceFacts{labels, inputs, results, clean}:
      TraceFacts{labels, inputs, Map.set(&2, ResultClock, results, detail_key(identity, "call", String.append(":", call)), result), clean}

def note_trace_rollout(facts: TraceFacts, identity: SessionKey, malformed: Nat, orphans: Nat) -> TraceFacts:
  match facts:
    case TraceFacts{labels, inputs, results, clean}:
      TraceFacts{labels, inputs, results, Map.set(&2, Bool, clean, session_key(identity), Metrics.rollout_clean(malformed, orphans))}

def add_session_key(keys: List<&2, SessionKey>, identity: SessionKey, spans: List<&2, Span>,
                    markers: List<&2, Marker>) -> List<&2, SessionKey>:
  match spans markers:
    case Nil{} Nil{}: identity <> keys
    case other_spans other_markers: keys

def prepend(-A: Data, tail: List<&2, A>, item: Maybe<&2, A>) -> List<&2, A>:
  match item:
    case None{}: tail
    case Some{head}: head <> tail

def session_add(found: Map<&2, TraceSession> & TraceSession, keys: List<&2, SessionKey>, +key: String,
                span: Maybe<&2, Span>, marker: Maybe<&2, Marker>) -> Sessions:
  match found:
    case (groups, TraceSession{+identity, +spans, +markers}):
      Sessions{add_session_key(keys, identity, spans, markers),
        Map.set(&2, TraceSession, groups, key, TraceSession{identity,
          prepend(Span, spans, span), prepend(Marker, markers, marker)})}

def note_session(sessions: Sessions, +identity: SessionKey, span: Maybe<&2, Span>, marker: Maybe<&2, Marker>) -> Sessions:
  match sessions:
    case Sessions{keys, groups}:
      +key = session_key(identity)
      session_add(Map.get(TraceSession, TraceSession{identity, [], []}, groups, key), keys, key, span, marker)

def note_trace_span(sessions: Sessions, identity: SessionKey, span: Span) -> Sessions:
  note_session(sessions, identity, Some{span}, None{})

def note_trace_marker(sessions: Sessions, identity: SessionKey, marker: Marker) -> Sessions:
  note_session(sessions, identity, None{}, Some{marker})

def trace_sessions(sessions: Sessions) -> List<&2, SessionKey>:
  match sessions:
    case Sessions{keys, groups}: List.reverse(&2, SessionKey, keys)

def reasoning_result(line: Nat, at: Nat, result: ResultClock) -> Reasoning:
  match result:
    case ResultClock{result_at, result_line}: Reasoning{line, at, result_at, result_line}

def resolve_marker(+identity: SessionKey, inputs: Map<&2, String>, +results: Map<&2, ResultClock>,
                   marker: Marker) -> Reasoning:
  match marker:
    case Marker{+line, at}:
      reasoning_result(line, at, indexed(ResultClock, Map.get(ResultClock, ResultClock{0n, 0n}, results,
        detail_key(identity, "call", indexed(String, Map.get(String, "", inputs, detail_key(identity, "reasoning", Nat.show(line))))))))

type Observation is Data:
  Observation{span: Span, command: String, categories: String, operation: String, clock: String}

type Measured is Data:
  Measured{call: String, terminal: Maybe<&2, String>, parent: Maybe<&2, String>, line: Nat, tool: String, command: String,
    categories: String, clock: String, start: Nat, end: Nat, name: String}

type Candidate is Data:
  Candidate{count: Nat, call: String, from: Nat, to: Nat}

type Recorded is Data:
  Recorded{observations: List<&2, Observation>, parents: Map<&2, Candidate>, bounds: Metrics.Focus,
    coverage: Metrics.SessionTiming}

type TraceResult is Data:
  TraceResult{observations: List<&2, Observation>, bounds: Metrics.Focus, spans: List<&2, Measured>,
    markers: List<&2, Reasoning>, estimates: List<&2, Reasoning>,
    coverage: Metrics.SessionTiming, reasoning_count: Nat}

def clock_time(value: Maybe<&2, Nat>) -> Nat:
  match value:
    case Some{time}: time
    case None{}: 0n

def default_candidate() -> Candidate:
  Candidate{0n, "", 0n, 0n}

def add_parent_found(found: Map<&2, Candidate> & Candidate, key: String, call: String, start: Nat, end: Nat) ->
    Map<&2, Candidate>:
  match found:
    case (table, Candidate{count, old_call, old_start, old_end}):
      Map.set(&2, Candidate, table, key, Candidate{Nat.add(count, 1n), call, start, end})

def add_parent(parents: Map<&2, Candidate>, +key: String, call: String, start: Nat, end: Nat) -> Map<&2, Candidate>:
  add_parent_found(Map.get(Candidate, default_candidate(), parents, key), key, call, start, end)

def add_parent_pair(terminal: Maybe<&2, String>, parents: Map<&2, Candidate>, +call: String, +start: Nat, +end: Nat) ->
    Map<&2, Candidate>:
  match terminal:
    case None{}: parents
    case Some{wait}: add_parent(add_parent(parents, call, call, start, end), wait, call, start, end)

def trace_observation(state: Recorded, +span: Span, +command: String, +categories: String) -> Recorded:
  match state span:
    case Recorded{observations, +parents, +bounds, coverage} Span{call, terminal, line, tool, +clock, start, end, attribution}:
      +a = clock_time(start)
      +b = clock_time(end)
      +valid = Metrics.interval_valid(a, b)
      Recorded{Observation{span, command, categories, Metrics.trace_operation(clock, tool, command, categories),
        Metrics.interval_clock(clock)} <> observations,
        Bool.pick(Map<&2, Candidate>, valid, add_parent_pair(terminal, parents, call, a, b), parents),
        Bool.pick(Metrics.Focus, valid, Metrics.extend_window(bounds, a, b), bounds),
        Metrics.session_timing_observe(coverage, clock, a, b)}

def resolve_span(state: Recorded, +span: Span, +identity: SessionKey, +labels: Map<&2, String>) -> Recorded:
  match span:
    case Span{+call, terminal, line, tool, clock, start, end, attribution}:
      trace_observation(state, span,
        indexed(String, Map.get(String, "", labels, detail_key(identity, "command", call))),
        indexed(String, Map.get(String, "", labels, detail_key(identity, "categories", call))))

def record_spans(spans: List<&2, Span>, state: Recorded, +identity: SessionKey, +labels: Map<&2, String>) -> Recorded:
  match spans:
    case []: state
    case Con{+span, tail}:
      record_spans(tail, resolve_span(state, span, identity, labels), identity, labels)

def span_parent(candidate: Candidate, clock: String, start: Nat, end: Nat) -> Maybe<&2, String>:
  match candidate:
    case Candidate{count, call, from, to}:
      Bool.pick(Maybe<&2, String>, Metrics.trace_parent(clock, count, start, end, from, to), Some{call}, None{})

def measured_add(valid: Bool, spans: List<&2, Measured>, candidate: Candidate, call: String, terminal: Maybe<&2, String>, line: Nat, +tool: String,
                 +command: String, +categories: String, +clock: String, +start: Nat, +end: Nat) -> List<&2, Measured>:
  match valid:
    case False{}: spans
    case True{}:
      Measured{call, terminal, span_parent(candidate, clock, start, end), line, tool, command, categories, clock, start, end,
        Metrics.trace_span_name(clock, tool, command, categories)} <> spans

def complete_spans(reversed: List<&2, Observation>, spans: List<&2, Measured>, +parents: Map<&2, Candidate>) ->
    List<&2, Measured>:
  match reversed:
    case []: spans
    case Observation{Span{+call, terminal, line, tool, clock, start, end, attribution}, command, categories, operation, label} <> tail:
      +a = clock_time(start)
      +b = clock_time(end)
      complete_spans(tail, measured_add(Metrics.interval_valid(a, b), spans,
        indexed(Candidate, Map.get(Candidate, default_candidate(), parents, call)),
        call, terminal, line, tool, command, categories, clock, a, b), parents)

type ReasoningScan is Data:
  ReasoningScan{remaining: List<&2, Span>, activity: Metrics.ActivityScan}

def span_activity(span: Span, scan: Metrics.ActivityScan, until: Nat) -> Metrics.ActivityStep:
  match span:
    case Span{call, terminal, line, tool, clock, start, end, attribution}:
      Metrics.scan_activity(scan, clock_time(start), clock_time(end), until)

def next_activity(spans: List<&2, Span>, scan: Metrics.ActivityScan, until: Nat) -> Metrics.ActivityStep:
  match spans:
    case []: Metrics.Hold{}
    case head <> tail: span_activity(head, scan, until)

def scan_until(+spans: List<&2, Span>, +scan: Metrics.ActivityScan, step: Metrics.ActivityStep, +until: Nat) -> ReasoningScan:
  match spans step:
    case Nil{} otherwise: ReasoningScan{spans, scan}
    case Con{head, tail} Metrics.Hold{}: ReasoningScan{spans, scan}
    case Con{head, +tail} Metrics.Advance{+next}: scan_until(tail, next, next_activity(tail, next, until), until)

type ReasoningProjection is Data:
  ReasoningProjection{bounds: Metrics.Focus, markers: List<&2, Reasoning>, estimates: List<&2, Reasoning>, count: Nat}

type ReasoningProgress is Data:
  ReasoningProgress{scan: ReasoningScan, projection: ReasoningProjection}

def record_marker(+next: ReasoningScan, +event: Reasoning, state: ReasoningProjection, clean: Bool) -> ReasoningProgress:
  match next event state:
    case ReasoningScan{spans, activity} Reasoning{line, +at, result_at, result_call_line} ReasoningProjection{bounds, markers, +estimates, count}:
      ReasoningProgress{next, ReasoningProjection{Metrics.extend_window(bounds, at, at), event <> markers,
        Bool.pick(List<&2, Reasoning>, Metrics.estimate_model_wait(clean, result_at, at, activity),
          event <> estimates, estimates), Nat.add(count, 1n)}}

def marker_time(marker: Marker) -> Nat:
  match marker:
    case Marker{line, at}: at

def record_markers(markers: List<&2, Marker>, progress: ReasoningProgress, +clean: Bool,
                   +identity: SessionKey, +inputs: Map<&2, String>, +results: Map<&2, ResultClock>) -> ReasoningProjection:
  match markers progress:
    case Nil{} ReasoningProgress{scan, state}: state
    case Con{+marker, tail} ReasoningProgress{ReasoningScan{+spans, +activity}, state}:
      +until = marker_time(marker)
      record_markers(tail, record_marker(scan_until(spans, activity, next_activity(spans, activity, until), until),
        resolve_marker(identity, inputs, results, marker), state, clean), clean, identity, inputs, results)

def trace_result(recorded: Recorded, reasoning: ReasoningProjection) -> TraceResult:
  match recorded reasoning:
    case Recorded{+observations, parents, old_bounds, coverage} ReasoningProjection{bounds, markers, estimates, count}:
      TraceResult{List.reverse(&2, Observation, observations), bounds, complete_spans(observations, [], parents),
        List.reverse(&2, Reasoning, markers), List.reverse(&2, Reasoning, estimates), coverage, count}

def trace_bounds(recorded: Recorded) -> Metrics.Focus:
  match recorded:
    case Recorded{observations, parents, bounds, coverage}: bounds

def trace_session_result(session: TraceSession, facts: TraceFacts) -> TraceResult:
  match session facts:
    case TraceSession{+identity, spans, markers} TraceFacts{labels, inputs, results, clean}:
      +ordered = List.reverse(&2, Span, spans)
      +recorded = record_spans(ordered, Recorded{[], Map.new(&2, Candidate), Metrics.Window{0n, 0n},
        Metrics.empty_session_timing()}, identity, labels)
      trace_result(recorded, record_markers(List.reverse(&2, Marker, markers),
        ReasoningProgress{ReasoningScan{ordered, Metrics.Scan{0n, False{}}}, ReasoningProjection{trace_bounds(recorded), [], [], 0n}},
        indexed(Bool, Map.get(Bool, False{}, clean, session_key(identity))), identity, inputs, results))

def project_trace(sessions: Sessions, +identity: SessionKey, facts: TraceFacts) -> TraceResult:
  match sessions:
    case Sessions{keys, groups}:
      trace_session_result(indexed(TraceSession, Map.get(TraceSession, TraceSession{identity, [], []}, groups,
        session_key(identity))), facts)

type TraceChoice is Data:
  TraceChoice{session: Nat, trace_id: String, from: Nat, to: Nat, mixed: Bool}

def empty_trace_choice() -> TraceChoice:
  TraceChoice{0n, "", 0n, 0n, False{}}

def choose_trace(+best: TraceChoice, session: Nat, +trace_id: String, bounds: Metrics.Focus, timing: Metrics.SessionTiming,
                 count: Nat) -> TraceChoice:
  match best bounds timing:
    case TraceChoice{old_session, old_id, old_from, old_to, old_mixed} Metrics.Window{from, +to}
         Metrics.SessionTiming{envelopes, Metrics.Stats{cells, total, missing}}:
      +mixed = Metrics.trace_preference(cells, count)
      Bool.pick(TraceChoice, Bool.and(Bool.not(String.eq(trace_id, "")), Metrics.trace_preferred(to, mixed, old_to, old_mixed)),
        TraceChoice{session, trace_id, from, to, mixed}, best)

def otlp_nanos(+ms: Nat) -> String:
  Bool.pick(String, Nat.is_eq(ms, 0n), "0", String.append(Nat.show(ms), "000000"))

def trace_event(marker: Reasoning) -> Wire.TraceEvent:
  match marker:
    case Reasoning{line, at, result_at, result_call_line}:
      Wire.Event{"Reasoning recorded", otlp_nanos(at), [Wire.IntAttribute{"barnacles.source_line", Nat.show(line)}]}

def trace_events(markers: List<&2, Reasoning>, output: List<&2, Wire.TraceEvent>) -> List<&2, Wire.TraceEvent>:
  match markers:
    case []: output
    case marker <> tail: trace_events(tail, trace_event(marker) <> output)

def root_id(key: String) -> List<&2, String>:
  ["barnacles-codex-window", key]

def measured_id(key: String, call: String, clock: String) -> List<&2, String>:
  ["barnacles-codex-span", key, call, clock]

def parent_id(+key: String, parent: Maybe<&2, String>) -> List<&2, String>:
  match parent:
    case None{}: root_id(key)
    case Some{call}: measured_id(key, call, "async_cell")

def measured_attributes(+clock: String, line: Nat, +command: String, +categories: String, tool: String) ->
    List<&2, Wire.TraceAttribute>:
  +category_fields = Bool.pick(List<&2, Wire.TraceAttribute>, String.eq(categories, ""), [],
    [Wire.TextAttribute{"barnacles.categories", categories}, Wire.TextAttribute{"barnacles.tool", tool}])
  Wire.TextAttribute{"barnacles.clock", clock} <> Wire.IntAttribute{"barnacles.source_line", Nat.show(line)} <>
    Bool.pick(List<&2, Wire.TraceAttribute>, String.eq(command, ""), category_fields,
      Wire.TextAttribute{"barnacles.submitted_command", command} <> category_fields)

def trace_measured(+key: String, span: Measured) -> Wire.TraceWireSpan:
  match span:
    case Measured{call, terminal, parent, line, tool, command, categories, +clock, start, end, name}:
      Wire.WireSpan{measured_id(key, call, clock), Some{parent_id(key, parent)}, name, 1, otlp_nanos(start), otlp_nanos(end),
        measured_attributes(clock, line, command, categories, tool), None{}}

def trace_estimate(+key: String, marker: Reasoning) -> Wire.TraceWireSpan:
  match marker:
    case Reasoning{+line, at, result_at, result_call_line}:
      Wire.WireSpan{["barnacles-model-wait-estimate", key, Nat.show(line)], Some{root_id(key)}, "Estimated model wait", 1,
        otlp_nanos(result_at), otlp_nanos(at), [Wire.TextAttribute{"barnacles.clock", "model_wait_estimate"},
          Wire.TextAttribute{"barnacles.estimate_basis", "Tool result to recorded reasoning"},
          Wire.IntAttribute{"barnacles.tool_call_line", Nat.show(result_call_line)},
          Wire.IntAttribute{"barnacles.reasoning_line", Nat.show(line)}], None{}}

def trace_estimates(+key: String, estimates: List<&2, Reasoning>, output: List<&2, Wire.TraceWireSpan>) -> List<&2, Wire.TraceWireSpan>:
  match estimates:
    case []: output
    case marker <> tail: trace_estimates(key, tail, trace_estimate(key, marker) <> output)

def trace_wire_spans(+key: String, spans: List<&2, Measured>, output: List<&2, Wire.TraceWireSpan>) -> List<&2, Wire.TraceWireSpan>:
  match spans:
    case []: output
    case span <> tail: trace_wire_spans(key, tail, trace_measured(key, span) <> output)

def trace_wire(+key: String, result: TraceResult) -> Wire.TraceWire:
  match result:
    case TraceResult{observations, Metrics.Window{from, to}, spans, markers, estimates, coverage, reasoning_count}:
      root : Wire.TraceWireSpan = Wire.WireSpan{root_id(key), None{}, "Recorded session window", 1, otlp_nanos(from), otlp_nanos(to),
        [Wire.TextAttribute{"barnacles.clock", "observation_window"}], Some{trace_events(List.reverse(&2, Reasoning, markers), [])}}
      Wire.WireTrace{["barnacles-codex-trace", key], [Wire.TextAttribute{"service.name", "codex"}], "barnacles",
        root <> trace_wire_spans(key, List.reverse(&2, Measured, spans),
          trace_estimates(key, List.reverse(&2, Reasoning, estimates), []))}
