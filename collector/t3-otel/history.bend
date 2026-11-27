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

type Rotation is Data:
  Rotation{total: Nat, threads: List<&2, String>}

def unique_sorted(ids: List<&2, String>, +previous: String, +acc: List<&2, String>, +total: Nat) -> Rotation:
  match ids:
    case []: Rotation{total, List.reverse(&2, String, acc)}
    case +id <> rest:
      +duplicate = String.eq(previous, id)
      unique_sorted(rest, id, Bool.pick(List<&2, String>, duplicate, acc, id <> acc),
        Bool.pick(Nat, duplicate, total, Nat.add(total, 1n)))

def prior_count(+after: String, ids: List<&2, String>, +count: Nat) -> Nat:
  match ids:
    case []: count
    case id <> rest:
      prior_count(after, rest, Bool.pick(Nat, String.is_lt(after, id), count, Nat.add(count, 1n)))

def batch(after: String, inventory: Rotation) -> Rotation:
  match inventory:
    case Rotation{+total, +sorted}:
      +newer = List.take(&2, String, List.drop(&2, String, sorted, prior_count(after, sorted, 0n)), 32n)
      Rotation{total, List.take(&2, String, List.append(&2, String, newer, sorted), Nat.min(total, 32n))}

def rotation(after: String, ids: List<&2, String>) -> Rotation:
  batch(after, unique_sorted(Metrics.sort_timing(~String, ~String.is_lt, ids), "", [], 0n))
