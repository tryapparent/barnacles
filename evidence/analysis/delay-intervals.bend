import Base

type Blocker is Data:
  Blocker{occurrence: String, pattern: String, condition: String, scope: String, fromMs: Nat, untilMs: Nat,
    pending: String, released: String}

type DelayWindow is Data:
  DelayWindow{id: String, outcome: String, scope: String, stage: String, basis: String, readyMs: Nat, possibleMs: Nat,
    readiness: String, availability: String, blockers: List<&2, Blocker>}

type Condition is Data:
  Condition{id: String, pattern: String}

type Span is Data:
  Span{fromMs: Nat, untilMs: Nat, conditions: List<&2, Condition>}

type Outcome is Data:
  Outcome{id: String, scope: String, stage: String, spans: List<&2, Span>, confirmedMs: Maybe<&2, Nat>, sharedMs: Maybe<&2, Nat>}

type Evidence is Data:
  Evidence{window: DelayWindow, measured: Bool}

def key(+first: String, second: String) -> String:
  String.append(Nat.show(String.length(first)), String.append(":", String.append(first, second)))

def named(value: String) -> Bool:
  Bool.not(String.is_empty(value))

def before(a: Nat, b: Nat) -> Bool:
  Nat.is_lt(a, b)

def boundaries(blockers: List<&2, Blocker>) -> List<&2, Nat>:
  match blockers:
    case []: []
    case Blocker{_, _, _, _, from, until, _, _} <> rest: from <> until <> boundaries(rest)

def active(blockers: List<&2, Blocker>, +from: Nat, +until: Nat, +conditions: Map<&2, Condition>) -> List<&2, Condition>:
  match blockers:
    case []: Map.values(&2, Condition, conditions)
    case Blocker{_, pattern, +condition, _, start, end, _, _} <> rest:
      +includes = Bool.and(Nat.is_le(start, from), Nat.is_le(until, end))
      +updated = Bool.pick(Map<&2, Condition>, includes,
        Map.set(&2, Condition, conditions, condition, Condition{condition, pattern}), conditions)
      active(rest, from, until, updated)

def add_span(from: Nat, until: Nat, conditions: List<&2, Condition>, rest: List<&2, Span>) -> List<&2, Span>:
  match conditions:
    case []: rest
    case head <> tail: Span{from, until, head <> tail} <> rest

def sweep(+time: List<&2, Nat>, +blockers: List<&2, Blocker>) -> List<&2, Span>:
  match time:
    case +from <> +until <> +later:
      +rest = sweep(until <> later, blockers)
      Bool.pick(List<&2, Span>, Nat.is_lt(from, until),
        add_span(from, until, active(blockers, from, until, Map.new(&2, Condition)), rest), rest)
    case _: []

def spans(+blockers: List<&2, Blocker>) -> List<&2, Span>:
  sweep(List.sort(~Nat, ~before, boundaries(blockers)), blockers)

def confirmed(spans: List<&2, Span>) -> Nat:
  match spans:
    case []: 0n
    case Span{from, until, _} <> rest: Nat.add(Nat.sub(until, from), confirmed(rest))

def shared(spans: List<&2, Span>) -> Nat:
  match spans:
    case []: 0n
    case Span{from, until, conditions} <> rest:
      match conditions:
        case _ <> _ <> _: Nat.add(Nat.sub(until, from), shared(rest))
        case _: shared(rest)

def same_condition_pattern(+id: String, +pattern: String, others: List<&2, Blocker>) -> Bool:
  match others:
    case []: True{}
    case Blocker{_, other_pattern, other_id, _, _, _, _, _} <> rest:
      Bool.and(Bool.or(Bool.not(String.eq(id, other_id)), String.eq(pattern, other_pattern)), same_condition_pattern(id, pattern, rest))

def consistent(blockers: List<&2, Blocker>) -> Bool:
  match blockers:
    case []: True{}
    case Blocker{_, pattern, condition, _, _, _, _, _} <> +rest:
      Bool.and(same_condition_pattern(condition, pattern, rest), consistent(rest))

def valid_blockers(blockers: List<&2, Blocker>, +scope: String, +ready: Nat, +possible: Nat) -> Bool:
  match blockers:
    case []: True{}
    case Blocker{_, _, condition, exact, +from, +until, pending, released} <> rest:
      +binding = Bool.and(String.eq(scope, exact), Bool.and(named(condition), Bool.and(named(pending), named(released))))
      +clock = Bool.and(Nat.is_lt(0n, from), Bool.and(Nat.is_lt(from, until),
        Bool.and(Nat.is_lt(ready, until), Nat.is_le(until, possible))))
      Bool.and(Bool.and(binding, clock), valid_blockers(rest, scope, ready, possible))

def clip(blockers: List<&2, Blocker>, +ready: Nat) -> List<&2, Blocker>:
  match blockers:
    case []: []
    case Blocker{id, pattern, condition, scope, from, until, pending, released} <> rest:
      Blocker{id, pattern, condition, scope, Nat.max(from, ready), until, pending, released} <> clip(rest, ready)

def measured(window: DelayWindow) -> List<&2, Blocker>:
  match window:
    case DelayWindow{_, _, +scope, _, +basis, +ready, +possible, readiness, availability, +blockers}:
      +proof = Bool.and(Bool.or(String.eq(basis, "exact-revision"), String.eq(basis, "exact-dependency")),
        Bool.and(named(scope), Bool.and(named(readiness), named(availability))))
      +clock = Bool.and(Nat.is_lt(0n, ready), Nat.is_lt(ready, possible))
      +valid = Bool.and(proof, Bool.and(clock, Bool.and(valid_blockers(blockers, scope, ready, possible), consistent(blockers))))
      +clipped = clip(blockers, ready)
      +covered = Nat.is_eq(confirmed(spans(clipped)), Nat.sub(possible, ready))
      Bool.pick(List<&2, Blocker>, Bool.and(valid, covered), clipped, [])

def outcome_key(window: DelayWindow) -> String:
  match window:
    case DelayWindow{_, id, scope, stage, _, _, _, _, _, _}: key(id, key(scope, stage))

def window_blockers(window: DelayWindow) -> List<&2, Blocker>:
  match window:
    case DelayWindow{_, _, _, _, _, _, _, _, _, blockers}: blockers

type Candidate is Data:
  Candidate{window: DelayWindow, admitted: List<&2, Blocker>}

type WindowSet is Data:
  WindowSet{seen: Map<&2, String>, rows: List<&2, DelayWindow>, consistent: Bool}

def join_fields(fields: List<&2, String>) -> String:
  match fields:
    case []: ""
    case head <> rest: key(head, join_fields(rest))

def blocker_receipts(blockers: List<&2, Blocker>) -> String:
  match blockers:
    case []: ""
    case Blocker{id, pattern, condition, scope, from, until, pending, released} <> rest:
      key(join_fields([id, pattern, condition, scope, Nat.show(from), Nat.show(until), pending, released]), blocker_receipts(rest))

def window_receipt(window: DelayWindow) -> String:
  match window:
    case DelayWindow{_, _, _, _, basis, ready, possible, readiness, availability, blockers}:
      join_fields([basis, Nat.show(ready), Nat.show(possible), readiness, availability, blocker_receipts(blockers)])

def retain_window(pair: Map<&2, String> & String, +id: String, +receipt: String, +window: DelayWindow,
  +rows: List<&2, DelayWindow>, +valid: Bool) -> WindowSet:
  match pair:
    case (+seen, +prior):
      +fresh = String.is_empty(prior)
      +same = String.eq(prior, receipt)
      WindowSet{Bool.pick(Map<&2, String>, fresh, Map.set(&2, String, seen, id, receipt), seen),
        Bool.pick(List<&2, DelayWindow>, same, rows, window <> rows), Bool.and(valid, Bool.or(fresh, same))}

def dedup_window(+window: DelayWindow, state: WindowSet) -> WindowSet:
  match window state:
    case DelayWindow{+id, _, _, _, _, _, _, _, _, _} WindowSet{seen, rows, valid}:
      retain_window(Map.get(String, "", seen, id), id, window_receipt(window), window, rows, valid)

def unique_windows(windows: List<&2, DelayWindow>, state: WindowSet) -> WindowSet:
  match windows:
    case []: state
    case window <> rest: unique_windows(rest, dedup_window(window, state))

def candidates(windows: List<&2, DelayWindow>) -> List<&2, Candidate>:
  match windows:
    case []: []
    case +window <> rest: Candidate{window, measured(window)} <> candidates(rest)

def accepted(candidates: List<&2, Candidate>) -> List<&2, Blocker>:
  match candidates:
    case []: []
    case Candidate{_, blockers} <> rest: List.concat(&2, Blocker, [blockers, accepted(rest)])

def evidence(candidates: List<&2, Candidate>, +valid: Bool) -> List<&2, Evidence>:
  match candidates:
    case []: []
    case Candidate{window, blockers} <> rest:
      Evidence{window, Bool.and(valid, Nat.is_lt(0n, List.length(&2, Blocker, blockers)))} <> evidence(rest, valid)

def optional(value: Nat, measured: Bool) -> Maybe<&2, Nat>:
  Bool.pick(Maybe<&2, Nat>, measured, Some{value}, None{})

def summarize(window: DelayWindow, +spans: List<&2, Span>) -> Outcome:
  match window:
    case DelayWindow{_, id, scope, stage, _, _, _, _, _, _}:
      +known = Nat.is_lt(0n, List.length(&2, Span, spans))
      Outcome{id, scope, stage, spans, optional(confirmed(spans), known), optional(shared(spans), known)}

def measure_unique(windows: List<&2, DelayWindow>, proof: Bool) -> Outcome & List<&2, Evidence>:
  match windows:
    case []: (Outcome{"", "", "", [], None{}, None{}}, [])
    case +head <> tail:
      +instances = candidates(head <> tail)
      +blockers = accepted(instances)
      +valid = Bool.and(proof, consistent(blockers))
      (summarize(head, Bool.pick(List<&2, Span>, valid, spans(blockers), [])), evidence(instances, valid))

def verify_window_set(state: WindowSet) -> Outcome & List<&2, Evidence>:
  match state:
    case WindowSet{_, rows, valid}: measure_unique(rows, valid)

def measure_outcome(windows: List<&2, DelayWindow>) -> Outcome & List<&2, Evidence>:
  verify_window_set(unique_windows(windows, WindowSet{Map.new(&2, String), [], True{}}))

def insert_window(pair: Map<&2, List<&2, DelayWindow>> & List<&2, DelayWindow>, id: String, window: DelayWindow) -> Map<&2, List<&2, DelayWindow>>:
  match pair:
    case (table, current): Map.set(&2, List<&2, DelayWindow>, table, id, window <> current)

def store_window(windows: Map<&2, List<&2, DelayWindow>>, +window: DelayWindow) -> Map<&2, List<&2, DelayWindow>>:
  +id = outcome_key(window)
  insert_window(Map.get(List<&2, DelayWindow>, [], windows, id), id, window)
