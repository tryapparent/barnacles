import Base
import ./delay-intervals.bend as Delay

type Occurrence is Data:
  Occurrence{pattern: String, stage: String, measured: Bool}

type Coverage is Data:
  Coverage{occurrences: Nat, sufficient: Nat}

type Impact is Data:
  Impact{pattern: String, stage: String, coverage: Coverage, affectedOutcomes: Nat, uniqueMs: Maybe<&2, Nat>, medianMs: Maybe<&2, Nat>, worstMs: Maybe<&2, Nat>}

type Totals is Data:
  Totals{coverage: Coverage, affectedOutcomes: Nat, confirmedMs: Maybe<&2, Nat>, sharedMs: Maybe<&2, Nat>, medianMs: Maybe<&2, Nat>, worstMs: Maybe<&2, Nat>}

type Report is Data:
  Report{totals: Totals, outcomes: List<&2, Delay.Outcome>, patterns: List<&2, Impact>, evidence: List<&2, Delay.Evidence>}

type Pattern is Data:
  Pattern{label: String, stage: String, coverage: Coverage, times: List<&2, Nat>}

type PatternTime is Data:
  PatternTime{pattern: String, milliseconds: Nat}

type Replay is Data:
  Replay{outcomes: List<&2, Delay.Outcome>, evidence: List<&2, Delay.Evidence>}

def scan(windows: List<&2, Delay.DelayWindow>, table: Map<&2, List<&2, Delay.DelayWindow>>) -> Map<&2, List<&2, Delay.DelayWindow>>:
  match windows:
    case []: table
    case window <> rest: scan(rest, Delay.store_window(table, window))

def add_outcome(pair: Delay.Outcome & List<&2, Delay.Evidence>, outcomes: List<&2, Delay.Outcome>, evidence: List<&2, Delay.Evidence>) -> Replay:
  match pair:
    case (outcome, windows): Replay{outcome <> outcomes, List.concat(&2, Delay.Evidence, [windows, evidence])}

def measure(groups: List<&2, List<&2, Delay.DelayWindow>>, replay: Replay) -> Replay:
  match groups replay:
    case [] _: replay
    case group <> rest Replay{outcomes, evidence}:
      measure(rest, add_outcome(Delay.measure_outcome(group), outcomes, evidence))

def put_occurrence(pair: Map<&2, Occurrence> & Occurrence, id: String, pattern: String, measured: Bool) -> Map<&2, Occurrence>:
  match pair:
    case (updated, Occurrence{_, kind, prior}): Map.set(&2, Occurrence, updated, id, Occurrence{pattern, kind, Bool.or(prior, measured)})

def record_occurrence(table: Map<&2, Occurrence>, +id: String, +pattern: String, stage: String, measured: Bool) -> Map<&2, Occurrence>:
  put_occurrence(Map.get(Occurrence, Occurrence{pattern, stage, False{}}, table, id), id, pattern, measured)

def count_blockers(blockers: List<&2, Delay.Blocker>, +outcome: String, +stage: String, +measured: Bool,
  table: Map<&2, Occurrence>) -> Map<&2, Occurrence>:
  match blockers:
    case []: table
    case Delay.Blocker{id, +pattern, _, _, _, _, _, _} <> rest:
      +key = Delay.key(outcome, Delay.key(pattern, id))
      count_blockers(rest, outcome, stage, measured, record_occurrence(table, key, pattern, stage, measured))

def count_evidence(evidence: List<&2, Delay.Evidence>, table: Map<&2, Occurrence>) -> Map<&2, Occurrence>:
  match evidence:
    case []: table
    case Delay.Evidence{+window, measured} <> rest:
      match window:
        case Delay.DelayWindow{_, _, _, stage, _, _, _, _, _, blockers}:
          count_evidence(rest, count_blockers(blockers, Delay.outcome_key(window), stage, measured, table))

def increase(coverage: Coverage, measured: Bool) -> Coverage:
  match coverage:
    case Coverage{all, known}: Coverage{Nat.add(all, 1n), Nat.add(known, Bool.pick(Nat, measured, 1n, 0n))}

def coverage(occurrences: List<&2, Occurrence>, total: Coverage) -> Coverage:
  match occurrences:
    case []: total
    case Occurrence{_, _, measured} <> rest: coverage(rest, increase(total, measured))

def count_pattern(pair: Map<&2, Pattern> & Pattern, key: String, measured: Bool) -> Map<&2, Pattern>:
  match pair:
    case (updated, Pattern{label, kind, total, times}):
      Map.set(&2, Pattern, updated, key, Pattern{label, kind, increase(total, measured), times})

def add_pattern(table: Map<&2, Pattern>, +pattern: String, +stage: String, measured: Bool) -> Map<&2, Pattern>:
  +key = Delay.key(stage, pattern)
  count_pattern(Map.get(Pattern, Pattern{pattern, stage, Coverage{0n, 0n}, []}, table, key), key, measured)

def group_patterns(occurrences: List<&2, Occurrence>, table: Map<&2, Pattern>) -> Map<&2, Pattern>:
  match occurrences:
    case []: table
    case Occurrence{pattern, stage, measured} <> rest: group_patterns(rest, add_pattern(table, pattern, stage, measured))

def add_time(pair: Map<&2, PatternTime> & PatternTime, key: String, amount: Nat) -> Map<&2, PatternTime>:
  match pair:
    case (table, PatternTime{pattern, current}): Map.set(&2, PatternTime, table, key, PatternTime{pattern, Nat.add(current, amount)})

def note_times(conditions: List<&2, Delay.Condition>, +amount: Nat, times: Map<&2, PatternTime>) -> Map<&2, PatternTime>:
  match conditions:
    case []: times
    case Delay.Condition{_, +pattern} <> rest:
      note_times(rest, amount, add_time(Map.get(PatternTime, PatternTime{pattern, 0n}, times, pattern), pattern, amount))

def outcome_times(spans: List<&2, Delay.Span>, times: Map<&2, PatternTime>) -> Map<&2, PatternTime>:
  match spans:
    case []: times
    case Delay.Span{from, until, +conditions} <> rest:
      +exclusive = Nat.is_eq(List.length(&2, Delay.Condition, conditions), 1n)
      +amount = Bool.pick(Nat, exclusive, Nat.sub(until, from), 0n)
      outcome_times(rest, note_times(conditions, amount, times))

def add_pattern_time(pair: Map<&2, Pattern> & Pattern, key: String, value: Nat) -> Map<&2, Pattern>:
  match pair:
    case (updated, Pattern{pattern, kind, measured, previous}):
      Map.set(&2, Pattern, updated, key, Pattern{pattern, kind, measured, value <> previous})

def add_times(times: List<&2, PatternTime>, +stage: String, table: Map<&2, Pattern>) -> Map<&2, Pattern>:
  match times:
    case []: table
    case PatternTime{+label, value} <> rest:
      +key = Delay.key(stage, label)
      add_times(rest, stage, add_pattern_time(Map.get(Pattern, Pattern{label, stage, Coverage{0n, 0n}, []}, table, key), key, value))

def tally(outcomes: List<&2, Delay.Outcome>, table: Map<&2, Pattern>) -> Map<&2, Pattern>:
  match outcomes:
    case []: table
    case Delay.Outcome{_, _, stage, spans, _, _} <> rest:
      tally(rest, add_times(Map.values(&2, PatternTime, outcome_times(spans, Map.new(&2, PatternTime))), stage, table))

def nth(values: List<&2, Nat>, index: Nat) -> Nat:
  match values index:
    case [] _: 0n
    case head <> _ 0n: head
    case _ <> rest 1n+later: nth(rest, later)

def median(+values: List<&2, Nat>, +length: Nat) -> Maybe<&2, Nat>:
  +sorted = List.sort(~Nat, ~Delay.before, values)
  +mid = Nat.div(length, 2n)
  +left = nth(sorted, Nat.div(Nat.sub(length, 1n), 2n))
  +right = nth(sorted, mid)
  Bool.pick(Maybe<&2, Nat>, Nat.is_eq(length, 0n), None{}, Some{Nat.add(left, Nat.div(Nat.sub(right, left), 2n))})

def worst(+values: List<&2, Nat>, +length: Nat) -> Maybe<&2, Nat>:
  Bool.pick(Maybe<&2, Nat>, Nat.is_eq(length, 0n), None{}, Some{nth(List.sort(~Nat, ~Delay.before, values), Nat.sub(length, 1n))})

def sum(values: List<&2, Nat>) -> Nat:
  match values:
    case []: 0n
    case head <> rest: Nat.add(head, sum(rest))

def impact(row: Pattern) -> Impact:
  match row:
    case Pattern{label, stage, coverage, +times}:
      +count = List.length(&2, Nat, times)
      Impact{label, stage, coverage, count, Delay.optional(sum(times), Nat.is_lt(0n, count)), median(times, count), worst(times, count)}

def impact_rows(patterns: List<&2, Pattern>) -> List<&2, Impact>:
  match patterns:
    case []: []
    case head <> rest: impact(head) <> impact_rows(rest)

def impact_order(a: Maybe<&2, Nat>, b: Maybe<&2, Nat>, ac: Nat, bc: Nat) -> Bool:
  match a b:
    case Some{+left} Some{+right}:
      Bool.or(Nat.is_lt(right, left), Bool.and(Nat.is_eq(left, right), Nat.is_lt(bc, ac)))
    case Some{_} None{}: True{}
    case None{} _: False{}

def preceding(a: Impact, b: Impact) -> Bool:
  match a b:
    case Impact{_, _, _, ac, am, _, _} Impact{_, _, _, bc, bm, _, _}:
      impact_order(am, bm, ac, bc)

def confirmed_times(outcomes: List<&2, Delay.Outcome>) -> List<&2, Nat>:
  match outcomes:
    case []: []
    case Delay.Outcome{_, _, _, _, value, _} <> rest:
      match value:
        case None{}: confirmed_times(rest)
        case Some{time}: time <> confirmed_times(rest)

def shared_total(outcomes: List<&2, Delay.Outcome>) -> Nat:
  match outcomes:
    case []: 0n
    case Delay.Outcome{_, _, _, _, _, amount} <> rest:
      match amount:
        case None{}: shared_total(rest)
        case Some{time}: Nat.add(time, shared_total(rest))

def report(+outcomes: List<&2, Delay.Outcome>, +evidence: List<&2, Delay.Evidence>) -> Report:
  +occurrences = Map.values(&2, Occurrence, count_evidence(evidence, Map.new(&2, Occurrence)))
  +patterns = tally(outcomes, group_patterns(occurrences, Map.new(&2, Pattern)))
  +impacts = impact_rows(Map.values(&2, Pattern, patterns))
  +times = confirmed_times(outcomes)
  +count = List.length(&2, Nat, times)
  +known = Nat.is_lt(0n, count)
  Report{Totals{coverage(occurrences, Coverage{0n, 0n}), count, Delay.optional(sum(times), known),
    Delay.optional(shared_total(outcomes), known), median(times, count), worst(times, count)}, outcomes,
    List.sort(~Impact, ~preceding, impacts), evidence}

def finish(replay: Replay) -> Report:
  match replay:
    case Replay{outcomes, evidence}: report(outcomes, evidence)

def outcome_delays(windows: List<&2, Delay.DelayWindow>) -> Report:
  +table = scan(windows, Map.new(&2, List<&2, Delay.DelayWindow>))
  finish(measure(Map.values(&2, List<&2, Delay.DelayWindow>, table), Replay{[], []}))

def within_day(+at: Nat, from: Nat, to: Nat) -> Bool:
  Bool.and(Nat.is_lt(0n, at), Bool.and(Nat.is_le(from, at), Nat.is_lt(at, to)))

def day_overlap(+start: Nat, +end: Nat, from: Nat, to: Nat) -> Bool:
  Bool.and(Nat.is_lt(0n, start), Bool.and(Nat.is_lt(start, end), Bool.and(Nat.is_lt(start, to), Nat.is_lt(from, end))))

def day_spans(spans: List<&2, Delay.Span>, +from: Nat, +to: Nat) -> List<&2, Delay.Span>:
  match spans:
    case []: []
    case Delay.Span{+start, +end, conditions} <> tail:
      +rest = day_spans(tail, from, to)
      Bool.pick(List<&2, Delay.Span>, day_overlap(start, end, from, to),
        Delay.Span{Nat.max(start, from), Nat.min(end, to), conditions} <> rest, rest)

def day_outcome(outcome: Delay.Outcome, from: Nat, to: Nat) -> Delay.Outcome:
  match outcome:
    case Delay.Outcome{id, scope, stage, spans, _, _}:
      +inside = day_spans(spans, from, to)
      +known = Nat.is_lt(0n, List.length(&2, Delay.Span, inside))
      Delay.Outcome{id, scope, stage, inside, Delay.optional(Delay.confirmed(inside), known), Delay.optional(Delay.shared(inside), known)}

def day_outcomes(outcomes: List<&2, Delay.Outcome>, +from: Nat, +to: Nat) -> List<&2, Delay.Outcome>:
  match outcomes:
    case []: []
    case head <> rest: day_outcome(head, from, to) <> day_outcomes(rest, from, to)

def day_blockers(blockers: List<&2, Delay.Blocker>, +ready: Nat, +possible: Nat, +from: Nat, +to: Nat) -> List<&2, Delay.Blocker>:
  match blockers:
    case []: []
    case +blocker <> tail:
      match blocker:
        case Delay.Blocker{_, _, _, _, +start, +end, _, _}:
          +known = Bool.and(Nat.is_lt(0n, start), Nat.is_lt(start, end))
          +in_outcome = Bool.and(Nat.is_lt(0n, ready), Nat.is_lt(ready, possible))
          +left = Bool.pick(Nat, in_outcome, Nat.max(ready, start), start)
          +right = Bool.pick(Nat, in_outcome, Nat.min(possible, end), end)
          +measured = day_overlap(left, right, from, to)
          +partial = Bool.or(Bool.or(within_day(start, from, to), within_day(end, from, to)),
            Bool.or(day_overlap(ready, possible, from, to), Bool.or(within_day(ready, from, to), within_day(possible, from, to))))
          +rest = day_blockers(tail, ready, possible, from, to)
          Bool.pick(List<&2, Delay.Blocker>, Bool.pick(Bool, known, measured, partial), blocker <> rest, rest)

def day_evidence(evidence: List<&2, Delay.Evidence>, +from: Nat, +to: Nat) -> List<&2, Delay.Evidence>:
  match evidence:
    case []: []
    case Delay.Evidence{Delay.DelayWindow{id, outcome, scope, stage, basis, +ready, +possible, readiness, availability, blockers}, measured} <> tail:
      +inside = day_blockers(blockers, ready, possible, from, to)
      Delay.Evidence{Delay.DelayWindow{id, outcome, scope, stage, basis, ready, possible, readiness, availability, inside}, measured}
        <> day_evidence(tail, from, to)

def day_report(replay: Replay, +from: Nat, +to: Nat) -> Report:
  match replay:
    case Replay{outcomes, evidence}: report(day_outcomes(outcomes, from, to), day_evidence(evidence, from, to))

def outcome_delays_in_window(windows: List<&2, Delay.DelayWindow>, from: Nat, to: Nat) -> Report:
  +table = scan(windows, Map.new(&2, List<&2, Delay.DelayWindow>))
  day_report(measure(Map.values(&2, List<&2, Delay.DelayWindow>, table), Replay{[], []}), from, to)
