import Base
import ../../evidence/repository.bend as Repository

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

def job_clocks(+created: U32, +started: U32, completed: U32, +status: String, conclusion: String, assigned: Bool, zero_runner: Bool, first_attempt: Bool) -> JobClocks:
  choose_clocks(created, started, completed, allocation(status, conclusion, assigned, zero_runner),
    Bool.and(String.eq(status, "completed"), Bool.or(first_attempt, U32.is_ne(created, 0))),
    has_prior_execution(created, started))

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
    <> "macos / platform (macos-15-intel)" <> "macos / Native acceptance (macos-15-intel)"
    <> "linux / Build x86_64 AppImage" <> "linux / Linux aarch64"
    <> "linux / desktop-ui (ubuntu-24.04)" <> "linux / Linux x86_64" <> "linux / cli"
    <> "publish-linux" <> "publish-nightly" <> [], "Other jobs")

def common_step(value: String) -> String:
  keep_label(value, "Set up job" <> "Assemble signed notarized candidate" <> "Validate candidate installation"
    <> "Sign Sparkle bytes and seal candidate" <> "Complete job" <> [], "Other steps")

def intel_setup_step(+value: String) -> String:
  keep_label(value, "Run actions/checkout@v4" <> "Run actions/setup-node@v4" <> [], common_step(value))

def intel_platform_step(+value: String) -> String:
  keep_label(value, "Select the macOS 26 SDK required by native helpers"
    <> "Pin selected Xcode for native builds" <> "Install the Metal toolchain"
    <> "Prepare hosted Ubuntu package transport" <> "Linux application dependencies"
    <> "Install CLI export speedup dependencies" <> "Run dtolnay/rust-toolchain@stable"
    <> "Normalize the disposable Intel Mac compiler inventory" <> "Run Swatinem/rust-cache@v2"
    <> "Prepare private temporary root before first Cargo" <> "Cache Electron downloads (not installed modules or test receipts)"
    <> "Prepare locked native prerequisites before first Cargo"
    <> "Install Mac renderer dependencies when native preparation did not install them"
    <> "Verify Mac installer replacement transactions" <> "Timing helper contracts"
    <> "Agent setup policy and native metadata contracts (no Rust required)" <> "Local Desktop install reuse contracts"
    <> "Prepare Mac Electron before timed renderer tests" <> "Mac Electron platform checks"
    <> "Qualify Record media through the published Engine provider" <> "Qualify Agent frames through the published Engine provider"
    <> "Mac Cargo source-identity freshness regression" <> "CI-sensitive fixtures before native checks"
    <> "Build and package the exact Mac candidate for native checks"
    <> "Retain the installed Mac CI candidate for a separate native test run" <> "Upload the pending native test candidate"
    <> "Early Mac Electron to Rust Settings integration (not native GUI proof)"
    <> "Actual Electron to Rust Settings integration (not native GUI proof)"
    <> "Execute the same changed-tree checks (not GUI acceptance)"
    <> "Prepare the client-owned TypeScript policy for native consumers"
    <> "Independent Connect client build and tests" <> [], intel_setup_step(value))

def intel_acceptance_step(+value: String) -> String:
  keep_label(value, "Select the macOS 26 SDK required by native helpers"
    <> "Install native test driver dependencies" <> "Authenticate and install the exact retained candidate"
    <> "Native Mac Storage and error-reporting controls against the installed Rust GUI"
    <> "Native GPUI Copy capture ID against the same installed App"
    <> "Native Electron selected-reference control against the installed Rust App"
    <> "Installed Mac foreground capture and sharing" <> [], intel_setup_step(value))

def linux_build_step(+value: String) -> String:
  keep_label(value, "Package" <> "Unit tests and model test executable"
    <> "Build with PostHog error reporting" <> [], common_step(value))

def step_label(+job: String, +value: String) -> String:
  Bool.pick(String, String.eq(job, "macos / platform (macos-15-intel)"), intel_platform_step(value),
    Bool.pick(String, String.eq(job, "macos / Native acceptance (macos-15-intel)"), intel_acceptance_step(value),
      Bool.pick(String, Bool.or(String.eq(job, "linux / Build x86_64 AppImage"), String.eq(job, "linux / Linux aarch64")),
        linux_build_step(value), common_step(value))))

def attempt_matches(run: String, attempt: String, sha: String, expected_run: String, expected_attempt: String, expected_sha: String) -> Bool:
  Bool.and(String.eq(run, expected_run), Bool.and(String.eq(attempt, expected_attempt), String.eq(sha, expected_sha)))

def job_matches(run: String, attempt: String, sha: String, expected_run: String, expected_attempt: String, expected_sha: String, missing_attempt: Bool) -> Bool:
  Bool.and(String.eq(run, expected_run), Bool.and(String.eq(sha, expected_sha),
    Bool.or(missing_attempt, String.eq(attempt, expected_attempt))))

def page_matches(+total: U32, +offset: U32, length: U32) -> Bool:
  Bool.and(U32.is_le(offset, total), U32.is_eq(length, U32.min(100, (total - offset : U32))))

def same_count(left: U32, right: U32) -> Bool:
  U32.is_eq(left, right)

def stable_attempt(metadata: String, confirmed_metadata: String, jobs: String, confirmed_jobs: String) -> Bool:
  Bool.and(String.eq(metadata, confirmed_metadata), String.eq(jobs, confirmed_jobs))

def attempt_start(first_attempt: Bool, jobs: U32, started: U32) -> U32:
  Bool.pick(U32, Bool.and(first_attempt, U32.is_ne(jobs, 0)), started, 0)

def window_valid(start: U32, end: U32, +pages: U32, +limit: U32) -> Bool:
  Bool.and(known_interval(start, end), Bool.and(U32.is_le(1, pages),
    Bool.and(U32.is_le(pages, 10), Bool.and(U32.is_le(1, limit), U32.is_le(limit, 20)))))

def in_window(+created: U32, start: U32, end: U32) -> Bool:
  Bool.and(U32.is_le(start, created), U32.is_le(created, end))

def select_run(position: U32, limit: U32) -> Bool:
  U32.is_lt(position, limit)

def inventory_complete(eligible: U32, +total: U32) -> Bool:
  Bool.and(U32.is_eq(eligible, total), U32.is_lt(total, 1000))

def discoverable_count(total: U32) -> U32:
  U32.min(total, 1000)

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

def valid_repository(value: String) -> Bool:
  Repository.valid(value)
