import Base
import ../repository.bend as Repository

type Clock is Data:
  Time{s: U32, ms: U32}

type WatchKey is Data:
  PrWatchKey{host: String, repository: String, number: U32, sha: String}

type WatchMessage is Data:
  PrWatchMessage{id: String, thread: String, run: String, kind: String, key: WatchKey, watch_started: Clock, created: Clock}

type WatchRun is Data:
  PrWatchRun{id: String, thread: String, user_message: String, status: String, started: Clock, completed: Clock}

type Pickup is Data:
  Pickup{thread: String, message: String, run: String, host: String, repository: String, number: U32,
    head_sha: String, watch_started: Clock, notification_created: Clock, run_started: Clock, run_completed: Clock}

type WatchWindow is Data:
  WatchWindow{id: String, start: Clock, end: Clock}

def clock_ordered(start: Clock, end: Clock) -> Bool:
  match start end:
    case Time{+s, ms} Time{+end_s, end_ms}:
      Bool.and(U32.is_ne(s, 0), Bool.or(U32.is_lt(s, end_s),
        Bool.and(U32.is_eq(s, end_s), U32.is_le(ms, end_ms))))

def clock_equal(a: Clock, b: Clock) -> Bool:
  match a b:
    case Time{s, ms} Time{other_s, other_ms}:
      Bool.and(U32.is_eq(s, other_s), U32.is_eq(ms, other_ms))

def key_equal(a: WatchKey, b: WatchKey) -> Bool:
  match a b:
    case PrWatchKey{host, repo, number, sha} PrWatchKey{other_host, other_repo, other_number, other_sha}:
      Bool.and(String.eq(host, other_host), Bool.and(String.eq(repo, other_repo),
        Bool.and(U32.is_eq(number, other_number), String.eq(sha, other_sha))))

def message_equal(a: WatchMessage, b: WatchMessage) -> Bool:
  match a b:
    case PrWatchMessage{_, thread, run, kind, key, watch, created}
         PrWatchMessage{_, other_thread, other_run, other_kind, other_key, other_watch, other_created}:
      Bool.and(String.eq(thread, other_thread), Bool.and(String.eq(run, other_run),
        Bool.and(String.eq(kind, other_kind), Bool.and(key_equal(key, other_key),
          Bool.and(clock_equal(watch, other_watch), clock_equal(created, other_created))))))

def run_equal(a: WatchRun, b: WatchRun) -> Bool:
  match a b:
    case PrWatchRun{_, thread, message, status, started, completed}
         PrWatchRun{_, other_thread, other_message, other_status, other_started, other_completed}:
      Bool.and(String.eq(thread, other_thread), Bool.and(String.eq(message, other_message),
        Bool.and(String.eq(status, other_status),
          Bool.and(clock_equal(started, other_started), clock_equal(completed, other_completed)))))

def message_id(row: WatchMessage) -> String:
  match row:
    case PrWatchMessage{id, _, _, _, _, _, _}: id

def run_id(row: WatchRun) -> String:
  match row:
    case PrWatchRun{id, _, _, _, _, _}: id

def consistent_message(+message: WatchMessage, messages: List<&2, WatchMessage>) -> Bool:
  match messages:
    case []: True{}
    case +head <> rest:
      Bool.and(Bool.or(Bool.not(String.eq(message_id(message), message_id(head))), message_equal(message, head)),
        consistent_message(message, rest))

def find_message(+id: String, rows: List<&2, WatchMessage>) -> Maybe<&2, WatchMessage>:
  match rows:
    case []: None{}
    case +head <> rest:
      Bool.pick(Maybe<&2, WatchMessage>, String.eq(id, message_id(head)), Some{head}, find_message(id, rest))


def consistent_run(+run: WatchRun, runs: List<&2, WatchRun>) -> Bool:
  match runs:
    case []: True{}
    case +head <> rest:
      Bool.and(Bool.or(Bool.not(String.eq(run_id(run), run_id(head))), run_equal(run, head)),
        consistent_run(run, rest))

def find_run(+id: String, rows: List<&2, WatchRun>) -> Maybe<&2, WatchRun>:
  match rows:
    case []: None{}
    case +head <> rest:
      Bool.pick(Maybe<&2, WatchRun>, String.eq(id, run_id(head)), Some{head}, find_run(id, rest))


def hex_chars(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: True{}
    case head <> rest:
      Bool.and(String.contains("0123456789abcdef", String.from_list([head])), hex_chars(rest))

def valid_key(+host: String, +repository: String, number: U32, +sha: String) -> Bool:
  Bool.and(String.eq(host, "github.com"), Bool.and(Bool.not(String.is_empty(repository)),
    Bool.and(U32.is_ne(number, 0), Bool.and(Nat.is_eq(String.length(sha), 40n),
      hex_chars(String.to_list(sha))))))

def bind_run(expected: WatchKey, expected_thread: String, expected_message: String, watch: Clock, +created: Clock,
    result: Maybe<&2, WatchRun>, runs: List<&2, WatchRun>) -> Maybe<&2, Pickup>:
  match expected result:
    case PrWatchKey{host, repo, number, sha} Some{PrWatchRun{+id, +thread, +user_message, +status, +started, +completed}}:
      same_run = Bool.and(String.eq(thread, expected_thread), String.eq(user_message, expected_message))
      ordered = Bool.and(clock_ordered(created, started), clock_ordered(started, completed))
      consistent = consistent_run(PrWatchRun{id, thread, user_message, status, started, completed}, runs)
      Bool.pick(Maybe<&2, Pickup>, Bool.and(consistent, Bool.and(same_run, Bool.and(String.eq(status, "completed"), ordered))),
        Some{Pickup{thread, user_message, id, host, repo, number, sha, watch, created, started, completed}},
        None{})
    case _ _: None{}

def bind_message(thread: String, +host: String, +repo: String, +number: U32, +sha: String,
    proof: Maybe<&2, WatchMessage>, messages: List<&2, WatchMessage>, +runs: List<&2, WatchRun>) -> Maybe<&2, Pickup>:
  match proof:
    case Some{PrWatchMessage{+id, +msg_thread, +run, +kind, +key, +watch, +created}}:
      addressed = Bool.and(String.starts_with(id, "message:pr-watch:"),
        Bool.and(String.eq(thread, msg_thread), Bool.not(String.is_empty(run))))
      stamped = Bool.and(String.eq(kind, "monitor"),
        Bool.and(key_equal(PrWatchKey{host, repo, number, sha}, key), clock_ordered(watch, created)))
      consistent = consistent_message(PrWatchMessage{id, msg_thread, run, kind, key, watch, created}, messages)
      Bool.pick(Maybe<&2, Pickup>, Bool.and(consistent, Bool.and(valid_key(host, repo, number, sha), Bool.and(addressed, stamped))),
        bind_run(PrWatchKey{host, repo, number, sha}, msg_thread, id, watch, created, find_run(run, runs), runs), None{})
    case _: None{}

def pr_watch_pickup(thread: String, id: String, host: String, repository: String, number: U32, sha: String,
    +messages: List<&2, WatchMessage>, runs: List<&2, WatchRun>) -> Maybe<&2, Pickup>:
  bind_message(thread, host, Repository.normalized(repository), number, sha, find_message(id, messages), messages, runs)

def absent_message(message: Maybe<&2,WatchMessage>) -> Bool:
  match message:
    case Some{_}: False{}
    case None{}: True{}

def confirm_window(valid: Bool, message: WatchMessage, all: List<&2,WatchMessage>, later: List<&2,WatchMessage>) -> Maybe<&2,WatchWindow>:
  match valid message:
    case True{} PrWatchMessage{+id,owner,run,kind,key,+start,+end}:
      +stable = consistent_message(PrWatchMessage{id,owner,run,kind,key,start,end},all)
      +unique = absent_message(find_message(id,later))
      Bool.pick(Maybe<&2,WatchWindow>,Bool.and(stable,unique),Some{WatchWindow{id,start,end}},None{})
    case False{} _: None{}

def watch_window(thread: String, message: WatchMessage, all: List<&2, WatchMessage>, later: List<&2, WatchMessage>) -> Maybe<&2, WatchWindow>:
  match message:
    case PrWatchMessage{+id, +owner, +run, +kind, PrWatchKey{+host,+repo,+number,+sha}, +start, +end}:
      +addressed = Bool.and(String.eq(thread,owner),Bool.and(String.starts_with(id,"message:pr-watch:"),Bool.not(String.is_empty(run))))
      +measured = Bool.and(String.eq(kind,"monitor"),Bool.and(valid_key(host,repo,number,sha),clock_ordered(start,end)))
      confirm_window(Bool.and(addressed,measured),PrWatchMessage{id,owner,run,kind,PrWatchKey{host,repo,number,sha},start,end},all,later)

def prepend_window(window: Maybe<&2,WatchWindow>, tail: List<&2,WatchWindow>) -> List<&2,WatchWindow>:
  match window:
    case None{}: tail
    case Some{value}: value <> tail

def collect_windows(+thread: String, messages: List<&2, WatchMessage>, +all: List<&2, WatchMessage>) -> List<&2, WatchWindow>:
  match messages:
    case []: []
    case message <> +rest:
      prepend_window(watch_window(thread,message,all,rest),collect_windows(thread,rest,all))

def pr_watch_windows(thread: String, +messages: List<&2,WatchMessage>) -> List<&2,WatchWindow>:
  collect_windows(thread,messages,messages)
