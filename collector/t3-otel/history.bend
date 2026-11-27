import Base

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
