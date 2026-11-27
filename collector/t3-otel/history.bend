import Base
import ../../evidence/projection/metrics.bend as Metrics

type Command is Data:
  Command{id: String, thread: String, run: String, provider_thread: String, provider_turn: String,
    native_item: String, status: String, exit_code: String, started: String, completed: String, updated: String}

type Observation is Data:
  Skip{}
  Invalid{}
  Keep{command: Command}

def nonempty(value: String) -> Bool:
  Bool.not(String.eq(value, ""))

def observe(+thread: String, kind: String, driver: String, strength: String, +command: Command) -> Observation:
  match command:
    case Command{id, owner, run, provider_thread, provider_turn, native_item, status, exit_code, started, completed, updated}:
      +known_status = List.contains(~String, ~String.eq,
        ["idle", "pending", "running", "waiting", "completed", "failed", "cancelled", "interrupted"], status)
      +strong_codex_command = Bool.and(String.eq(kind, "command_execution"),
        Bool.and(String.eq(driver, "codex"), String.eq(strength, "strong")))
      +has_identity = Bool.and(nonempty(id),
        Bool.and(nonempty(provider_thread), Bool.and(nonempty(provider_turn), nonempty(native_item))))
      Bool.pick(Observation, strong_codex_command,
        Bool.pick(Observation, Bool.and(String.eq(thread, owner), known_status),
          Bool.pick(Observation, has_identity,
            Keep{Command{id, owner, run, provider_thread, provider_turn, native_item, status, exit_code, started, completed, updated}},
            Skip{}),
          Invalid{}), Skip{})

def local_row(thread: String, owner: String, visibility: String) -> Bool:
  Bool.and(String.eq(thread, owner), String.eq(visibility, "local"))

def page_valid(previous: String, +next: String, more: Bool) -> Bool:
  Bool.pick(Bool, more, Bool.and(nonempty(next), Bool.not(String.eq(previous, next))), String.eq(next, ""))

def begin_scan(+saved: String, head: String) -> String:
  Bool.pick(String, String.eq(saved, ""), head, saved)

type Replay is Data:
  Write{}
  Ignore{}
  Conflict{}

def replay(+saved_seq: U32, +incoming_seq: U32, saved: String, incoming: String) -> Replay:
  Bool.pick(Replay, U32.is_lt(saved_seq, incoming_seq), Write{},
    Bool.pick(Replay, Bool.or(U32.is_gt(saved_seq, incoming_seq), String.eq(saved, incoming)), Ignore{}, Conflict{}))

type Target is Data:
  Target{id: String, updated: Nat}

type Task is Data:
  Task{id: String, cursor: String, priority: Nat, revision: Nat, keep: Bool}

def dated_before(+a: Nat, +id: String, +b: Nat, +other: String) -> Bool:
  Bool.or(Nat.is_gt(a, b), Bool.and(Nat.is_eq(a, b), String.is_lt(id, other)))

def target_before(left: Target, right: Target) -> Bool:
  match left right:
    case Target{id, a} Target{other, b}: dated_before(a, id, b, other)

def identity_before(left: Target, right: Target) -> Bool:
  match left right:
    case Target{+id, a} Target{+other, b}:
      Bool.or(String.is_lt(id, other), Bool.and(String.eq(id, other), Nat.is_gt(a, b)))

def unique_targets(input: List<&2, Target>, +previous: String, +output: List<&2, Target>) -> List<&2, Target>:
  match input:
    case []: output
    case Target{+id, updated} <> rest:
      unique_targets(rest, id,
        Bool.pick(List<&2, Target>, String.eq(previous, id), output, Target{id, updated} <> output))

def inventory(input: List<&2, Target>) -> List<&2, Target>:
  Metrics.sort_timing(~Target, ~target_before, unique_targets(Metrics.sort_timing(~Target, ~identity_before, input), "", []))

def plan(target: Target, +cursor: String, +known: Bool, +revision: Nat, +frontier: Nat, +refresh: Bool) -> Maybe<&2, Task>:
  match target:
    case Target{+id, +updated}:
      +pending = nonempty(cursor)
      +current = Bool.and(known, Nat.is_le(updated, revision))
      Bool.pick(Maybe<&2, Task>, refresh,
        Some{Task{id, "", updated, updated, Bool.or(pending, current)}},
        Bool.pick(Maybe<&2, Task>, pending,
          Some{Task{id, cursor, Bool.pick(Nat, known, frontier, updated), Bool.pick(Nat, known, revision, updated), False{}}},
          Bool.pick(Maybe<&2, Task>, current, None{}, Some{Task{id, "", updated, updated, False{}}})))

def task_before(left: Task, right: Task) -> Bool:
  match left right:
    case Task{id, _, a, _, _} Task{other, _, b, _, _}: dated_before(a, id, b, other)

def within_day(limit: Nat, input: List<&2, Task>, +day: Nat) -> List<&2, Task>:
  match limit:
    case 0n: []
    case 1n+remaining:
      match input:
        case []: []
        case Task{+id, +cursor, +priority, +revision, +keep} <> tail:
          Bool.pick(List<&2, Task>, Nat.is_eq(day, Nat.div(priority, 86400000n)),
            Task{id, cursor, priority, revision, keep} <> within_day(remaining, tail, day), [])

def recent(input: List<&2, Target>) -> List<&2, Target>:
  List.take(&2, Target, input, 32n)

def newest_day(sorted: List<&2, Task>) -> List<&2, Task>:
  match sorted:
    case []: []
    case Task{id, cursor, +priority, revision, keep} <> rest:
      Task{id, cursor, priority, revision, keep} <> within_day(31n, rest, Nat.div(priority, 86400000n))

def batch(input: List<&2, Task>) -> List<&2, Task>:
  newest_day(Metrics.sort_timing(~Task, ~task_before, input))

def older_frontier(+previous: Nat, +oldest: Nat) -> Nat:
  Bool.pick(Nat, Nat.is_eq(previous, 0n), oldest, Nat.min(previous, oldest))

def earliest(+saved: Nat, +at: Nat) -> Nat:
  Bool.pick(Nat, Nat.is_eq(saved, 0n), at, Bool.pick(Nat, Nat.is_eq(at, 0n), saved, Nat.min(saved, at)))

type Pace is Data:
  Pace{workers: Nat, pause: Nat}

def pacing(+previous: Nat, elapsed: Nat, failed: Bool) -> Pace:
  +unhealthy = Bool.or(failed, Nat.is_gt(elapsed, 1000n))
  +pause = Bool.pick(Nat, unhealthy, Nat.min(60000n, Nat.max(1000n, Nat.mul(previous, 2n))), Nat.max(50n, Nat.div(previous, 2n)))
  Pace{Bool.pick(Nat, Nat.is_ge(pause, 1000n), 1n, 2n), pause}

def observe_anchor(+expected: String, id: String, seen: Bool) -> Bool:
  Bool.or(seen, Bool.and(nonempty(expected), String.eq(expected, id)))

def next_cursor(cursor: String, overlap: Bool) -> String:
  Bool.pick(String, overlap, "", cursor)

def tip(+previous: String, +id: String, previous_order: Nat, order: Nat) -> String:
  Bool.pick(String, Bool.and(nonempty(id), Nat.is_ge(order, previous_order)), id, previous)

def finished(status: String) -> Bool:
  List.contains(~String, ~String.eq, ["completed", "failed", "cancelled", "interrupted"], status)

type Pending is Data:
  Pending{thread: String, id: String, checked: Nat, status: String}

def pending_before(left: Pending, right: Pending) -> Bool:
  match left right:
    case Pending{+a, id, +at, _} Pending{+b, other, +bt, _}:
      Bool.or(Nat.is_lt(at, bt), Bool.and(Nat.is_eq(at, bt),
        Bool.or(String.is_lt(a, b), Bool.and(String.eq(a, b), String.is_lt(id, other)))))

def pending_add(input: List<&2, Pending>, +acc: List<&2, Pending>) -> List<&2, Pending>:
  match input:
    case []: acc
    case Pending{thread, id, checked, +status} <> rest:
      pending_add(rest, Bool.pick(List<&2, Pending>, finished(status), acc, Pending{thread, id, checked, status} <> acc))

def reconcile_batch(input: List<&2, Pending>) -> List<&2, Pending>:
  List.take(&2, Pending, Metrics.sort_timing(~Pending, ~pending_before, pending_add(input, [])), 16n)

def stale_item(+previous: Nat, +incoming: Nat, saved: String, status: String) -> Bool:
  Bool.or(Bool.and(Nat.is_gt(incoming, 0n), Nat.is_lt(incoming, previous)),
    Bool.and(finished(saved), Bool.not(finished(status))))

def confirm_exit(prior_status: String, observed_status: String, prior_clock: Nat, +clock: Nat) -> Bool:
  Bool.and(Bool.not(finished(prior_status)), Bool.and(finished(observed_status),
    Bool.and(Nat.is_gt(clock, 0n), Nat.is_ge(clock, prior_clock))))

def seed_baseline(cursor: String, covered: String, +revision: Nat, head: Nat) -> Bool:
  Bool.and(Bool.not(nonempty(cursor)), Bool.and(Bool.not(nonempty(covered)),
    Bool.and(Nat.is_gt(revision, 0n), Nat.is_eq(revision, head))))

type Checkpoint is Data:
  Checkpoint{revision: Nat, frontier: Nat, covered: String, tip: String}

def advance_checkpoint(+keep: Bool, +saved: String, +covered: String, +revision: Nat, +tip: String, +priority: Nat,
    oldest: Nat, head_revision: Nat, next: String) -> Maybe<&2, Checkpoint>:
  +seed = Bool.and(keep, seed_baseline(saved, covered, revision, head_revision))
  +covered_after = Bool.pick(String, Bool.or(nonempty(next), Bool.not(nonempty(tip))), covered, tip)
  Bool.pick(Maybe<&2, Checkpoint>, Bool.and(keep, Bool.not(seed)), None{},
    Some{Checkpoint{revision, older_frontier(priority, oldest), covered_after, tip}})

def projection_due(+updated: Nat, saved: Nat, now: Nat) -> Bool:
  Bool.and(Nat.is_le(Nat.sub(now, 86400000n), updated), Nat.is_gt(updated, saved))
