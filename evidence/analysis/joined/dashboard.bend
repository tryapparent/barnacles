import Base
import ../bottleneck.bend as Study

type DayWindow is Data:
  DayWindow{from: Nat, to: Nat}

type RunClock is Data:
  RunClock{requested: Nat, started: Nat, completed: Nat}

type Target is Data:
  Target{instance: String, thread: String}

type DayObservation is Data:
  DayObservation{rule: String, id: String}

type Thread is Data:
  Thread{id: String, codex: U32, ci: U32, observations: List<&2, DayObservation>}

type Rank is Data:
  Rank{rule: String, threads: U32, occurrences: U32}

type Tally is Data:
  Tally{seen_threads: Map<&2, Bool>, seen_observations: Map<&2, Bool>, ranks: Map<&2, Rank>}

type Coverage is Data:
  Coverage{active: U32, withCodex: U32, withCI: U32, withBoth: U32}

def last_day(+to: Nat) -> DayWindow:
  DayWindow{Nat.sub(to, 86400000n), to}

def within(+window: DayWindow, +stamp: Nat) -> Bool:
  match window:
    case DayWindow{from, to}:
      Bool.and(Nat.is_lt(0n, stamp), Bool.and(Nat.is_le(from, stamp), Nat.is_lt(stamp, to)))

def overlaps(window: DayWindow, +start: Nat, +end: Nat) -> Bool:
  match window:
    case DayWindow{from, to}:
      Bool.and(Nat.is_lt(0n, start), Bool.and(Nat.is_lt(start, end),
        Bool.and(Nat.is_lt(start, to), Nat.is_lt(from, end))))

def observed(+window: DayWindow, run: RunClock) -> Bool:
  match run:
    case RunClock{+requested, +started, +completed}:
      Bool.or(Bool.or(within(window, requested), within(window, started)),
        Bool.or(within(window, completed), Bool.or(overlaps(window, requested, started), overlaps(window, started, completed))))

def runs_active(+window: DayWindow, runs: List<&2, RunClock>) -> Bool:
  match runs:
    case []: False{}
    case run <> rest: Bool.or(observed(window, run), runs_active(window, rest))

def active(+window: DayWindow, created: Nat, runs: List<&2, RunClock>) -> Bool:
  Bool.or(within(window, created), runs_active(window, runs))

def update_rank(rank: Rank, thread: Bool, observation: Bool) -> Rank:
  match rank:
    case Rank{rule, threads, occurrences}:
      Rank{rule, U32.add(threads, Bool.pick(U32, thread, 1, 0)), U32.add(occurrences, Bool.pick(U32, observation, 1, 0))}

def add_rank(+rule: String, +thread: String, id: String, tally: Tally) -> Tally:
  match tally:
    case Tally{+threads, +observations, +ranks}:
      +thread_key = Study.pair(rule, thread)
      +observation_key = Study.pair(rule, id)
      +rank = Study.found(~Rank, Map.get(Rank, Rank{rule, 0, 0}, ranks, rule))
      +updated = update_rank(rank, Bool.not(Study.includes(threads, thread_key)), Bool.not(Study.includes(observations, observation_key)))
      Tally{Map.set(&2, Bool, threads, thread_key, True{}), Map.set(&2, Bool, observations, observation_key, True{}),
        Map.set(&2, Rank, ranks, rule, updated)}

def add_observations(observations: List<&2, DayObservation>, +thread: String, tally: Tally) -> Tally:
  match observations:
    case []: tally
    case DayObservation{rule, id} <> tail:
      add_observations(tail, thread, add_rank(rule, thread, id, tally))

def aggregate(threads: List<&2, Thread>, tally: Tally) -> Map<&2, Rank>:
  match threads tally:
    case [] Tally{_, _, ranks}: ranks
    case Thread{id, _, _, observations} <> tail _:
      aggregate(tail, add_observations(observations, id, tally))

def before(first: Rank, second: Rank) -> Bool:
  match first second:
    case Rank{_, +a, x} Rank{_, +b, y}:
      Bool.or(U32.is_gt(a, b), Bool.and(U32.is_eq(a, b), U32.is_gt(x, y)))

def ranking(threads: List<&2, Thread>) -> List<&2, Rank>:
  +ranks = aggregate(threads, Tally{Map.new(&2, Bool), Map.new(&2, Bool), Map.new(&2, Rank)})
  List.sort(~Rank, ~before, Map.values(&2, Rank, ranks))

def coverage(threads: List<&2, Thread>, total: Coverage) -> Coverage:
  match threads total:
    case [] _: total
    case Thread{_, codex, ci, _} <> rest Coverage{active, withCodex, withCI, withBoth}:
      +c = U32.is_gt(codex, 0)
      +g = U32.is_gt(ci, 0)
      coverage(rest, Coverage{U32.inc(active), U32.add(withCodex, Bool.pick(U32, c, 1, 0)),
        U32.add(withCI, Bool.pick(U32, g, 1, 0)), U32.add(withBoth, Bool.pick(U32, Bool.and(c, g), 1, 0))})

def source_coverage(threads: List<&2, Thread>) -> Coverage:
  coverage(threads, Coverage{0, 0, 0, 0})

def select_threads(instances: List<&2, Target>) -> List<&2, Target>:
  List.take(&2, Target, instances, 50n)

def refresh_needed(stored: String, observed: String) -> Bool:
  Bool.not(String.eq(stored, observed))
