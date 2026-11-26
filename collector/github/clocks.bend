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
