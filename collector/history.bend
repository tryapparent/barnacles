import Base
import ../evidence/repository.bend as Repository

type Scope is Data:
  Scope{environment: String, project: String, repository: String}

type Progress is Data:
  Progress{position: U32, total: U32, revision: String, status: String}

type Page is Data:
  Page{next: U32, total: U32, revision: String, more: Bool, settled: Bool}

type Item is Data:
  Item{position: U32, id: String, owner: String, visibility: String, kind: String, status: String, seconds: U32, millis: U32}

type Fact is Data:
  Fact{position: U32, id: String, kind: String, status: String, seconds: U32, millis: U32}

type Receipt is Data:
  Invalid{}
  Accepted{progress: Progress, facts: List<&2, Fact>}

type Items is Data:
  Gap{}
  Contiguous{last: U32, facts: List<&2, Fact>}

def valid_limit(+value: U32) -> Bool:
  Bool.and(U32.is_ge(value, 1), U32.is_le(value, 8))

def canonical_repository(value: String) -> String:
  Repository.normalized(value)

def target_count(value: U32) -> Bool:
  U32.is_ne(value, 0)

def pending(status: String) -> Bool:
  Bool.not(String.eq(status, "complete"))

def prefer(generation: U32, current: U32) -> Bool:
  U32.is_lt(generation, current)

def thread_matches(thread: String, project: String, expected_thread: String, expected_project: String) -> Bool:
  Bool.and(String.eq(thread, expected_thread), String.eq(project, expected_project))

def same(left: Scope, right: Scope) -> Bool:
  match left right:
    case Scope{environment, project, repository} Scope{other_environment, other_project, other_repository}:
      Bool.and(String.eq(environment, other_environment),
        Bool.and(String.eq(project, other_project), String.eq(repository, other_repository)))

def tool_kind(+value: String) -> Bool:
  Bool.or(String.eq(value, "command_execution"), Bool.or(String.eq(value, "dynamic_tool"), String.eq(value, "tool_call")))

def one_of(+value: String, candidates: List<&2, String>) -> String:
  match candidates:
    case []: "unknown"
    case head <> tail:
      Bool.pick(String, String.eq(value, head), value, one_of(value, tail))

def add_item(state: Items, item: Item, +thread: String) -> Items:
  match state item:
    case Gap{} _: Gap{}
    case Contiguous{last, +facts} Item{+position, id, owner, visibility, +kind, status, seconds, millis}:
      keep = Bool.and(String.eq(owner, thread), Bool.and(String.eq(visibility, "local"), tool_kind(kind)))
      normalized = one_of(status, "pending" <> "running" <> "waiting" <> "completed" <> "failed" <> "cancelled" <> "interrupted" <> [])
      Bool.pick(Items, U32.is_eq(position, U32.inc(last)),
        Contiguous{position, Bool.pick(List<&2, Fact>, keep, Fact{position, id, kind, normalized, seconds, millis} <> facts, facts)},
        Gap{})

def scan(items: List<&2, Item>, state: Items, +thread: String) -> Items:
  match items:
    case []: state
    case head <> tail: scan(tail, add_item(state, head, thread), thread)

def page_result(value: Items, previous: U32, +next: U32, +total: U32, +revision: String, +more: Bool) -> Receipt:
  match value:
    case Gap{}: Invalid{}
    case Contiguous{last, facts}:
      +continuing = U32.is_lt(next, total)
      valid = Bool.and(U32.is_eq(last, next), Bool.and(U32.is_le(next, total),
        Bool.and(Bool.pick(Bool, more, continuing, Bool.not(continuing)), Bool.or(Bool.not(more), U32.is_lt(previous, next)))))
      Bool.pick(Receipt, valid,
        Accepted{Progress{next, total, revision, Bool.pick(String, more, "partial", "complete")}, facts}, Invalid{})

def admit_page(valid: Bool, items: List<&2, Item>, +thread: String, +position: U32, next: U32, total: U32, revision: String, more: Bool) -> Receipt:
  match valid:
    case True{}:
      collected = scan(items, Contiguous{position, []}, thread)
      page_result(collected, position, next, total, revision, more)
    case False{}: Invalid{}

def activity(previous: Progress, incoming: Page, thread: String, items: List<&2, Item>) -> Receipt:
  match previous incoming:
    case Progress{position, total, +revision, status} Page{next, +new_total, +new_revision, more, settled}:
      stable = Bool.or(String.eq(revision, ""),
        Bool.and(String.eq(revision, new_revision), U32.is_eq(total, new_total)))
      admit_page(Bool.and(settled, Bool.and(stable, Bool.not(String.eq(new_revision, "")))),
        items, thread, position, next, new_total, new_revision, more)

def exact_status(status: String) -> String:
  Bool.pick(String, String.eq(status, "completed"), "complete", "partial")

def HTTP_status(+status: U32, limited: Bool, expired: Bool, budget: Bool) -> String:
  Bool.pick(String, Bool.or(limited, U32.is_eq(status, 429)), "rate-limited",
    Bool.pick(String, Bool.or(expired, U32.is_eq(status, 410)), "expired",
      Bool.pick(String, Bool.or(U32.is_eq(status, 401), U32.is_eq(status, 403)), "inaccessible",
        Bool.pick(String, U32.is_eq(status, 404), "missing",
          Bool.pick(String, budget, "budget-exhausted", "partial")))))


def stop_reads(+status: String, session_expired: Bool) -> Bool:
  Bool.or(session_expired, Bool.or(String.eq(status, "rate-limited"), String.eq(status, "budget-exhausted")))
