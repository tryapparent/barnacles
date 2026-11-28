import Base

type Signal is Data:
  Signal{kind: String, scope: String, event: String, elapsed: Maybe<&2, Nat>}

type Batch is Data:
  Batch{thread: String, signals: List<&2, Signal>}

type Delay is Data:
  Delay{pattern: String, stage: String, elapsed: Nat, measured: Nat, occurrences: Nat, outcomes: Nat,
    median: Maybe<&2, Nat>, worst: Maybe<&2, Nat>}

type Priority is Data:
  Priority{kind: String, target: String, stage: String, nextStep: String, rankBy: String, occurrences: Nat,
    affectedThreads: Maybe<&2, Nat>, affectedOutcomes: Maybe<&2, Nat>, measured: Nat, totalMs: Maybe<&2, Nat>,
    medianMs: Maybe<&2, Nat>, worstMs: Maybe<&2, Nat>}

type Count is Data:
  Count{kind: String, scope: String, affected: Nat, occurrences: Nat, measured: Nat, total: Nat, worst: Nat}

type Ledger is Data:
  Ledger{threads: Map<&2, Bool>, events: Map<&2, Bool>, counts: Map<&2, Count>}

def key(+a: String, b: String) -> String:
  String.append(Nat.show(String.length(a)), String.append(":", String.append(a, b)))

def last(value: Map<&2, Bool> & Bool) -> Bool:
  match value:
    case (_, present): present

def fresh(table: Map<&2, Bool>, id: String) -> Bool:
  Bool.not(last(Map.get(Bool, False{}, table, id)))

def submitted(+observed: Bool, amount: Maybe<&2, Nat>) -> Maybe<&2, Nat>:
  Bool.pick(Maybe<&2, Nat>, observed, amount, None{})

def sum_time(current: Count, elapsed: Maybe<&2, Nat>) -> Count:
  match current elapsed:
    case Count{kind, scope, affected, events, measured, total, worst} Some{+ms}:
      Count{kind, scope, affected, events, Nat.add(measured, 1n), Nat.add(total, ms), Nat.max(worst, ms)}
    case _ None{}: current

def update(value: Map<&2, Count> & Count, group: String, first_thread: Bool, +first_event: Bool, elapsed: Maybe<&2, Nat>) -> Map<&2, Count>:
  match value:
    case (counts, Count{kind, scope, affected, events, measured, total, worst}):
      +seen = Nat.add(affected, Bool.pick(Nat, first_thread, 1n, 0n))
      +count = Nat.add(events, Bool.pick(Nat, first_event, 1n, 0n))
      Map.set(&2, Count, counts, group, sum_time(Count{kind, scope, seen, count, measured, total, worst}, submitted(first_event, elapsed)))

def note(ledger: Ledger, thread: String, signal: Signal) -> Ledger:
  match ledger signal:
    case Ledger{+threads, +events, counts} Signal{+kind, +scope, event, elapsed}:
      +group = key(kind, scope)
      +tid = key(group, thread)
      +eid = key(group, event)
      +updated = update(Map.get(Count, Count{kind, scope, 0n, 0n, 0n, 0n, 0n}, counts, group),
        group, fresh(threads, tid), fresh(events, eid), elapsed)
      Ledger{Map.set(&2, Bool, threads, tid, True{}), Map.set(&2, Bool, events, eid, True{}), updated}

def note_batch(signals: List<&2, Signal>, +thread: String, ledger: Ledger) -> Ledger:
  match signals:
    case []: ledger
    case head <> rest: note_batch(rest, thread, note(ledger, thread, head))

def aggregate(batches: List<&2, Batch>, ledger: Ledger) -> Ledger:
  match batches:
    case []: ledger
    case Batch{thread, signals} <> tail: aggregate(tail, note_batch(signals, thread, ledger))

def notable(+a: Nat, +b: Nat, +x: Nat, +y: Nat, tie: Bool) -> Bool:
  Bool.or(Nat.is_lt(b, a), Bool.and(Nat.is_eq(a, b), Bool.or(Nat.is_lt(y, x), Bool.and(Nat.is_eq(x, y), tie))))

def diagnostic_before(a: Count, b: Count) -> Bool:
  match a b:
    case Count{ak, ascope, a, x, _, _, _} Count{bk, bscope, b, y, _, _, _}:
      notable(a, b, x, y, String.is_lt(key(ak, ascope), key(bk, bscope)))

def delay_before(a: Delay, b: Delay) -> Bool:
  match a b:
    case Delay{ap, ast, a, _, _, x, _, _} Delay{bp, bst, b, _, _, y, _, _}:
      notable(a, b, x, y, String.is_lt(key(ap, ast), key(bp, bst)))

def action(+kind: String) -> String:
  Bool.pick(String, String.eq(kind, "t3-admission"),
    "Compare the request-to-start waits with T3 queue depth and provider capacity at the busiest times.",
    "Compare the first failing step and runner logs across the failed attempts in this job group.")

def known(+count: Nat, value: Nat) -> Maybe<&2, Nat>:
  Bool.pick(Maybe<&2, Nat>, Nat.is_lt(0n, count), Some{value}, None{})

def diagnostics(counts: List<&2, Count>) -> List<&2, Priority>:
  match counts:
    case []: []
    case Count{+kind, target, affected, events, +measured, total, worst} <> rest:
      Priority{kind, target, "", action(kind), "affected-threads", events, Some{affected}, None{},
        measured, known(measured, total), None{}, known(measured, worst)} <> diagnostics(rest)

def confirmed(delays: List<&2, Delay>) -> List<&2, Priority>:
  match delays:
    case []: []
    case Delay{pattern, stage, +elapsed, measured, events, outcomes, median, worst} <> tail:
      +rest = confirmed(tail)
      Bool.pick(List<&2, Priority>, Nat.is_lt(0n, elapsed),
        Priority{"confirmed-delay", pattern, stage,
          "Review the evidence for when the outcome was ready and what released the blocking condition.",
          "unique-outcome-delay", events, None{}, Some{outcomes}, measured, Some{elapsed}, median, worst} <> rest, rest)

def top(ledger: Ledger, delays: List<&2, Delay>) -> List<&2, Priority>:
  match ledger:
    case Ledger{_, _, counts}:
      +observed = diagnostics(List.sort(~Count, ~diagnostic_before, Map.values(&2, Count, counts)))
      +proven = confirmed(List.sort(~Delay, ~delay_before, delays))
      List.take(&2, Priority, List.concat(&2, Priority, [proven, observed]), 3n)

def priorities(batches: List<&2, Batch>, delays: List<&2, Delay>) -> List<&2, Priority>:
  top(aggregate(batches, Ledger{Map.new(&2, Bool), Map.new(&2, Bool), Map.new(&2, Count)}), delays)
