import Base

type JobClocks is Data:
  Clocks{queue_end: U32, execution_end: U32, prior_execution: Bool}

def known_interval(+start: U32, end: U32) -> Bool:
  Bool.and(U32.is_ne(start, 0), U32.is_le(start, end))

def has_prior_execution(created: U32, +started: U32) -> Bool:
  Bool.and(U32.is_ne(started, 0), U32.is_lt(started, created))

def pending(+status: String) -> Bool:
  Bool.or(String.eq(status, "queued"), Bool.or(String.eq(status, "pending"),
    Bool.or(String.eq(status, "waiting"), String.eq(status, "requested"))))

def queue_end(created: U32, +ended: U32) -> U32:
  Bool.pick(U32, known_interval(created, ended), ended, 0)

def allocated_clocks(+created: U32, +started: U32, +completed: U32, finished: Bool, +prior: Bool) -> JobClocks:
  Clocks{queue_end(created, started),
    Bool.pick(U32, Bool.and(finished, Bool.and(Bool.not(prior), known_interval(started, completed))), completed, 0),
    prior}

def choose_clocks(created: U32, started: U32, completed: U32, allocation: U32, finished: Bool, +prior: Bool) -> JobClocks:
  match allocation:
    case 1: allocated_clocks(created, started, completed, finished, prior)
    case 2: Clocks{Bool.pick(U32, prior, 0, queue_end(created, completed)), 0, prior}
    case _: Clocks{0, 0, prior}

def allocation(+status: String, +conclusion: String, assigned: Bool, zero_runner: Bool) -> U32:
  Bool.pick(U32, Bool.or(pending(status), String.eq(conclusion, "skipped")), 0,
    Bool.pick(U32, assigned, 1,
      Bool.pick(U32, Bool.and(zero_runner, Bool.and(String.eq(status, "completed"), String.eq(conclusion, "cancelled"))), 2, 0)))

def job_clocks(+created: U32, +started: U32, completed: U32, +status: String, conclusion: String, assigned: Bool, zero_runner: Bool) -> JobClocks:
  choose_clocks(created, started, completed, allocation(status, conclusion, assigned, zero_runner),
    String.eq(status, "completed"), has_prior_execution(created, started))

def step_known(+start: U32, +end: U32, +job_start: U32, +job_end: U32, status: String, conclusion: String) -> Bool:
  Bool.and(String.eq(status, "completed"), Bool.and(Bool.not(String.eq(conclusion, "skipped")),
    Bool.and(known_interval(job_start, job_end), Bool.and(known_interval(start, end),
      Bool.and(U32.is_le(job_start, start), U32.is_le(end, job_end))))))

def keep_label(+value: String, allowed: List<&2, String>, +fallback: String) -> String:
  match allowed:
    case []: fallback
    case candidate <> rest:
      Bool.pick(String, String.eq(value, candidate), value, keep_label(value, rest, fallback))

def source_status(value: String) -> String:
  keep_label(value, "completed" <> "queued" <> "pending" <> "waiting" <> "in_progress" <> "requested" <> [], "unknown")

def source_conclusion(value: String) -> String:
  keep_label(value, "success" <> "failure" <> "cancelled" <> "skipped" <> "neutral" <> "timed_out"
    <> "action_required" <> "startup_failure" <> "stale" <> [], "unknown")

def job_label(value: String) -> String:
  keep_label(value, "admit" <> "macos / frontend" <> "macos / Build signed Mac candidate"
    <> "linux / Build x86_64 AppImage" <> "linux / cli" <> "publish-linux" <> "publish-nightly" <> [], "Other jobs")

def step_label(value: String) -> String:
  keep_label(value, "Set up job" <> "Assemble signed notarized candidate" <> "Validate candidate installation"
    <> "Sign Sparkle bytes and seal candidate" <> "Complete job" <> [], "Other steps")

def attempt_matches(run: String, attempt: String, sha: String, expected_run: String, expected_attempt: String, expected_sha: String) -> Bool:
  Bool.and(String.eq(run, expected_run), Bool.and(String.eq(attempt, expected_attempt), String.eq(sha, expected_sha)))

def job_matches(run: String, attempt: String, sha: String, expected_run: String, expected_attempt: String, expected_sha: String, missing_attempt: Bool) -> Bool:
  Bool.and(String.eq(run, expected_run), Bool.and(String.eq(sha, expected_sha),
    Bool.or(missing_attempt, String.eq(attempt, expected_attempt))))

type IdInventory is Data:
  Ids{count: U32, seen: Map<&2, Bool>}
  Repeated{}

def insert_unique(id: String, count: U32, found: Map<&2, Bool> & Bool) -> IdInventory:
  match found:
    case Tuple{seen, True{}}: Repeated{}
    case Tuple{seen, False{}}: Ids{U32.inc(count), Map.set(&2, Bool, seen, id, True{})}

def add_id(inventory: IdInventory, +id: String) -> IdInventory:
  match inventory:
    case Ids{count, seen}: insert_unique(id, count, Map.has(&2, Bool, seen, id))
    case Repeated{}: Repeated{}

def unique_result(inventory: IdInventory) -> Bool:
  match inventory:
    case Ids{count, seen}: True{}
    case Repeated{}: False{}

def unique_steps(ids: List<&2, String>) -> Bool:
  unique_result(List.foldl(~&2, ~String, ~IdInventory, ~(state => id => add_id(state, id)), ids, Ids{0, Map.new(&2, Bool)}))

type Inventory is Data:
  More{expected: String, count: U32, seen: Map<&2, Bool>}
  Complete{}
  Invalid{}
  Duplicate{}
  Partial{}

def empty_inventory() -> Inventory:
  More{"", 0, Map.new(&2, Bool)}

def page_result(ids: IdInventory, expected: String, +total: U32, page: U32, size: U32) -> Inventory:
  match ids:
    case Repeated{}: Duplicate{}
    case Ids{+count, seen}:
      Bool.pick(Inventory, U32.is_eq(count, total), Complete{},
        Bool.pick(Inventory, Bool.or(U32.is_ge(page, 10), Bool.or(U32.is_eq(size, 0), U32.is_gt(count, total))),
          Partial{}, More{expected, count, seen}))

def valid_job_page(previous: Inventory, +expected: String, size: U32, array_seen: Bool) -> Bool:
  match previous:
    case More{+old, count, seen}:
      Bool.and(array_seen, Bool.and(U32.is_le(size, 100),
        Bool.and(Bool.not(String.eq(expected, "")), Bool.or(String.eq(old, ""), String.eq(old, expected)))))
    case _: False{}

def job_page(previous: Inventory, expected: String, total: U32, page: U32, size: U32, ids: List<&2, String>) -> Inventory:
  match previous:
    case More{+old, count, seen}:
      page_result(List.foldl(~&2, ~String, ~IdInventory, ~(state => id => add_id(state, id)), ids, Ids{count, seen}), expected, total, page, size)
    case _: Invalid{}
