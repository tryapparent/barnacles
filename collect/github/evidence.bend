import Base
import 0x419ec39802735c4664960ab4b9d962e5/json.bend as Json
import 0xec25e4adfb02e59e4b817801115988ee/bytes.bend as Bytes

type Projection is Data:
  Rejected{}
  Projected{key: String, body: String}

def all_chars(text: String, +chars: String) -> Bool:
  match text:
    case SNil{}: True{}
    case SCon{head, tail}: Bool.and(String.contains(chars, SCon{head, SNil{}}), all_chars(tail, chars))

def bounded(+text: String, limit: Nat) -> Bool:
  +n = String.length(text)
  Bool.and(Nat.is_gt(n, 0n), Nat.is_le(n, limit))

def safe_atom(+value: String, limit: Nat, chars: String) -> Bool:
  Bool.and(bounded(value, limit), all_chars(value, chars))

def identifier(+value: String) -> Bool:
  Bool.and(Bool.not(String.starts_with(value, "0")), safe_atom(value, 20n, "0123456789"))

def sha(+value: String) -> Bool:
  Bool.and(Nat.is_eq(String.length(value), 40n), all_chars(value, "0123456789abcdef"))

def repo_parts(parts: List<&2, String>) -> Bool:
  match parts:
    case [owner, +repo]:
      Bool.and(safe_atom(owner, 39n, "abcdefghijklmnopqrstuvwxyz0123456789-"),
        Bool.and(safe_atom(repo, 100n, "abcdefghijklmnopqrstuvwxyz0123456789._-"),
          Bool.not(Bool.or(String.eq(repo, "."), String.eq(repo, "..")))))
    case _: False{}

def valid_repo(value: String) -> Bool:
  repo_parts(String.split(value, '/'))

def valid_scope(value: String) -> Bool:
  safe_atom(value, 48n, "abcdefghijklmnopqrstuvwxyz0123456789-_")

def valid_run(+run: String, +attempt: U32, head: String, +created: U32, lo: U32, hi: U32) -> Bool:
  Bool.and(identifier(run), Bool.and(U32.is_gt(attempt, 0), Bool.and(U32.is_le(attempt, 1000),
    Bool.and(sha(head), Bool.and(U32.is_ge(created, lo), U32.is_le(created, hi))))))

def text_json(value: String) -> Json.Val:
  Json.Str{Json.utf8(value)}

def string(key: String, value: String) -> Bytes.Bytes & Json.Val:
  (Json.utf8(key), text_json(value))

def optional(key: String, +value: String) -> Bytes.Bytes & Json.Val:
  (Json.utf8(key), Bool.pick(Json.Val, String.is_empty(value), Json.Null{}, text_json(value)))

def clock(key: String, +value: Nat) -> Bytes.Bytes & Json.Val:
  (Json.utf8(key), Bool.pick(Json.Val, Nat.is_eq(value, 0n), Json.Null{}, Json.Num{Json.utf8(Nat.show(value))}))
def number(key: String, value: Nat) -> Bytes.Bytes & Json.Val:
  (Json.utf8(key), Json.Num{Json.utf8(Nat.show(value))})


def render(fields: List<&1, Bytes.Bytes & Json.Val>) -> String:
  Bytes.to_string(Json.encode.bytes(Json.Obj{fields}))

def projection(+kind: String, +repo: String, identity: String, timestamp: Nat,
    fields: List<&1, Bytes.Bytes & Json.Val>) -> Projection:
  Projected{String.append(kind, String.append(":", String.append(repo, String.append(":", identity)))),
    render(string("kind", kind) <> string("repository", repo) <> clock("timestampMs", timestamp) <> fields)}

def finish(key: String, digest: String, body: String, observed: Nat) -> String:
  String.append("{\"eventId\":\"", String.append(digest,
    String.append(":", String.append(key,
      String.append("\",\"observedMs\":", String.append(Nat.show(observed),
        String.append(",", String.drop(body, 1n))))))))

def choose(+condition: Bool, +value: String) -> String:
  Bool.pick(String, condition, value, "")

def known_clock(condition: Bool, +value: Nat) -> Nat:
  Bool.pick(Nat, condition, value, 0n)

def ordered(+start: Nat, end: Nat) -> Bool:
  Bool.and(Nat.is_gt(start, 0n), Nat.is_le(start, end))

def pull(+repo: String, base: String, +number: String, +state: String, +head: String, +merge: String,
    +opened: Nat, +merged: Nat, +updated: Nat) -> Projection:
  +closed = String.eq(state, "closed")
  +valid = Bool.and(String.eq(repo, base), Bool.and(identifier(number),
    Bool.and(ordered(opened, updated), Bool.or(closed, String.eq(state, "open")))))
  +merged_at = known_clock(Bool.and(closed, Bool.and(ordered(opened, merged), ordered(merged, updated))), merged)
  +is_merged = Nat.is_gt(merged_at, 0n)
  Bool.pick(Projection, valid, projection("github_pr", repo, number, Nat.max(opened, merged_at), [
    string("prNumber", number), string("status", Bool.pick(String, is_merged, "merged", state)),
    optional("headSha", choose(sha(head), head)), optional("mergeSha", choose(Bool.and(is_merged, sha(merge)), merge)),
    clock("openedMs", opened), clock("mergedMs", merged_at), clock("updatedMs", updated)]), Rejected{})

def one_of(+value: String, values: List<&2, String>) -> Bool:
  match values:
    case []: False{}
    case head <> rest: Bool.or(String.eq(value, head), one_of(value, rest))

def source_status(+value: String) -> String:
  choose(one_of(value, ["completed", "queued", "pending", "waiting", "in_progress", "requested"]), value)

def source_conclusion(+value: String, terminal: Bool) -> String:
  choose(Bool.and(terminal, one_of(value, ["success", "failure", "cancelled", "skipped",
    "neutral", "timed_out", "action_required", "startup_failure", "stale"])), value)

def terminal(status: String) -> Bool:
  String.eq(status, "completed")

type Link is Data:
  Link{number: String, base: String}

def pull_link(+repo_id: String, links: List<&2, Link>) -> String:
  match links:
    case [Link{+number, base}]:
      choose(Bool.and(identifier(repo_id), Bool.and(String.eq(repo_id, base), identifier(number))), number)
    case _: ""

def exact_attempt(run: String, actual_run: String, attempt: U32, actual_attempt: U32, head: String, actual_head: String) -> Bool:
  Bool.and(String.eq(run, actual_run), Bool.and(U32.is_eq(attempt, actual_attempt), String.eq(head, actual_head)))

def attempt_key(run: String, attempt: U32) -> String:
  String.append(run, String.append(":", Nat.show(U32.to_nat(attempt))))

def attempt_record(repo: String, +run: String, +attempt: U32, head: String, +workflow: String,
    +status: String, conclusion: String, pr: String, +created: Nat, +started: Nat, +updated: Nat,
    +earliest_job_start: Nat, +last_job_completed: Nat, job_count: U32, jobs_complete: Bool) -> Projection:
  +first = U32.is_eq(attempt, 1)
  +created_at = known_clock(first, created)
  +start_at = known_clock(Bool.and(first, Bool.and(ordered(created, started),
    Bool.and(ordered(started, earliest_job_start), ordered(started, updated)))), started)
  +done = terminal(status)
  +last = known_clock(done, last_job_completed)
  +anchor = Bool.pick(Nat, Nat.is_gt(start_at, 0n), start_at, Bool.pick(Nat, first, created_at, earliest_job_start))
  projection("github_actions_attempt", repo, attempt_key(run, attempt), anchor, [
    string("runId", run), string("attempt", Nat.show(U32.to_nat(attempt))), string("headSha", head),
    optional("workflowId", choose(identifier(workflow), workflow)), optional("prNumber", pr),
    optional("status", source_status(status)), optional("conclusion", source_conclusion(conclusion, done)),
    clock("createdMs", created_at), clock("startedMs", start_at), clock("completedMs", 0n),
    clock("updatedMs", updated), clock("lastJobCompletedMs", last), number("jobCount", U32.to_nat(job_count)), (Json.utf8("jobsComplete"), Json.Flag{jobs_complete})])

def safe_job_name(value: String) -> Bool:
  safe_atom(value, 120n, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-()/,+[]")

def job_name(+value: String, allowed: List<&2, String>) -> String:
  Bool.pick(String, Bool.and(safe_job_name(value), one_of(value, allowed)), value, "Other jobs")

def exact_job(+id: String, run: String, actual_run: String, attempt: U32, actual_attempt: U32,
    head: String, actual_head: String, absent_attempt: Bool) -> Bool:
  Bool.and(identifier(id), Bool.and(String.eq(run, actual_run), Bool.and(String.eq(head, actual_head),
    Bool.or(absent_attempt, U32.is_eq(attempt, actual_attempt)))))

def job_start(+created: Nat, +started: Nat, assigned: Bool, +status: String, conclusion: String, attempt: U32) -> Nat:
  pending = one_of(status, ["queued", "pending", "waiting", "requested"])
  known_clock(Bool.and(assigned, Bool.and(Bool.not(pending), Bool.and(Bool.not(String.eq(conclusion, "skipped")),
    Bool.and(Nat.is_le(created, started), Bool.or(U32.is_eq(attempt, 1), Nat.is_gt(created, 0n)))))), started)

def job_end(+started: Nat, +completed: Nat, status: String) -> Nat:
  known_clock(Bool.and(terminal(status), ordered(started, completed)), completed)

def job_record(repo: String, +run: String, +attempt: U32, +id: String, head: String, name: String, allowed: List<&2, String>,
    +status: String, conclusion: String, +created: Nat, +started: Nat, +completed: Nat) -> Projection:
  +anchor = Nat.max(completed, Nat.max(started, created))
  projection("github_actions_job", repo, String.append(attempt_key(run, attempt), String.append(":", id)), anchor, [
    string("runId", run), string("attempt", Nat.show(U32.to_nat(attempt))), string("jobId", id), string("headSha", head),
    string("jobName", job_name(name, allowed)), optional("status", source_status(status)),
    optional("conclusion", source_conclusion(conclusion, terminal(status))), clock("createdMs", created),
    clock("startedMs", started), clock("completedMs", completed)])
