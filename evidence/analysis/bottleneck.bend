import Base
import ./tool-refusals.bend as Tools

type FileTotal is Data:
  FileTotal{path: String, requests: U32, threads: U32, revisits: U32}

type Cost is Data:
  Cost{clock: String, operation: String, count: U32, seconds: U32, unknown: U32}

type Finding is Data:
  Finding{rule: String, thread: String, id: String, previous: String, seconds: U32, median: U32, p90: U32, peers: U32}

type RulePattern is Data:
  RulePattern{rule: String, threads: U32, findings: U32, timed: U32, largestSeconds: U32}

type RulePatterns is Data:
  RulePatterns{threads: Map<&2, Bool>, totals: Map<&2, RulePattern>}

type Attempt is Data:
  Attempt{id: String, started: U32, ended: U32, failed: Bool}

type Peer is Data:
  Peer{revision: String, ended: U32, seconds: U32}

type RunStatusRead is Data:
  RunStatusRead{id: String, snapshot: String, at: U32, streak: U32}

type Replay is Data:
  Replay{seen: Map<&2, Bool>, files: Map<&2, FileTotal>, reads: Map<&2, U32>,
    costs: Map<&2, Cost>, attempts: Map<&2, Attempt>, cohorts: Map<&2, List<&2, Peer>>,
    status_reads: Map<&2, RunStatusRead>, findings: List<&2, Finding>}

def start_replay() -> Replay:
  Replay{Map.new(&2, Bool), Map.new(&2, FileTotal), Map.new(&2, U32), Map.new(&2, Cost),
    Map.new(&2, Attempt), Map.new(&2, List<&2, Peer>), Map.new(&2, RunStatusRead), []}

def pair(+a: String, b: String) -> String:
  String.append(Nat.show(String.length(a)), String.append(":", String.append(a, b)))

def local_source(thread: String, source: String, visibility: String) -> Bool:
  Bool.and(String.eq(thread, source), String.eq(visibility, "local"))

def closed_clock(+start: U32, end: U32) -> Bool:
  Bool.and(U32.is_gt(start, 0), U32.is_ge(end, start))

def found(~A: Data, value: Map<&2, A> & A) -> A:
  match value:
    case Tuple{_, item}: item

def includes(seen: Map<&2, Bool>, key: String) -> Bool:
  found(~Bool, Map.get(Bool, False{}, seen, key))

def update_file_total(files: Map<&2, FileTotal>, +path: String, +previous: U32, +at: U32,
  total: FileTotal) -> Map<&2, FileTotal>:
  match total:
    case FileTotal{_, requests, threads, revisits}:
      +first = U32.is_eq(previous, 0)
      +quick = Bool.and(Bool.not(first), U32.is_lt(U32.sub(at, previous), 900))
      Map.set(&2, FileTotal, files, path, FileTotal{path, U32.inc(requests),
        U32.add(threads, Bool.pick(U32, first, 1, 0)), U32.add(revisits, Bool.pick(U32, quick, 1, 0))})

def file_total(+files: Map<&2, FileTotal>, +path: String, +previous: U32, +at: U32) -> Map<&2, FileTotal>:
  update_file_total(files, path, previous, at, found(~FileTotal, Map.get(FileTotal, FileTotal{path, 0, 0, 0}, files, path)))

def observe_file(state: Replay, +thread: String, +id: String, +path: String, +at: U32) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +event = pair("file", pair(thread, pair(id, path)))
      +thread_path = pair(thread, path)
      +previous = found(~U32, Map.get(U32, 0, reads, thread_path))
      +duplicate = includes(seen, event)
      +ordered = U32.is_ge(at, previous)
      +valid = Bool.and(Bool.not(duplicate), Bool.and(ordered, U32.is_gt(at, 0)))
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}),
          file_total(files, path, previous, at), Map.set(&2, U32, reads, thread_path, at),
          costs, attempts, cohorts, status_reads, findings},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def update_cost(costs: Map<&2, Cost>, key: String, clock: String, operation: String, +closed: Bool, duration: U32,
  total: Cost) -> Map<&2, Cost>:
  match total:
    case Cost{_, _, count, seconds, unknown}:
      Map.set(&2, Cost, costs, key, Cost{clock, operation,
        U32.add(count, Bool.pick(U32, closed, 1, 0)),
        U32.add(seconds, Bool.pick(U32, closed, duration, 0)),
        U32.add(unknown, Bool.pick(U32, closed, 0, 1))})

def add_cost(+costs: Map<&2, Cost>, +clock: String, +operation: String, closed: Bool, duration: U32) -> Map<&2, Cost>:
  +key = pair(clock, operation)
  update_cost(costs, key, clock, operation, closed, duration,
    found(~Cost, Map.get(Cost, Cost{clock, operation, 0, 0, 0}, costs, key)))

def observe_timing(state: Replay, id: String, +clock: String, operation: String, +start: U32, +end: U32) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +event = pair("timing", pair(clock, id))
      +closed = closed_clock(start, end)
      Bool.pick(Replay, includes(seen, event), Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings},
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          add_cost(costs, clock, operation, closed, U32.sub(end, start)), attempts, cohorts, status_reads, findings})

def record_t3_envelope(state: Replay, +thread: String, +id: String, +clock: String, operation: String, +seconds: U32,
  valid: Bool, deadline: Bool, rule: String) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +key = pair(clock, pair(thread, id))
      +accept = Bool.and(valid, Bool.not(includes(seen, key)))
      +recorded = Bool.pick(List<&2, Finding>, deadline,
        Finding{rule, thread, id, "", seconds, 0, 0, 0} <> findings, findings)
      Bool.pick(Replay, accept,
        Replay{Map.set(&2, Bool, seen, key, True{}), files, reads,
          add_cost(costs, clock, operation, True{}, seconds), attempts, cohorts, status_reads, recorded},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_t3_command_envelope(state: Replay, +thread: String, id: String, source_thread: String, visibility: String,
  +item_type: String, +status: String, +operation: String, +started: U32, +completed: U32, observed: U32,
  +elapsed_ms: U32, +receipt: String, +limit: U32) -> Replay:
  +local = local_source(thread, source_thread, visibility)
  +command = String.eq(item_type, "command_execution")
  +mcp = String.eq(item_type, "dynamic_tool")
  +known_call = Bool.or(String.eq(operation, "t3-thread-wait"), String.eq(operation, "t3-delegate-task"))
  +failed = String.eq(status, "failed")
  +terminal = Bool.or(failed, Bool.or(String.eq(status, "completed"), String.eq(status, "interrupted")))
  +seconds = U32.div(elapsed_ms, 1000)
  +endpoints = U32.sub(completed, started)
  +ordered = Bool.and(closed_clock(started, completed), U32.is_ge(observed, completed))
  +consistent = Bool.and(U32.is_ge(endpoints, seconds), U32.is_le(endpoints, U32.inc(seconds)))
  +bound = Bool.and(U32.is_gt(limit, 0), U32.is_le(limit, 86400))
  +expected = U32.mul(limit, 1000)
  +close = Bool.and(U32.is_ge(U32.add(elapsed_ms, 2000), expected), U32.is_le(elapsed_ms, U32.add(expected, 2000)))
  +receipt_ok = String.eq(receipt, Bool.pick(String, mcp, "mcp-tool-deadline", "terminal-tool-deadline"))
  +deadline = Bool.and(failed, Bool.and(receipt_ok, Bool.and(bound, close)))
  +source = Bool.and(local, Bool.or(command, Bool.and(mcp, Bool.and(known_call, deadline))))
  +valid = Bool.and(source, Bool.and(terminal, Bool.and(ordered, consistent)))
  +clock = Bool.pick(String, mcp, "t3-mcp-tool-envelope", "t3-command-envelope")
  +rule = Bool.pick(String, mcp, "t3-mcp-tool-deadline", "t3-terminal-tool-deadline")
  record_t3_envelope(state, thread, id, clock, operation, seconds, valid, deadline, rule)

def observe_local_admission(state: Replay, +thread: String, +id: String, +wait_ms: U32, bound_ms: U32,
  +allocated: U32, capacity: U32) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +event = pair("local-admission", pair(thread, id))
      +allocation_valid = Bool.and(U32.is_gt(allocated, 0), U32.is_ge(capacity, allocated))
      +valid = Bool.and(Bool.not(includes(seen, event)), Bool.and(allocation_valid, U32.is_ge(bound_ms, wait_ms)))
      +seconds = U32.div(wait_ms, 1000)
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          add_cost(costs, "local-build-admission", "t3-build", True{}, seconds), attempts, cohorts, status_reads,
          Bool.pick(List<&2, Finding>, U32.is_ge(wait_ms, 60000),
            Finding{"local-build-admission-slow", thread, id, "", seconds, 0, 0, 0} <> findings, findings)},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def update_attempt(state: Replay, thread: String, +id: String, +start: U32, +end: U32, failed: Bool,
  succeeded: Bool, +event: String, target: String, prior: Attempt) -> Replay:
  match state prior:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings} Attempt{previous, +last_start, +last_end, last_failed}:
          +valid = Bool.and(Bool.not(includes(seen, event)), Bool.and(U32.is_gt(start, 0),
            Bool.and(U32.is_ge(start, last_start), U32.is_ge(end, start))))
          +recovery = Bool.and(succeeded, Bool.and(last_failed,
            Bool.and(U32.is_ge(start, last_end), U32.is_le(U32.sub(start, last_end), 1800))))
          Bool.pick(Replay, valid,
            Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs,
              Map.set(&2, Attempt, attempts, target, Attempt{id, start, end, failed}), cohorts, status_reads,
              Bool.pick(List<&2, Finding>, recovery, Finding{"recovered-attempt", thread, id, previous,
                U32.sub(end, last_end), 0, 0, 0} <> findings, findings)},
            Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_attempt(+state: Replay, +thread: String, +id: String, key: String, +start: U32, +end: U32,
  +failed: Bool, +succeeded: Bool) -> Replay:
  match state:
    case Replay{_, _, _, _, attempts, _, _, _}:
      +event = pair("attempt", pair(thread, id))
      +target = pair("attempt", pair(thread, key))
      update_attempt(state, thread, id, start, end, failed, succeeded, event, target,
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, target)))

def update_repeat(state: Replay, thread: String, +id: String, label: String, +start: U32, end: U32,
  seconds: U32, valid: Bool, +target: String, +event: String, prior: Attempt) -> Replay:
  match state prior:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings} Attempt{previous, _, +last_end, _}:
      +ordered = Bool.and(U32.is_gt(start, 0), U32.is_ge(start, last_end))
      +accept = Bool.and(valid, Bool.and(ordered, Bool.not(includes(seen, event))))
      Bool.pick(Replay, accept,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs,
          Map.set(&2, Attempt, attempts, target, Attempt{id, start, end, False{}}), cohorts, status_reads,
          Bool.pick(List<&2, Finding>, U32.is_gt(last_end, 0),
            Finding{label, thread, id, previous, seconds, 0, 0, 0} <> findings, findings)},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_repeat(+state: Replay, +thread: String, id: String, +label: String, scope: String, execution: String,
  start: U32, end: U32, seconds: U32, valid: Bool) -> Replay:
  match state:
    case Replay{_, _, _, _, attempts, _, _, _}:
      +target = pair("repeat", pair(label, pair(thread, scope)))
      update_repeat(state, thread, id, label, start, end, seconds, valid, target, pair(target, execution),
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, target)))

def observe_hosted_test_failure(state: Replay, thread: String, id: String, scope: String, lane: String,
  test: String, execution: String, conclusion: String, +at: U32) -> Replay:
  observe_repeat(state, thread, id, "ci-test-failure-repeated", pair(scope, pair(lane, test)), execution,
    at, at, 0, String.eq(conclusion, "failure"))

def observe_hosted_test_fanout(state: Replay, thread: String, id: String, scope: String, lane: String,
  revision: String, failure: String, conclusion: String, +at: U32) -> Replay:
  observe_repeat(state, thread, id, "ci-test-failure-cross-lane", pair(scope, pair(revision, failure)), lane,
    at, at, 0, String.eq(conclusion, "failure"))

def observe_verification_poll(state: Replay, thread: String, +id: String, turn: String, invocation: String,
  +status: String, +at: U32) -> Replay:
  +in_progress = Bool.or(String.eq(status, "active"), String.eq(status, "activating"))
  observe_repeat(state, thread, id, "local-verification-state-repolled", pair(turn, pair(invocation, status)),
    id, at, at, 0, in_progress)

def advance_run_status_read(state: Replay, thread: String, +id: String, +snapshot: String, +at: U32,
  +pending: Bool, +key: String, +event: String, prior: RunStatusRead) -> Replay:
  match state prior:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings} RunStatusRead{previous, old_snapshot, +last, +streak}:
      +accept = Bool.and(U32.is_gt(at, last), Bool.not(includes(seen, event)))
      +same = Bool.and(String.eq(snapshot, old_snapshot), U32.is_le(U32.sub(at, last), 300))
      +next = Bool.pick(U32, pending, Bool.pick(U32, same, U32.inc(streak), 1), 0)
      Bool.pick(Replay, accept,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs, attempts, cohorts,
          Map.set(&2, RunStatusRead, status_reads, key, RunStatusRead{id, snapshot, at, next}),
          Bool.pick(List<&2, Finding>, U32.is_ge(next, 3),
            Finding{"ci-manual-status-read-repeated", thread, id, previous, 0, 0, 0, 0} <> findings, findings)},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_manual_ci_status_read(+state: Replay, +thread: String, +id: String, repository: String,
  run: String, +attempt: U32, snapshot: String, at: U32, pending: Bool, mode: String) -> Replay:
  match state:
    case Replay{_, _, _, _, _, _, status_reads, _}:
      +key = pair(thread, pair(repository, pair(run, U32.show(attempt))))
      +event = pair("manual-ci-status-read", pair(key, id))
      +identified = Bool.and(String.eq(mode, "manual-watcher-log"), U32.is_gt(attempt, 0))
      Bool.pick(Replay, identified, advance_run_status_read(state, thread, id, snapshot, at, pending, key, event,
        found(~RunStatusRead, Map.get(RunStatusRead, RunStatusRead{"", "", 0, 0}, status_reads, key))), state)

def observe_package_build(state: Replay, thread: String, +id: String, scope: String, +tool: String,
  digest: String, +assets: U32, reported_ms: U32, +start: U32, +end: U32) -> Replay:
  +seconds = U32.div(reported_ms, 1000)
  +within_span = U32.is_ge(U32.sub(end, start), U32.sub(seconds, 1))
  +closed = Bool.and(U32.is_ge(end, start), Bool.and(U32.is_gt(seconds, 0), within_span))
  +valid = Bool.and(String.eq(tool, "vite-production-client"), Bool.and(U32.is_gt(assets, 0), closed))
  observe_repeat(state, thread, id, "ci-package-build-repeated",
    pair(scope, pair(tool, pair(digest, U32.show(assets)))), id, start, end, seconds, valid)

def earlier_peers(peers: List<&2, Peer>, +revision: String, +start: U32) -> List<&2, U32>:
  match peers:
    case []: []
    case Peer{rev, ended, seconds} <> rest:
      +remaining = earlier_peers(rest, revision, start)
      Bool.pick(List<&2, U32>, Bool.and(Bool.not(String.eq(rev, revision)), U32.is_le(ended, start)),
        seconds <> remaining, remaining)

def omit_revision(peers: List<&2, Peer>, +revision: String) -> List<&2, Peer>:
  match peers:
    case []: []
    case +peer <> +rest:
      match peer:
        case Peer{+rev, ended, seconds}:
          Bool.pick(List<&2, Peer>, String.eq(rev, revision), rest,
            Peer{rev, ended, seconds} <> omit_revision(rest, revision))

def keep_peer(peers: List<&2, Peer>, +revision: String, +ended: U32, +seconds: U32) -> List<&2, Peer>:
  List.take(&2, Peer, Peer{revision, ended, seconds} <> omit_revision(peers, revision), 64n)

def before(a: U32, b: U32) -> Bool:
  U32.is_lt(a, b)

def nth(values: List<&2, U32>, index: Nat) -> U32:
  match values index:
    case [] _: 0
    case value <> _ 0n: value
    case _ <> rest 1n+later: nth(rest, later)

def median(+values: List<&2, U32>, +n: Nat) -> U32:
  +lo = nth(values, Nat.div(Nat.sub(n, 1n), 2n))
  +hi = nth(values, Nat.div(n, 2n))
  U32.add(lo, U32.div(U32.sub(hi, lo), 2))

def with_outlier(+findings: List<&2, Finding>, +values: List<&2, U32>, +clock: String, thread: String,
  id: String, +seconds: U32) -> List<&2, Finding>:
  +n = List.length(&2, U32, values)
  +sorted = List.sort(~U32, ~before, values)
  +typical = median(sorted, n)
  +p90 = nth(sorted, Nat.div(Nat.sub(Nat.mul(n, 9n), 1n), 10n))
  +excess = U32.sub(seconds, typical)
  +flag = Bool.and(Nat.is_le(8n, n), Bool.and(U32.is_gt(seconds, p90),
    Bool.and(U32.is_ge(excess, 60), U32.is_ge(excess, typical))))
  Bool.pick(List<&2, Finding>, flag, Finding{clock, thread, id, "", seconds, typical, p90,
    U32.from_nat(n)} <> findings, findings)

def observe_peer(state: Replay, thread: String, +id: String, +clock: String, cohort: String,
  +revision: String, +start: U32, +end: U32, eligible: Bool) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +event = pair("peer", pair(clock, id))
      +key = pair(clock, cohort)
      +past = found(~List<&2, Peer>, Map.get(List<&2, Peer>, [], cohorts, key))
      +seconds = U32.sub(end, start)
      +valid = Bool.and(eligible, Bool.and(Bool.not(includes(seen, event)),
        closed_clock(start, end)))
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs, attempts,
          Map.set(&2, List<&2, Peer>, cohorts, key, keep_peer(past, revision, end, seconds)), status_reads,
          with_outlier(findings, earlier_peers(past, revision, start), clock, thread, id, seconds)},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def diagnostic_label(+line: String) -> String:
  +missing_checker = String.starts_with(line, "Staged checker could not load installed tools")
  +missing_typescript = Bool.and(String.starts_with(line, "Dependency policy failed: Staged TypeScript "),
    String.contains(line, ": locked TypeScript dependencies are missing for staged"))
  +directory_width = String.starts_with(String.append(line, " "), "pre-commit: staged candidate exceeds the directory-width limit: ")
  Bool.pick(String, directory_width, "staged-directory-width",
    Bool.pick(String, Bool.or(missing_checker, missing_typescript), "staged-verification-prerequisite", ""))

def observe_failure_with_duration(state: Replay, +thread: String, +id: String, +label: String,
  failed: Bool, seconds: U32) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +event = pair("failure", pair(thread, pair(label, id)))
      +valid = Bool.and(failed, Bool.and(Bool.not(String.is_empty(label)), Bool.not(includes(seen, event))))
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs, attempts, cohorts, status_reads,
          Finding{label, thread, id, "", seconds, 0, 0, 0} <> findings},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_failure(state: Replay, thread: String, id: String, label: String, failed: Bool) -> Replay:
  observe_failure_with_duration(state, thread, id, label, failed, 0)

def observe_t3_command_refusal(state: Replay, +thread: String, id: String, source_thread: String, visibility: String,
  item_type: String, status: String, +receipt: String, code: U32) -> Replay:
  +expected = Bool.pick(String, String.starts_with(receipt, "tool-"), "dynamic_tool", "command_execution")
  +local = Bool.and(local_source(thread, source_thread, visibility), String.eq(item_type, expected))
  observe_failure(state, thread, id, Tools.refusal_label((status, receipt, code)), local)

def observe_staged_source_budget(state: Replay, thread: String, id: String, operation: String, phase: String,
  unit: String, path: String, actual: U32, +allowance: U32, failed: Bool) -> Replay:
  +guard = Bool.and(String.eq(operation, "git-commit"), String.eq(phase, "budgets/style"))
  +checked_file = Bool.and(String.eq(unit, "source-tokens"), Bool.not(String.starts_with(path, "/")))
  +exceeded = Bool.and(U32.is_gt(allowance, 0), U32.is_gt(actual, allowance))
  observe_failure(state, thread, id, "staged-source-token-budget",
    Bool.and(failed, Bool.and(guard, Bool.and(checked_file, exceeded))))

def observe_verification_fixture_comparison(state: Replay, thread: String, id: String,
  +before_command: String, after_command: String, +before_cases: U32, after_cases: U32,
  +before_workers: U32, after_workers: U32, +before_ms: U32, +after_ms: U32,
  +before_observed: U32, after_observed: U32, before_passed: Bool, after_passed: Bool) -> Replay:
  +same_suite = Bool.and(String.eq(before_command, after_command),
    String.starts_with(before_command, "python3 -m cProfile -m unittest discover "))
  +cases = Bool.and(U32.is_gt(before_cases, 0), U32.is_eq(before_cases, after_cases))
  +workers = Bool.and(U32.is_gt(before_workers, 0), U32.is_eq(before_workers, after_workers))
  +ordered = Bool.and(U32.is_gt(before_observed, 0), U32.is_gt(after_observed, before_observed))
  +control = Bool.and(Bool.and(same_suite, Bool.and(cases, workers)),
    Bool.and(ordered, Bool.and(before_passed, after_passed)))
  +saving = U32.sub(before_ms, after_ms)
  +times = Bool.and(U32.is_gt(after_ms, 0), U32.is_gt(before_ms, after_ms))
  +material = Bool.and(U32.is_ge(saving, 15000), U32.is_ge(saving, U32.inc(U32.div(U32.sub(before_ms, 1), 4))))
  observe_failure_with_duration(state, thread, id, "local-verification-fixture-measured-speedup",
    Bool.and(control, Bool.and(times, material)), U32.div(saving, 1000))

def observe_rust_config_ancestry(state: Replay, thread: String, id: String, operation: String,
  origin: String, diagnostic: String, failure: String, failed: Bool) -> Replay:
  +producer = Bool.and(String.eq(operation, "cargo-test"), String.eq(origin, "config-writer"))
  +receipt = Bool.and(String.eq(diagnostic, "Config ancestry must be trusted or sticky"),
    String.eq(failure, "rust-test-panic"))
  observe_failure(state, thread, id, "local-rust-config-ancestry-refused", Bool.and(failed, Bool.and(producer, receipt)))

def observe_electron_display(state: Replay, thread: String, id: String, operation: String, origin: String,
  line: String, terminal: String, failed: Bool) -> Replay:
  +producer = Bool.and(String.eq(operation, "node-test"), String.eq(origin, "electron-ozone-x11"))
  +receipt = Bool.and(String.eq(line, "Missing X server or $DISPLAY"),
    String.eq(terminal, "The platform failed to initialize. Exiting."))
  observe_failure(state, thread, id, "local-electron-display-unavailable", Bool.and(failed, Bool.and(producer, receipt)))

def observe_hosted_same_head_supersession(state: Replay, thread: String, id: String, +pr: U32,
  previous_run: String, next_run: String, previous_workflow: String, next_workflow: String,
  previous_head: String, next_head: String, previous_job: String, next_job: String, previous_conclusion: String,
  annotation: String, assigned: Bool, +previous_started: U32, +previous_ended: U32, +next_created: U32) -> Replay:
  +same_work = Bool.and(Bool.not(String.eq(previous_run, next_run)), Bool.and(String.eq(previous_workflow, next_workflow),
    Bool.and(String.eq(previous_head, next_head), String.eq(previous_job, next_job))))
  +reason = String.append("Canceling since a higher priority waiting request for repository-checks-pull_request-",
    String.append(U32.show(pr), " exists"))
  +cancelled = Bool.and(assigned, Bool.and(U32.is_gt(pr, 0),
    Bool.and(String.eq(previous_conclusion, "cancelled"), String.eq(annotation, reason))))
  +overlap = Bool.and(U32.is_gt(previous_started, 0),
    Bool.and(U32.is_gt(next_created, previous_started), U32.is_ge(previous_ended, next_created)))
  observe_failure_with_duration(state, thread, id, "ci-same-head-job-superseded",
    Bool.and(same_work, Bool.and(cancelled, overlap)), U32.sub(previous_ended, previous_started))

def observe_jobless_run_control_conflict(state: Replay, thread: String, id: String, +run: String,
  jobs_run: String, cancel_run: String, force_run: String, status: String, jobs: U32,
  normal_error: String, force_status: U32, force_error: String,
  +jobs_observed: U32, +cancel_denied: U32, +status_observed: U32, +force_denied: U32) -> Replay:
  +same_run = Bool.and(String.eq(run, jobs_run), Bool.and(String.eq(run, cancel_run), String.eq(run, force_run)))
  +queued = Bool.and(String.eq(status, "queued"), U32.is_eq(jobs, 0))
  +normal = String.eq(normal_error, "Cannot cancel a workflow run that is completed")
  +forced = Bool.and(U32.is_eq(force_status, 409), String.eq(force_error, "Cannot cancel a workflow run that has not been queued yet."))
  +before = Bool.and(U32.is_gt(jobs_observed, 0),
    Bool.and(U32.is_ge(cancel_denied, jobs_observed), U32.is_ge(status_observed, jobs_observed)))
  +after = Bool.and(U32.is_ge(force_denied, cancel_denied), U32.is_ge(force_denied, status_observed))
  +nearby = U32.is_le(U32.sub(force_denied, jobs_observed), 300)
  +observations = Bool.or(U32.is_ge(status_observed, cancel_denied), nearby)
  observe_failure(state, thread, id, "ci-jobless-run-state-conflict",
    Bool.and(same_run, Bool.and(queued, Bool.and(Bool.and(normal, forced), Bool.and(observations, Bool.and(before, after))))))

def observe_manual_workflow_completion(state: Replay, thread: String, id: String, +run: String,
  pending_run: String, observed_run: String, attempt: U32, event: String, +head: String, pending_head: String,
  observed_head: String, +pending_status: String, observed_status: String, +conclusion: String, observed_conclusion: String,
  +pending_at: U32, +last_job_end: U32, +provider_updated: U32, +observed_at: U32) -> Replay:
  +identity = Bool.and(Bool.and(String.eq(run, pending_run), String.eq(run, observed_run)),
    Bool.and(String.eq(head, pending_head), String.eq(head, observed_head)))
  +dispatch = Bool.and(U32.is_eq(attempt, 1), String.eq(event, "workflow_dispatch"))
  +pending = Bool.or(String.eq(pending_status, "in_progress"), String.eq(pending_status, "queued"))
  +terminal = Bool.and(String.eq(observed_status, "completed"),
    Bool.and(Bool.not(String.is_empty(conclusion)), String.eq(conclusion, observed_conclusion)))
  +clock = Bool.and(Bool.and(U32.is_gt(pending_at, 0), U32.is_gt(last_job_end, 0)),
    Bool.and(U32.is_gt(provider_updated, pending_at), U32.is_ge(provider_updated, last_job_end)))
  +gap = U32.sub(observed_at, provider_updated)
  +material = Bool.and(U32.is_gt(observed_at, provider_updated), U32.is_ge(gap, 300))
  observe_failure_with_duration(state, thread, id, "ci-manual-run-terminal-read-gap",
    Bool.and(Bool.and(identity, dispatch), Bool.and(Bool.and(pending, terminal), Bool.and(clock, material))), gap)

def observe_local_electron_sandbox(state: Replay, thread: String, id: String, operation: String,
  +runtime: String, diagnostic: String, terminal: String, failed: Bool) -> Replay:
  +producer = Bool.and(String.eq(operation, "local-electron-launch"), String.starts_with(runtime, "/"))
  +expected = String.append(
    "The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now. You need to make sure that ",
    String.append(runtime, "/chrome-sandbox is owned by root and has mode 4755."))
  +signal = String.append(runtime, "/electron exited with signal SIGTRAP")
  +receipt = Bool.and(String.eq(diagnostic, expected), String.eq(terminal, signal))
  observe_failure(state, thread, id, "local-electron-sandbox-helper-refused", Bool.and(failed, Bool.and(producer, receipt)))

def observe_actions_job_log_escape_refusal(state: Replay, thread: String, id: String, operation: String,
  job: String, response_job: String, diagnostic: String, failed: Bool) -> Replay:
  +producer = Bool.and(String.eq(operation, "actions-job-logs"), String.eq(job, response_job))
  +receipt = String.eq(diagnostic, "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway")
  observe_failure(state, thread, id, "ci-job-log-escape-refused", Bool.and(failed, Bool.and(producer, receipt)))

def observe_storage_worktree_removal(state: Replay, thread: String, id: String, path: String, receipt: String,
  producer: String, phase: String, deleted: Bool, +at: U32) -> Replay:
  +source = Bool.and(String.eq(producer, "host-storage-maintenance"), String.eq(phase, "post"))
  observe_repeat(state, thread, id, "local-worktree-removal-repeated", path, receipt, at, at, 0, Bool.and(source, deleted))

def observe_worktree_prepare_failure(state: Replay, thread: String, id: String, branch: String, path: String,
  line: String, run_status: String, provider_started: Bool, +requested: U32, +failed_at: U32) -> Replay:
  +expected = String.append("Could not recreate the worktree for branch '", String.append(branch,
    String.append("' at ", String.append(path, "."))))
  +before_provider = Bool.and(String.eq(run_status, "failed"), Bool.not(provider_started))
  +known = closed_clock(requested, failed_at)
  observe_failure_with_duration(state, thread, id, "t3-worktree-recreation-failed-before-provider",
    Bool.and(before_provider, Bool.and(known, String.eq(line, expected))), U32.sub(failed_at, requested))

def reengagement_label(+acknowledgement: String) -> String:
  +early = String.eq(acknowledgement, "ended-early")
  +monitoring = String.eq(acknowledgement, "dropped-required-monitoring")
  Bool.pick(String, early, "t3-early-stop-acknowledged", Bool.pick(String, monitoring, "t3-monitoring-stop-acknowledged", ""))

def observe_turn_reengagement(state: Replay, +thread: String, id: String, source_thread: String, visibility: String,
  prior_status: String, +prior: U32, next: U32, +closed: U32, +requested: U32, acknowledgement: String) -> Replay:
  +owned = local_source(thread, source_thread, visibility)
  +completed = Bool.and(String.eq(prior_status, "completed"), Bool.and(U32.is_gt(prior, 0), U32.is_eq(U32.inc(prior), next)))
  +ordered = Bool.and(U32.is_gt(closed, 0), U32.is_gt(requested, closed))
  observe_failure_with_duration(state, thread, id, reengagement_label(acknowledgement),
    Bool.and(owned, Bool.and(completed, ordered)), U32.sub(requested, closed))

def observe_ingress_interruption(state: Replay, +thread: String, id: String, source_thread: String, visibility: String,
  +input_turn: U32, receipt_turn: U32, +submitted: U32, reported: U32, receipt: String) -> Replay:
  +owned = local_source(thread, source_thread, visibility)
  +same_turn = Bool.and(U32.is_gt(input_turn, 0), U32.is_eq(input_turn, receipt_turn))
  +ordered = closed_clock(submitted, reported)
  +rejected = String.eq(receipt, "interrupted-before-processing")
  observe_failure(state, thread, id, "t3-inbound-message-interrupted",
    Bool.and(Bool.and(owned, same_turn), Bool.and(ordered, rejected)))

def observe_local_build_memory_gate(state: Replay, thread: String, id: String, cause: String,
  +available: U32, capacity: U32, +minimum: U32) -> Replay:
  +slots = Bool.and(U32.is_gt(minimum, 0), Bool.and(U32.is_ge(available, minimum), U32.is_ge(capacity, available)))
  observe_failure(state, thread, id, "local-build-memory-gate-with-worker-slots",
    Bool.and(String.eq(cause, "cgroup-memory"), slots))

def update_native_mac_ticket(state: Replay, +thread: String, +id: String, +key: String, +valid_identity: Bool,
  +phase: String, +session: String, +created: U32, +observed: U32, +deadline: U32, prior: Attempt) -> Replay:
  match state prior:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings} Attempt{+queued_id, +queued_at, +queue_receipt, _}:
      +queued = Bool.and(String.eq(phase, "queued"), String.is_empty(session))
      +queue_time = Bool.and(U32.is_gt(created, queued_at),
        Bool.and(U32.is_ge(observed, created), Bool.and(U32.is_ge(observed, queue_receipt), U32.is_gt(deadline, created))))
      +ready = Bool.and(String.eq(phase, "ready"), Bool.and(Bool.not(String.is_empty(session)),
        Bool.and(U32.is_eq(created, 0), U32.is_eq(deadline, 0))))
      +ready_time = Bool.and(U32.is_gt(queued_at, 0), U32.is_ge(observed, queue_receipt))
      +event = pair("native-mac-ready", pair(thread, queued_id))
      +session_event = pair("native-mac-session", pair(key, session))
      +unseen = Bool.not(Bool.or(includes(seen, event), includes(seen, session_event)))
      +first_ready = Bool.and(valid_identity, Bool.and(Bool.and(ready, ready_time), unseen))
      +seconds = U32.sub(observed, queued_at)
      +later_queue = Bool.and(valid_identity, Bool.and(queued, queue_time))
      +slow = U32.is_ge(seconds, 60)
      Bool.pick(Replay, first_ready,
        Replay{Map.set(&2, Bool, Map.set(&2, Bool, seen, event, True{}), session_event, True{}), files, reads,
          add_cost(costs, "native-mac-ticket-readiness", "nomac-wait", True{}, seconds), attempts, cohorts, status_reads,
          Bool.pick(List<&2, Finding>, slow,
            Finding{"native-mac-ticket-readiness-slow", thread, id, queued_id, seconds, 0, 0, 0} <> findings, findings)},
        Replay{seen, files, reads, costs,
          Bool.pick(Map<&2, Attempt>, later_queue, Map.set(&2, Attempt, attempts, key, Attempt{id, created, observed, False{}}), attempts),
          cohorts, status_reads, findings})

def observe_native_mac_ticket(+state: Replay, +thread: String, id: String, +ticket: String, +workspace: String,
  phase: String, session: String, created: U32, observed: U32, deadline: U32) -> Replay:
  match state:
    case Replay{_, _, _, _, attempts, _, _, _}:
      +valid_identity = Bool.not(Bool.or(String.is_empty(ticket), String.is_empty(workspace)))
      +key = pair("native-mac-ticket", pair(thread, pair(ticket, workspace)))
      update_native_mac_ticket(state, thread, id, key, valid_identity, phase, session, created, observed, deadline,
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, key)))

def observe_pr_repository_recovery(state: Replay, thread: String, id: String, +created_repo: String,
  closed_repo: String, repaired_repo: String, +created_pr: U32, closed_pr: U32, repaired_pr: U32,
  title: String, repaired_title: String, implicit: Bool, +created: U32, +closed: U32, +repaired: U32) -> Replay:
  +closure = Bool.and(String.eq(created_repo, closed_repo), Bool.and(U32.is_eq(created_pr, closed_pr), U32.is_gt(created_pr, 0)))
  +changed = Bool.and(implicit, Bool.and(Bool.not(String.eq(created_repo, repaired_repo)), U32.is_gt(repaired_pr, 0)))
  +elapsed = U32.sub(repaired, created)
  +ordered = Bool.and(closed_clock(created, closed), Bool.and(U32.is_ge(repaired, closed), U32.is_le(elapsed, 600)))
  observe_failure_with_duration(state, thread, id, "github-pr-default-repository-recovered",
    Bool.and(closure, Bool.and(changed, Bool.and(ordered, String.eq(title, repaired_title)))), elapsed)

def observe_transcribe_runtime_missing(state: Replay, thread: String, id: String, operation: String,
  origin: String, line: String, failed: Bool) -> Replay:
  +source = Bool.and(String.eq(operation, "cargo-build-script"), String.eq(origin, "build.rs"))
  +diagnostic = String.eq(line, "read transcribe runtime: Os { code: 2, kind: NotFound, message: \"No such file or directory\" }")
  observe_failure(state, thread, id, "local-rust-transcribe-runtime-missing", Bool.and(failed, Bool.and(source, diagnostic)))

def observe_model_backend_revision_refusal(state: Replay, thread: String, id: String, endpoint: String, status: U32,
  +running: String, +checkout: String, line: String) -> Replay:
  +route = Bool.and(String.eq(endpoint, "GET /api/model/options?explicit_only=1"), U32.is_eq(status, 503))
  +mismatch = Bool.not(String.eq(running, checkout))
  +expected = String.append("Restart required: This process is running code from ", String.append(running,
    String.append(" but the checkout on disk is now ", String.append(checkout,
      ". The model picker would risk a stale-module crash — restart the Desktop-owned backend to load the new code (use Restart backend in Hermes Desktop, or quit and reopen the app)"))))
  observe_failure(state, thread, id, "local-model-catalog-stale-backend-revision",
    Bool.and(route, Bool.and(mismatch, String.eq(line, expected))))

def observe_platform_admission_status_refusal(state: Replay, thread: String, id: String, run: String,
  gate_run: String, +head: String, gate_head: String, workflow_status: String, platform: String, diagnostic: String,
  original: Bool, alternative: Bool, +required_finished: U32, +refused_at: U32) -> Replay:
  +identity = Bool.and(String.eq(run, gate_run), String.eq(head, gate_head))
  +status = Bool.and(String.eq(workflow_status, "queued"), String.eq(platform, "linux"))
  +proof = Bool.and(Bool.not(original), Bool.and(alternative,
    String.eq(diagnostic, "No successful linux main verification for this exact commit")))
  +elapsed = U32.sub(refused_at, required_finished)
  +clock = Bool.and(U32.is_gt(required_finished, 0), Bool.and(U32.is_gt(refused_at, required_finished), U32.is_ge(elapsed, 60)))
  observe_failure_with_duration(state, thread, id, "ci-platform-admission-queued-status-refused",
    Bool.and(identity, Bool.and(status, Bool.and(proof, clock))), elapsed)

def observe_same_declared_input_rebuild(state: Replay, thread: String, id: String, prior_lane: String,
  landed_lane: String, prior_event: String, landed_event: String, prior_result: String, landed_result: String,
  prior_inputs: String, landed_inputs: String, decision: String, +prior_ended: U32, +start: U32, +end: U32) -> Replay:
  +same_inputs = Bool.and(String.eq(prior_lane, landed_lane), String.eq(prior_inputs, landed_inputs))
  +events = Bool.and(String.eq(prior_event, "pull_request"), String.eq(landed_event, "push"))
  +verified = Bool.and(String.eq(prior_result, "success"), String.eq(landed_result, "success"))
  +fallback = String.eq(decision, "no qualifying prior artifact")
  +ordered = Bool.and(closed_clock(prior_ended, start), U32.is_gt(end, start))
  observe_failure_with_duration(state, thread, id, "ci-main-rebuild-same-declared-inputs",
    Bool.and(same_inputs, Bool.and(events, Bool.and(verified, Bool.and(fallback, ordered)))), U32.sub(end, start))

def observe_hosted_workflow_startup_failure(state: Replay, thread: String, id: String, status: String,
  conclusion: String, job_count: U32, attempt: U32) -> Replay:
  +ended = Bool.and(String.eq(status, "completed"), String.eq(conclusion, "startup_failure"))
  +jobless = Bool.and(U32.is_eq(job_count, 0), U32.is_gt(attempt, 0))
  observe_failure(state, thread, id, "ci-workflow-startup-failure", Bool.and(ended, jobless))

def observe_hosted_job_deadline_confirmed(state: Replay, thread: String, id: String, conclusion: String,
  assigned: Bool, annotation: String, +deadline: U32, +started: U32, +ended: U32) -> Replay:
  +minutes = U32.div(deadline, 60)
  +seconds = U32.sub(deadline, U32.mul(minutes, 60))
  +expected = String.append("The job has exceeded the maximum execution time of ",
    String.append(U32.show(minutes), String.append("m", String.append(U32.show(seconds), "s"))))
  +confirmed = Bool.and(assigned, Bool.and(String.eq(conclusion, "cancelled"), String.eq(annotation, expected)))
  +elapsed = U32.sub(ended, started)
  +ordered = Bool.and(U32.is_gt(started, 0), U32.is_gt(ended, started))
  +bounded = Bool.and(U32.is_gt(deadline, 0), U32.is_ge(elapsed, deadline))
  observe_failure_with_duration(state, thread, id, "ci-job-deadline-confirmed",
    Bool.and(confirmed, Bool.and(ordered, bounded)), elapsed)

def observe_hosted_electron_download(state: Replay, thread: String, id: String, step: String,
  conclusion: String, +status: U32, exit_code: U32, +artifact: String, origin: String, renderer: String) -> Replay:
  +phase = Bool.and(String.eq(step, "Prepare Electron before timed renderer tests"), String.eq(renderer, "skipped"))
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +publisher = Bool.and(String.starts_with(artifact, "https://github.com/electron/electron/releases/download/v"),
    String.ends_with(artifact, ".zip"))
  +fetch = Bool.and(publisher, String.eq(origin, "electron-get-fetch-downloader"))
  +server = Bool.and(U32.is_ge(status, 500), U32.is_lt(status, 600))
  observe_failure(state, thread, id, "ci-electron-prerequisite-http-server-error",
    Bool.and(phase, Bool.and(failed, Bool.and(fetch, server))))

def observe_hosted_bun_test_deadline(state: Replay, thread: String, id: String, step: String, conclusion: String,
  diagnostic: String, +path: String, test: String, exit_code: U32, +budget_ms: U32, +elapsed_ms: U32) -> Replay:
  +suite = Bool.and(String.starts_with(step, "Run bun test "), Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1)))
  +file = Bool.and(String.contains(path, ".test."), Bool.not(String.starts_with(path, "/")))
  +timeout = Bool.and(String.eq(diagnostic, "done-callback-deadline"),
    Bool.and(U32.is_gt(budget_ms, 0), U32.is_ge(elapsed_ms, budget_ms)))
  +identified = Bool.and(file, Bool.not(String.is_empty(test)))
  observe_failure_with_duration(state, thread, id, "ci-bun-test-deadline",
    Bool.and(suite, Bool.and(identified, timeout)), U32.div(elapsed_ms, 1000))

def observe_diagnostic(state: Replay, thread: String, id: String, line: String, failed: Bool) -> Replay:
  observe_failure(state, thread, id, diagnostic_label(String.trim(line)), failed)

def observe_job_result(state: Replay, thread: String, id: String, +conclusion: String) -> Replay:
  +timeout = String.eq(conclusion, "timed_out")
  +failed = Bool.or(timeout, String.eq(conclusion, "failure"))
  observe_failure(state, thread, id, Bool.pick(String, timeout, "ci-job-timeout", "ci-job-failure"), failed)

def observe_hosted_admission(state: Replay, thread: String, id: String, conclusion: String, assigned: Bool,
  steps: U32, annotation: String) -> Replay:
  +cancelled = String.eq(conclusion, "cancelled")
  +unallocated = Bool.and(Bool.not(assigned), U32.is_eq(steps, 0))
  +note = String.trim(annotation)
  +unacquired = String.eq(note, "The job was not acquired by Runner of type hosted even after multiple attempts")
  +explicit = Bool.and(String.starts_with(note, "The run was canceled by @"),
    Bool.and(String.ends_with(note, "."), Bool.not(String.eq(note, "The run was canceled by @."))))
  +label = Bool.pick(String, unacquired, "ci-hosted-admission-failure",
    Bool.pick(String, explicit, "ci-hosted-explicit-cancellation-unassigned", ""))
  observe_failure(state, thread, id, label, Bool.and(cancelled, unallocated))

def pr_notice_reason(pr: U32, +message: String) -> String:
  +prefix = String.append("#", String.append(Nat.show(U32.to_nat(pr)), ": "))
  Bool.pick(String, String.eq(message, String.append(prefix, "merge conflict")), "merge-conflict",
    Bool.pick(String, String.eq(message, String.append(prefix, "checks passed, merge conflict")), "checks-passed-merge-conflict",
      Bool.pick(String, String.eq(message, String.append(prefix, "checks failed")), "checks-failed",
        Bool.pick(String, String.eq(message, String.append(prefix, "checks passed")), "checks-passed", ""))))

def observe_pr_notice(state: Replay, +thread: String, id: String, source_thread: String, visibility: String,
  status: String, truncated: Bool, +pr: U32, message: String) -> Replay:
  +local = local_source(thread, source_thread, visibility)
  +complete = Bool.and(String.eq(status, "completed"), Bool.not(truncated))
  +reason = pr_notice_reason(pr, message)
  +conflict = Bool.or(String.eq(reason, "merge-conflict"), String.eq(reason, "checks-passed-merge-conflict"))
  +valid = Bool.and(U32.is_gt(pr, 0), Bool.and(local, Bool.and(complete, conflict)))
  observe_failure(state, thread, id, "pr-merge-conflict-observed", valid)

def manual_verification_key(thread: String, repository: String, revision: String) -> String:
  pair("manual-verification", pair(thread, pair(repository, revision)))

def update_manual_verification(state: Replay, key: String, id: String, +completed: U32, valid: Bool,
  prior: Attempt) -> Replay:
  match state prior:
    case Replay{seen, files, reads, costs, +attempts, cohorts, status_reads, findings} Attempt{_, _, +earliest, _}:
      +earlier = Bool.or(U32.is_eq(earliest, 0), U32.is_lt(completed, earliest))
      +accept = Bool.and(valid, Bool.and(U32.is_gt(completed, 0), earlier))
      Replay{seen, files, reads, costs,
        Bool.pick(Map<&2, Attempt>, accept, Map.set(&2, Attempt, attempts, key, Attempt{id, completed, completed, False{}}), attempts),
        cohorts, status_reads, findings}

def observe_manual_verification(+state: Replay, thread: String, id: String, repository: String, revision: String,
  event: String, +path: String, status: String, conclusion: String, attempt: U32, +jobs: U32, total_jobs: U32,
  completed: U32) -> Replay:
  match state:
    case Replay{_, _, _, _, attempts, _, _, _}:
      +linux = String.eq(path, ".github/workflows/verification.yml")
      +mac = Bool.or(String.eq(path, ".github/workflows/verification-mac.yml"),
        String.eq(path, ".github/workflows/verification-mac-main.yml"))
      +terminal = Bool.and(String.eq(event, "workflow_dispatch"),
        Bool.and(String.eq(status, "completed"), String.eq(conclusion, "success")))
      +executed = Bool.and(U32.is_gt(attempt, 0), Bool.and(U32.is_gt(jobs, 0), U32.is_ge(total_jobs, jobs)))
      +valid = Bool.and(Bool.or(linux, mac), Bool.and(terminal, executed))
      +key = manual_verification_key(thread, repository, revision)
      update_manual_verification(state, key, id, completed, valid,
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, key)))

def record_empty_pr_rollup(state: Replay, +thread: String, +id: String, +scope: String, +turn_key: String,
  +observed: U32, +started: U32, valid: Bool, prior: Attempt, manual: Attempt) -> Replay:
  match state prior manual:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings} Attempt{+last, _, +last_at, _} Attempt{verified, _, +verified_at, _}:
      +read = pair("pr-rollup-read", pair(thread, id))
      +first = pair("pr-rollup-empty", scope)
      +unlisted = pair("pr-rollup-manual-unlisted", scope)
      +accepted = Bool.and(valid, Bool.and(U32.is_ge(observed, last_at), Bool.not(includes(seen, read))))
      +initial = Bool.not(includes(seen, first))
      +repeat = U32.is_gt(last_at, 0)
      +bound = Bool.and(U32.is_gt(verified_at, 0), U32.is_gt(started, verified_at))
      +external = Bool.and(bound, Bool.not(includes(seen, unlisted)))
      +with_initial = Bool.pick(List<&2, Finding>, initial,
        Finding{"t3-pr-check-rollup-empty", thread, id, "", 0, 0, 0, 0} <> findings, findings)
      +with_repeat = Bool.pick(List<&2, Finding>, repeat,
        Finding{"t3-pr-check-rollup-repeated", thread, id, last, U32.sub(observed, last_at), 0, 0, 0} <> with_initial, with_initial)
      +with_manual = Bool.pick(List<&2, Finding>, external,
        Finding{"t3-pr-manual-verification-unlisted", thread, id, verified, U32.sub(started, verified_at), 0, 0, 0} <> with_repeat, with_repeat)
      +seen_reads = Map.set(&2, Bool, Map.set(&2, Bool, seen, read, True{}), first, True{})
      Bool.pick(Replay, accepted,
        Replay{Bool.pick(Map<&2, Bool>, external, Map.set(&2, Bool, seen_reads, unlisted, True{}), seen_reads),
          files, reads, costs, Map.set(&2, Attempt, attempts, turn_key, Attempt{id, observed, observed, False{}}),
          cohorts, status_reads, with_manual},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_empty_pr_rollup(+state: Replay, +thread: String, id: String, +repository: String, +revision: String,
  turn: String, +pr: U32, +observed: U32, +started: U32, checks: U32) -> Replay:
  match state:
    case Replay{_, _, _, _, +attempts, _, _, _}:
      +scope = pair(thread, pair(repository, pair(U32.show(pr), revision)))
      +turn_key = pair("pr-rollup-turn", pair(scope, turn))
      +manual_key = manual_verification_key(thread, repository, revision)
      +clock = Bool.and(U32.is_gt(observed, 0), U32.is_ge(observed, started))
      +valid = Bool.and(U32.is_gt(pr, 0), Bool.and(clock, U32.is_eq(checks, 0)))
      record_empty_pr_rollup(state, thread, id, scope, turn_key, observed, started, valid,
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, turn_key)),
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, manual_key)))

def record_pr_watch_wake(state: Replay, +thread: String, +id: String, watch_id: String, reason: String,
  +seconds: U32, valid: Bool) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +event = pair("watch-wake", pair(thread, id))
      +accept = Bool.and(valid, Bool.not(includes(seen, event)))
      Bool.pick(Replay, accept,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          add_cost(costs, "t3-pr-watch-parked", reason, True{}, seconds), attempts, cohorts, status_reads,
          Finding{"t3-pr-watch-parked", thread, id, watch_id, seconds, 0, 0, 0} <> findings},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_pr_watch_wake(state: Replay, thread: String, id: String, watch_id: String, +pr: U32, message: String,
  +registered: U32, +parked: U32, +notified: U32, +prior: U32, next: U32, notice_stamp: String,
  requested_stamp: String) -> Replay:
  +reason = pr_notice_reason(pr, message)
  +ordered = Bool.and(closed_clock(registered, parked), U32.is_ge(notified, parked))
  +wake = Bool.and(U32.is_gt(prior, 0), Bool.and(U32.is_eq(next, U32.inc(prior)), String.eq(notice_stamp, requested_stamp)))
  +valid = Bool.and(U32.is_gt(pr, 0), Bool.and(Bool.not(String.is_empty(reason)), Bool.and(ordered, wake)))
  record_pr_watch_wake(state, thread, id, watch_id, reason, U32.sub(notified, parked), valid)

def observe_forge_response(state: Replay, thread: String, id: String, operation: String, +status: U32,
  failed: Bool, identified: Bool) -> Replay:
  +server_error = Bool.and(U32.is_ge(status, 500), U32.is_lt(status, 600))
  +create = String.eq(operation, "github-pr-create")
  +valid = Bool.and(Bool.and(create, server_error), Bool.and(failed, identified))
  observe_failure(state, thread, id, "pr-create-http-server-error", valid)

def observe_pr_merge_response(state: Replay, thread: String, id: String, +repository: String, +pr: U32,
  +status: U32, +receipt: String, following_repository: String, following_pr: U32, +following_state: String,
  following_merge_commit: String) -> Replay:
  +server_error = Bool.and(U32.is_ge(status, 500), U32.is_lt(status, 600))
  +original = Bool.or(String.eq(receipt, "gh-cli-merge-http"), String.eq(receipt, "gh-rest-merge-http"))
  +target = Bool.and(Bool.not(String.is_empty(repository)), U32.is_gt(pr, 0))
  +same_pr = Bool.and(String.eq(repository, following_repository), U32.is_eq(pr, following_pr))
  +has_commit = Bool.not(String.is_empty(following_merge_commit))
  +open = Bool.and(String.eq(following_state, "OPEN"), Bool.not(has_commit))
  +merged = Bool.and(String.eq(following_state, "MERGED"), has_commit)
  +rule = Bool.pick(String, Bool.and(same_pr, open), "pr-merge-http-error-observed-open",
    Bool.pick(String, Bool.and(same_pr, merged), "pr-merge-http-error-observed-merged", "pr-merge-http-server-error"))
  observe_failure(state, thread, id, rule, Bool.and(target, Bool.and(server_error, original)))

def observe_github_pr_ref_resolution(state: Replay, thread: String, id: String, base: String,
  head: String, line: String, failed: Bool) -> Replay:
  +expected = String.append("pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank, No commits between ",
    String.append(base, String.append(" and ", String.append(head, ", Head ref must be a branch (createPullRequest)"))))
  observe_failure(state, thread, id, "pr-create-graphql-ref-resolution", Bool.and(failed, String.eq(line, expected)))

def observe_github_pr_number_resolution(state: Replay, thread: String, id: String, +pr: U32,
  +operation: String, implicit: Bool, diagnostic: String) -> Replay:
  +read = Bool.or(String.eq(operation, "view"), String.eq(operation, "checks"))
  +write = Bool.or(String.eq(operation, "merge"), String.eq(operation, "ready"))
  +expected = String.append("GraphQL: Could not resolve to a PullRequest with the number of ",
    String.append(U32.show(pr), ". (repository.pullRequest)"))
  +valid = Bool.and(U32.is_gt(pr, 0), Bool.and(implicit, Bool.and(Bool.or(read, write), String.eq(diagnostic, expected))))
  observe_failure(state, thread, id, "github-pr-implicit-number-unresolved", valid)

def observe_github_workflow_scope(state: Replay, thread: String, id: String, operation: String,
  +workflow: String, diagnostic: String, failed: Bool) -> Replay:
  +push = Bool.and(String.eq(operation, "git-push-https"), String.eq(diagnostic, "oauth-workflow-scope"))
  +yaml = Bool.or(String.ends_with(workflow, ".yml"), String.ends_with(workflow, ".yaml"))
  +scoped_file = Bool.and(String.starts_with(workflow, ".github/workflows/"), yaml)
  observe_failure(state, thread, id, "git-push-github-workflow-scope-refused", Bool.and(failed, Bool.and(push, scoped_file)))

def observe_t3_worktree_missing(state: Replay, thread: String, id: String, expected: String,
  path: String, operation: String, diagnostic: String, failed: Bool) -> Replay:
  +bound = Bool.and(String.eq(expected, path), String.eq(operation, "ls-worktree"))
  observe_failure(state, thread, id, "local-t3-worktree-path-missing",
    Bool.and(failed, Bool.and(bound, String.eq(diagnostic, "enoent"))))

def observe_provider_input_rejection(state: Replay, +thread: String, id: String, source_thread: String,
  visibility: String, item_type: String, item_status: String, truncated: Bool, status: U32,
  error_type: String, parameter: String, code: String, message: String) -> Replay:
  +original = Bool.and(local_source(thread, source_thread, visibility), Bool.not(truncated))
  +result = Bool.and(String.eq(item_type, "error"), Bool.and(String.eq(item_status, "failed"), U32.is_eq(status, 400)))
  +shape = Bool.and(String.eq(error_type, "invalid_request_error"),
    Bool.and(String.eq(parameter, "input"), String.eq(code, "unsupported_parameter")))
  +audio = String.eq(message, "Audio input is not supported for this request.")
  observe_failure(state, thread, id, "provider-audio-input-unsupported",
    Bool.and(original, Bool.and(result, Bool.and(shape, audio))))

def record_provider_lifecycle(state: Replay, +thread: String, +id: String, label: String,
  operation: String, +recovered: Bool, +seconds: U32, valid: Bool) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +status_reads, +findings}:
      +event = pair("t3-provider-lifecycle", pair(thread, id))
      +accept = Bool.and(valid, Bool.not(includes(seen, event)))
      Bool.pick(Replay, accept,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          Bool.pick(Map<&2, Cost>, recovered, add_cost(costs, "t3-provider-recovery", operation, True{}, seconds), costs),
          attempts, cohorts, status_reads,
          Finding{label, thread, id, "", Bool.pick(U32, recovered, seconds, 0), 0, 0, 0} <> findings},
        Replay{seen, files, reads, costs, attempts, cohorts, status_reads, findings})

def observe_provider_lifecycle(state: Replay, +thread: String, id: String, source_thread: String,
  visibility: String, item_type: String, +status: String, +title: String, +category: String, +code: String,
  +retryable: Bool, +attempt: U32, +limit: U32, +started: U32, +completed: U32) -> Replay:
  +owned = Bool.and(local_source(thread, source_thread, visibility), String.eq(item_type, "error"))
  +clock = closed_clock(started, completed)
  +stream = Bool.and(String.eq(category, "transport_error"), String.eq(code, "responseStreamDisconnected"))
  +overloaded = Bool.and(String.eq(category, "provider_error"), String.eq(code, "serverOverloaded"))
  +within_limit = Bool.or(U32.is_eq(limit, 0), U32.is_ge(limit, attempt))
  +retry_plan = Bool.and(retryable, Bool.and(U32.is_gt(attempt, 0), within_limit))
  +recovery_receipt = Bool.and(String.eq(title, "Provider recovered"), String.eq(status, "completed"))
  +recovered = Bool.and(Bool.or(stream, overloaded), Bool.and(retry_plan, recovery_receipt))
  +usage_receipt = Bool.and(String.eq(title, "Usage limit reached"), String.eq(status, "failed"))
  +usage_limit = Bool.and(String.eq(category, "usage_limit"), String.eq(code, "usageLimitExceeded"))
  +refused = Bool.and(Bool.not(retryable), Bool.and(usage_receipt, usage_limit))
  +valid = Bool.and(owned, Bool.and(clock, Bool.or(recovered, refused)))
  +label = Bool.pick(String, stream, "t3-provider-stream-recovered",
    Bool.pick(String, overloaded, "t3-provider-overload-recovered", "t3-provider-usage-limit-refused"))
  +operation = Bool.pick(String, stream, "response-stream-disconnected", "server-overloaded")
  record_provider_lifecycle(state, thread, id, label, operation, recovered, U32.sub(completed, started), valid)

def observe_provider_no_reply(state: Replay, +thread: String, id: String, source_thread: String,
  visibility: String, item_type: String, status: String, author: String, origin: String, receipt: String) -> Replay:
  +original = local_source(thread, source_thread, visibility)
  +message = Bool.and(String.eq(item_type, "assistant_message"), String.eq(status, "completed"))
  +provider = Bool.and(String.eq(author, "agent"), String.eq(origin, "provider"))
  +reported = String.eq(receipt, "no-reply-after-retries")
  observe_failure(state, thread, id, "t3-provider-no-reply-reported",
    Bool.and(Bool.and(original, message), Bool.and(provider, reported)))

def observe_hosted_status_write(state: Replay, thread: String, id: String, step: String, conclusion: String,
  writer: String, method: String, endpoint: String, revision: String, status: U32, reason: String, exit_code: U32) -> Replay:
  +reporter = Bool.and(String.eq(step, "Reconcile all PRs using trusted default-branch policy"),
    String.eq(writer, "verification-status-reporter"))
  +write = Bool.and(String.eq(method, "POST"), Bool.and(String.eq(endpoint, "commit-status"), Bool.not(String.is_empty(revision))))
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +throttle = Bool.and(U32.is_eq(status, 403), String.eq(reason, "installation-rate-limit"))
  observe_failure(state, thread, id, "ci-status-reporter-rate-limited",
    Bool.and(reporter, Bool.and(write, Bool.and(failed, throttle))))

def observe_hosted_macos_probe(state: Replay, thread: String, id: String, +step: String, conclusion: String,
  +fixture: String, +command: String, +failure: String, exit_code: U32) -> Replay:
  +tool = Bool.and(String.eq(step, "Native Mac Storage and error-reporting controls against the installed Rust GUI"),
    String.eq(fixture, "capture/desktop/ui/frontend/tests/mac-storage-native.cjs"))
  +probe = Bool.and(String.eq(command, "system-events-ui-elements-enabled"), String.eq(failure, "ERR_TEST_FAILURE"))
  +copy = Bool.and(String.eq(step, "Native GPUI Copy capture ID against the same installed App"),
    String.eq(fixture, "capture/desktop/scripts/native/copy-capture-id.swift"))
  +ownership = Bool.and(String.eq(command, "swiftc"),
    String.eq(failure, "Native Copy ID fixture failed: The observed input point does not hit the exact owned app"))
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +label = Bool.pick(String, Bool.and(tool, probe), "ci-macos-system-events-probe-failed",
    Bool.pick(String, Bool.and(copy, ownership), "ci-native-copy-id-target-refused", ""))
  observe_failure(state, thread, id, label, failed)

def observe_actions_rate_limit(state: Replay, thread: String, id: String, +operation: String, status: U32, +line: String,
  failed: Bool) -> Replay:
  +read = Bool.and(String.eq(operation, "actions-job-read"), String.eq(line, "gh: API rate limit exceeded (HTTP 403)"))
  +run = Bool.or(String.eq(operation, "actions-run-watch"), String.eq(operation, "actions-run-read"))
  +run_limit = Bool.and(run, String.eq(line, "failed to get run: HTTP 403: API rate limit exceeded"))
  +valid = Bool.and(failed, Bool.and(U32.is_eq(status, 403), Bool.or(read, run_limit)))
  observe_failure(state, thread, id, "ci-observer-rate-limited", valid)

def observe_job_rerun(state: Replay, thread: String, id: String, job: String, line: String, failed: Bool) -> Replay:
  +rejected = String.eq(String.trim(line), String.append("job ", String.append(job, " cannot be rerun")))
  observe_failure(state, thread, id, "ci-job-rerun-rejected", Bool.and(failed, rejected))

def observe_hosted_apt(state: Replay, thread: String, id: String, conclusion: String, exit_code: U32,
  http_status: U32, +archive: String, summary: String) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 100))
  +package = Bool.and(String.starts_with(archive, "/"), Bool.and(String.contains(archive, "/pool/"),
    String.ends_with(archive, ".deb")))
  +missing = Bool.and(U32.is_eq(http_status, 404), String.starts_with(summary, "E: Unable to fetch some archives"))
  observe_failure(state, thread, id, "ci-apt-package-not-found", Bool.and(failed, Bool.and(package, missing)))

def observe_local_admission_timeout(state: Replay, thread: String, id: String, exit_code: U32, line: String) -> Replay:
  +diagnostic = String.trim(line)
  +boundary = Bool.or(String.eq(diagnostic, "t3-build: timed out waiting for admission"),
    String.eq(diagnostic, "t3-build: timed out waiting for worker slots"))
  observe_failure(state, thread, id, "local-build-admission-timeout", Bool.and(U32.is_eq(exit_code, 124), boundary))

def observe_socket_preflight(state: Replay, thread: String, id: String, +required: U32, +limit: U32,
  line: String, origin: String) -> Replay:
  +boundary = String.eq(origin, "check_temp_environment:enablement/verification.py")
  +expected = String.append("RuntimeError: verification TMPDIR preflight: socket fixture needs ",
    String.append(U32.show(required), String.append(" pathname bytes; platform permits ", String.append(U32.show(limit), "."))))
  +matches = String.eq(line, expected)
  +exceeded = Bool.and(U32.is_gt(limit, 0), U32.is_gt(required, limit))
  observe_failure(state, thread, id, "local-verification-socket-path-limit", Bool.and(boundary, Bool.and(matches, exceeded)))

def capture_access_label(+line: String, +lookup: Bool, +fetch: Bool) -> String:
  +unavailable = Bool.or(Bool.and(lookup, String.starts_with(line, "Error: Capture unavailable (not_found).")),
    Bool.and(Bool.or(lookup, fetch), String.eq(line, "Error: Hosted API: not_found")))
  +pending = Bool.and(fetch, String.eq(line, "Error: Capture is still pending; retry fetch later"))
  +unsafe = Bool.and(lookup, String.eq(line, "Error: Unsafe shared or unowned directory tree; run apparent connect alternatives for local inspection and authorized transfer options"))
  Bool.pick(String, unavailable, "capture-reference-unavailable",
    Bool.pick(String, pending, "capture-upload-pending", Bool.pick(String, unsafe, "capture-directory-unsafe", "")))

def observe_capture_access(state: Replay, thread: String, id: String, +operation: String, line: String, failed: Bool) -> Replay:
  +lookup = Bool.or(String.eq(operation, "apparent-inspect"), String.eq(operation, "apparent-connect-files"))
  +fetch = String.eq(operation, "apparent-fetch")
  observe_failure(state, thread, id, capture_access_label(String.trim(line), lookup, fetch), failed)

def publication_label(+publisher: String, +line: String, +status: U32) -> String:
  +onboarding = Bool.and(String.eq(publisher, "onboarding-release"), Bool.and(U32.is_eq(status, 0),
    Bool.and(String.starts_with(line, "Error: Onboarding release onboarding-v"),
      String.ends_with(line, " exists with a different or unfinished artifact"))))
  +upload = Bool.and(String.eq(publisher, "github-release-assets"),
    Bool.and(U32.is_ge(status, 500), U32.is_lt(status, 600)))
  +http_prefix = String.append("HTTP ", String.append(Nat.show(U32.to_nat(status)), " (https://uploads.github.com/repos/"))
  +upload_line = Bool.and(String.starts_with(line, http_prefix), Bool.and(String.contains(line, "/releases/"),
    String.ends_with(line, "/assets)")))
  +draft = Bool.and(String.eq(publisher, "linux-compatibility-tag-read"), Bool.and(U32.is_eq(status, 404),
    Bool.and(String.starts_with(line, "Error: Command failed: gh api repos/"),
      String.contains(line, "/releases/tags/linux-main-"))))
  +allowlist = Bool.and(String.eq(publisher, "pages-artifact-seal"), Bool.and(U32.is_eq(status, 0),
    String.eq(line, "Error: Unexpected artifact input")))
  Bool.pick(String, onboarding, "ci-onboarding-release-artifact-conflict",
    Bool.pick(String, Bool.and(upload, upload_line), "ci-release-upload-server-error",
      Bool.pick(String, draft, "ci-release-tag-readback-not-found",
        Bool.pick(String, allowlist, "ci-pages-artifact-input-refused", ""))))

def observe_hosted_publish(state: Replay, thread: String, id: String, publisher: String, conclusion: String,
  exit_code: U32, status: U32, line: String) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  observe_failure(state, thread, id, publication_label(publisher, String.trim(line), status), failed)

def observe_failed_step(+state: Replay, thread: String, +id: String, clock: String, operation: String, label: String,
  valid: Bool, start: U32, end: U32) -> Replay:
  Bool.pick(Replay, valid,
    observe_failure(observe_timing(state, id, clock, operation, start, end), thread, id, label, True{}),
    state)

def observe_workflow_gate(+state: Replay, thread: String, +id: String, +workflow: String, +job: String, +prerequisite: String,
  +attempt_started: U32, +earliest_job: U32, +previous: U32, +gate: U32, started: U32) -> Replay:
  +original = Bool.and(closed_clock(attempt_started, earliest_job), U32.is_ge(previous, earliest_job))
  +seconds = U32.sub(gate, previous)
  +ordered = Bool.and(U32.is_ge(gate, previous), Bool.and(U32.is_ge(started, gate), U32.is_ge(seconds, 60)))
  +distinct = Bool.not(String.eq(job, prerequisite))
  +prefix = Bool.pick(String, String.is_empty(workflow), "", String.append(workflow, " / "))
  +operation = String.append(prefix, String.append(job, String.append(" needs ", prerequisite)))
  +valid = Bool.and(original, Bool.and(ordered, distinct))
  Bool.pick(Replay, valid,
    observe_failure_with_duration(observe_timing(state, id, "ci-workflow-status-gate", operation, previous, gate),
      thread, id, "ci-workflow-status-gate", True{}, seconds), state)

def observe_pre_push_timing_fixture(state: Replay, thread: String, id: String, operation: String, setting: String,
  fixture: String, actual: String, expected: String, line: String, failed: Bool, suite_ms: U32) -> Replay:
  +launch = Bool.and(String.eq(operation, "git-push"), String.eq(setting, "APPARENT_TIMING_FILE"))
  +mismatch = Bool.and(String.eq(fixture, "enablement/tests/test_pre_push_guard.py"),
    Bool.and(String.eq(actual, "--offline --timings"), String.eq(expected, "--offline")))
  +rejected = Bool.and(failed, String.eq(line, "pre-push: verification failed; push rejected"))
  observe_failure_with_duration(state, thread, id, "local-push-timing-flag-fixture-mismatch",
    Bool.and(launch, Bool.and(mismatch, rejected)), U32.div(suite_ms, 1000))

def observe_main_reuse_refusal(state: Replay, thread: String, id: String, event: String, step: String,
  conclusion: String, line: String) -> Replay:
  +context = Bool.and(String.eq(event, "push"), String.eq(conclusion, "success"))
  +producer = String.eq(step, "Run node --experimental-strip-types enablement/ci/routing/evidence.ts --reuse")
  +changed = String.eq(line, "Verification definitions changed; fresh main suites required.")
  observe_failure(state, thread, id, "ci-reuse-verification-definitions-changed", Bool.and(context, Bool.and(producer, changed)))

def observe_hosted_selector_base(state: Replay, thread: String, id: String, event: String, step: String,
  conclusion: String, command: String, +checkout: String, selector_head: String, job_head: String,
  +first_parent: String, second_parent: String, +base: String, ancestor: Bool, intervening: U32) -> Replay:
  +producer = Bool.and(String.eq(event, "pull_request"), Bool.and(String.eq(conclusion, "success"),
    Bool.and(String.eq(step, "Select through the shared consumer authority"), String.eq(command, "bun engine/tools/select.ts"))))
  +tested_merge = Bool.and(String.eq(checkout, selector_head), String.eq(job_head, second_parent))
  +older_base = Bool.and(Bool.not(String.eq(base, first_parent)), Bool.and(ancestor, U32.is_gt(intervening, 0)))
  observe_failure(state, thread, id, "ci-selector-compared-older-base", Bool.and(producer, Bool.and(tested_merge, older_base)))

def observe_local_exec_launch(state: Replay, +thread: String, id: String, source_thread: String,
  visibility: String, item_type: String, status: String, truncated: Bool, line: String) -> Replay:
  +original = Bool.and(local_source(thread, source_thread, visibility), Bool.not(truncated))
  +failed = Bool.and(String.eq(item_type, "command_execution"), String.eq(status, "failed"))
  +launcher = String.eq(line, "Failed to create unified exec process: No such file or directory (os error 2)")
  observe_failure(state, thread, id, "local-exec-launch-enoent", Bool.and(original, Bool.and(failed, launcher)))

def observe_run_watch_deadline(state: Replay, thread: String, id: String, operation: String,
  +launch_handle: U32, terminal_handle: U32, exit_status: Bool, exit_code: U32, +timeout: U32, elapsed_ms: U32) -> Replay:
  +process = Bool.and(U32.is_gt(launch_handle, 0), U32.is_eq(launch_handle, terminal_handle))
  +watch = Bool.and(String.eq(operation, "gh-run-watch"), exit_status)
  +seconds = U32.div(elapsed_ms, 1000)
  +bounds = Bool.and(U32.is_ge(timeout, 60), U32.is_ge(seconds, timeout))
  +expired = Bool.and(bounds, Bool.and(U32.is_eq(exit_code, 124), U32.is_le(U32.sub(seconds, timeout), 15)))
  observe_failure_with_duration(state, thread, id, "ci-local-run-observer-deadline",
    Bool.and(process, Bool.and(watch, expired)), seconds)

def observe_hermes_cache_merge(state: Replay, thread: String, id: String, step: String, conclusion: String,
  exit_code: U32, code: String, syscall: String, origin: String, restored: Bool) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +producer = Bool.and(String.eq(step, "Install supported Hermes validator"),
    String.eq(origin, "installCandidate:hermes/enablement/ci/validator-job.ts"))
  +copy = Bool.and(restored, Bool.and(String.eq(code, "EEXIST"), String.eq(syscall, "cp")))
  observe_failure(state, thread, id, "ci-hermes-validator-cache-copy-conflict", Bool.and(failed, Bool.and(producer, copy)))

def local_verification_boundary_label(+boundary: String, +line: String, +terminal: String) -> String:
  +changed = Bool.and(String.eq(boundary, "worktree-fingerprint"),
    Bool.and(String.eq(line, terminal), String.eq(terminal, "pre-push: working tree changed during verification; push rejected")))
  +push_failed = String.eq(terminal, "pre-push: verification failed; push rejected")
  +routing = Bool.and(String.eq(boundary, "local-test-selector"), String.eq(line,
    "Error: Conservative engine coverage is outside the automatic workflow filters; update the consumer inventory before admission"))
  +lock = Bool.and(String.eq(boundary, "desktop-dependencies"),
    String.eq(line, "Desktop dependency operation locked or unavailable"))
  +runtime = Bool.and(String.eq(boundary, "local-rust-test"), String.eq(line,
    "Packaged Record media/Engine unavailable; prepare native prerequisites or reinstall the complete app"))
  +issue = Bool.and(String.eq(boundary, "issue-trailer"),
    Bool.and(String.eq(line, "Commit needs a final Issue trailer"), String.eq(terminal, "error: failed to push some refs")))
  +push = Bool.pick(String, push_failed, Bool.pick(String, routing, "local-push-selection-guard-refused",
    Bool.pick(String, lock, "local-desktop-dependency-lock-unavailable",
      Bool.pick(String, runtime, "local-native-media-prerequisite-unavailable", ""))), "")
  Bool.pick(String, changed, "local-push-worktree-changed-during-verification",
    Bool.pick(String, issue, "local-push-issue-trailer-refused", push))

def observe_local_verify_boundary(state: Replay, thread: String, id: String, +operation: String, +boundary: String,
  +line: String, +terminal: String, failed: Bool) -> Replay:
  +push = String.eq(operation, "git-push")
  +commit = Bool.and(String.eq(operation, "git-commit"), String.eq(boundary, "staged-comment-policy"))
  +embedded = Bool.and(String.eq(line, "embedded HTML code requires a dedicated parser; unsupported changed file"),
    String.starts_with(terminal, "Pre-commit affected checks: "))
  +label = Bool.pick(String, push, local_verification_boundary_label(boundary, line, terminal),
    Bool.pick(String, Bool.and(commit, embedded), "staged-embedded-html-unsupported", ""))
  observe_failure(state, thread, id, label, failed)

def observe_exact_pr_check_wait(state: Replay, thread: String, id: String, +repository: String, +pr: U32,
  +expected: String, first_repository: String, first_pr: U32, first_head: String, last_repository: String,
  last_pr: U32, last_head: String, exit_code: U32, timeout: U32, elapsed_ms: U32) -> Replay:
  +first = Bool.and(String.eq(repository, first_repository), Bool.and(U32.is_eq(pr, first_pr), String.eq(expected, first_head)))
  +last = Bool.and(String.eq(repository, last_repository), Bool.and(U32.is_eq(pr, last_pr), String.eq(expected, last_head)))
  +identified = Bool.and(Bool.not(String.is_empty(expected)), U32.is_gt(pr, 0))
  +bound = Bool.and(U32.is_gt(timeout, 0), U32.is_eq(exit_code, 0))
  +seconds = U32.div(elapsed_ms, 1000)
  +complete = Bool.and(bound, U32.is_ge(seconds, 60))
  observe_failure_with_duration(state, thread, id, "ci-pr-check-observer-exact-head",
    Bool.and(identified, Bool.and(first, Bool.and(last, complete))), seconds)

def observe_hosted_approval_fixture(state: Replay, thread: String, id: String, step: String, conclusion: String,
  test: String, line: String, origin: String) -> Replay:
  +suite = Bool.and(String.eq(step, "Independent Connect client build and tests"), String.eq(conclusion, "failure"))
  +matched = Bool.and(String.eq(test, "test_support::encrypted_tests::encrypted_settings_future_capture_restart_retry_and_disconnect"),
    String.eq(origin, "login_with_approval:connect/client/src/test_support/encrypted_tests.rs"))
  +expired = String.eq(line, "called `Result::unwrap()` on an `Err` value: Expired")
  observe_failure(state, thread, id, "ci-connect-synthetic-approval-expired", Bool.and(suite, Bool.and(matched, expired)))

def observe_apt_job_deadline(+state: Replay, thread: String, +id: String, +step: String, +package: String,
  job_conclusion: String, +step_conclusion: String, +budget: U32, +attempt: U32, +job_start: U32, +job_end: U32,
  +start: U32, +end: U32) -> Replay:
  +media = Bool.and(String.eq(step, "Install recipient media fixture dependency"), String.eq(package, "ffmpeg"))
  +disk = Bool.and(String.eq(step, "Install disk-image contract dependency (no KVM required)"), String.eq(package, "qemu-utils"))
  +timeout = Bool.and(U32.is_gt(budget, 0), Bool.and(String.eq(job_conclusion, "cancelled"),
    U32.is_ge(U32.sub(job_end, job_start), budget)))
  +ordered = Bool.and(closed_clock(attempt, job_start),
    Bool.and(U32.is_ge(start, job_start), Bool.and(U32.is_ge(job_end, end), U32.is_gt(end, start))))
  +cancelled = String.eq(step_conclusion, "cancelled")
  +success = String.eq(step_conclusion, "success")
  +seconds = U32.sub(end, start)
  +valid = Bool.and(Bool.or(media, disk), Bool.and(timeout, Bool.and(ordered, Bool.or(cancelled, success))))
  +label = Bool.pick(String, cancelled, "ci-apt-step-cancelled-at-job-deadline", "ci-apt-install-before-job-deadline")
  Bool.pick(Replay, valid,
    observe_failure_with_duration(observe_timing(state, id, "ci-apt-dependency-step", package, start, end),
      thread, id, label, Bool.or(cancelled, U32.is_ge(seconds, 60)), seconds), state)

def observe_apt_mirror_probe(state: Replay, thread: String, id: String, step: String, conclusion: String, exit_code: U32,
  +mirror_a: String, +mirror_b: String, line: String, start: U32, end: U32) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +owner = String.eq(step, "Run ./.github/actions/ubuntu-apt")
  +distinct = Bool.and(Bool.not(String.eq(mirror_a, mirror_b)),
    Bool.not(Bool.or(String.is_empty(mirror_a), String.is_empty(mirror_b))))
  +exhausted = String.eq(line, "No tested Ubuntu mirror completed the bounded APT manifest/index probe")
  +valid = Bool.and(failed, Bool.and(owner, Bool.and(distinct, exhausted)))
  observe_failed_step(state, thread, id, "ci-apt-mirror-probe", "ubuntu", "ci-apt-mirror-probe-exhausted",
    valid, start, end)

def observe_vm_result(state: Replay, thread: String, id: String, +stage: String, +failure_type: String, exit_code: U32,
  +driver_exit: U32, scenario_started: Bool, command: String, +line: String, required: String, elapsed_ms: U32) -> Replay:
  +early = Bool.and(Bool.not(scenario_started), Bool.and(U32.is_eq(exit_code, 1), String.eq(command, "ssh")))
  +boot_timeout = Bool.and(String.eq(stage, "boot"), Bool.and(String.eq(failure_type, "TimeoutError"),
    Bool.and(U32.is_eq(driver_exit, 255), String.starts_with(line, "guest user desktop did not become ready within "))))
  +readiness = Bool.and(String.eq(stage, "readiness"), Bool.and(String.eq(failure_type, "CalledProcessError"),
    Bool.and(U32.is_eq(driver_exit, 69), String.eq(line, String.append("missing required guest command: ", required)))))
  +label = Bool.pick(String, boot_timeout, "local-vm-ssh-boot-timeout",
    Bool.pick(String, readiness, "local-vm-missing-guest-command", ""))
  observe_failure_with_duration(state, thread, id, label, early, U32.div(elapsed_ms, 1000))

def observe_native_model_fetch(state: Replay, thread: String, id: String, step: String, conclusion: String,
  exit_code: U32, +status: U32, revision: String, +line: String, origin: String, start: U32, end: U32) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +native_step = String.eq(step, "Prepare locked native prerequisites before first Cargo")
  +source = String.eq(origin, "download:record/media/circle-vision/build.ts")
  +server_error = Bool.and(U32.is_ge(status, 500), U32.is_lt(status, 600))
  +suffix = String.append(".onnx (", String.append(U32.show(status), ")"))
  resolve = String.append("/resolve/", String.append(revision, "/"))
  +download = Bool.and(String.starts_with(line, "Error: Download failed for https://huggingface.co/"),
    Bool.and(String.contains(line, resolve), String.ends_with(line, suffix)))
  +valid = Bool.and(failed, Bool.and(native_step, Bool.and(source, Bool.and(server_error, download))))
  observe_failed_step(state, thread, id, "ci-native-prerequisite-step", "circle-vision",
    "ci-model-prerequisite-http-server-error", valid, start, end)

def observe_toolchain_fetch(state: Replay, thread: String, id: String, step: String, conclusion: String,
  exit_code: U32, +status: U32, asset: String, line: String, origin: String, start: U32, end: U32) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +native_step = String.eq(step, "Prepare locked native prerequisites before first Cargo")
  +source = String.eq(origin, "prepareBend:shared/enablement/bend/toolchain.ts")
  +server_error = Bool.and(U32.is_ge(status, 500), U32.is_lt(status, 600))
  +expected = String.append("Error: Bend toolchain download failed for ",
    String.append(asset, String.append(": ", U32.show(status))))
  +valid = Bool.and(failed, Bool.and(native_step, Bool.and(source, Bool.and(server_error, String.eq(line, expected)))))
  observe_failed_step(state, thread, id, "ci-native-prerequisite-step", "bend-toolchain",
    "ci-toolchain-prerequisite-http-server-error", valid, start, end)

def observe_benchmark_admission(state: Replay, thread: String, id: String, +lane: String, conclusion: String,
  exit_code: U32, line: String, origin: String, start: U32, end: U32) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +connect = Bool.and(String.eq(lane, "connect-watch"), String.eq(origin, "main:connect/enablement/benchmark/hosted.ts"))
  +subset = String.eq(line, "AssertionError [ERR_ASSERTION]: No complete SMT subset qualified during replay probing")
  observe_failed_step(state, thread, id, "ci-benchmark-owner-step", lane, "ci-benchmark-no-qualified-smt-subset",
    Bool.and(failed, Bool.and(connect, subset)), start, end)

def observed_calibration_failure(conclusion: String, exit_code: U32, same_build: Bool) -> Bool:
  Bool.and(same_build, Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1)))

def observe_benchmark_marker(state: Replay, thread: String, id: String, +lane: String, conclusion: String,
  exit_code: U32, same_build: Bool, +line: String, start: U32, end: U32) -> Replay:
  +marker = Bool.or(String.eq(line, "Error: Startup benchmark timed out at painted recording marker"),
    String.eq(line, "Error: Startup benchmark timed out at revision-specific frame acknowledgement"))
  +failed = observed_calibration_failure(conclusion, exit_code, same_build)
  +valid = Bool.and(failed, Bool.and(String.eq(lane, "record-start"), marker))
  observe_failed_step(state, thread, id, "ci-benchmark-owner-step", lane,
    "ci-benchmark-calibration-marker-timeout", valid, start, end)

def observe_benchmark_pressure(state: Replay, thread: String, id: String, +lane: String, +source: String,
  conclusion: String, exit_code: U32, same_build: Bool, qualified: Bool, score_present: Bool, pressure_rejected: Bool,
  start: U32, end: U32) -> Replay:
  +start_source = Bool.and(String.eq(lane, "record-start"), String.eq(source, "calibration-artifact"))
  +stop_source = Bool.and(String.eq(lane, "record-stop"), String.eq(source, "stop-result"))
  +rejected = Bool.and(pressure_rejected, Bool.not(Bool.or(qualified, score_present)))
  +failed = observed_calibration_failure(conclusion, exit_code, same_build)
  +valid = Bool.and(failed, Bool.and(Bool.or(start_source, stop_source), rejected))
  observe_failed_step(state, thread, id, "ci-benchmark-owner-step", lane,
    "ci-benchmark-calibration-pressure-rejected", valid, start, end)

def deployment_label(+service: String, +line: String, +phase_line: String, +accepted: Bool) -> String:
  +admission_frame = Bool.and(String.starts_with(phase_line, "at admission (file:"),
    String.contains(phase_line, "/connect/tooling/hosting/scripts/deploy.ts:"))
  +readback_frame = Bool.and(String.starts_with(phase_line, "at async verifyReady (file:"),
    String.contains(phase_line, "/public/enablement/cd/publish-pages.ts:"))
  +current_main_frame = Bool.and(String.starts_with(phase_line, "at async currentMain (file:"),
    String.contains(phase_line, "/public/enablement/cd/publish-pages.ts:"))
  +superseded = Bool.and(String.eq(service, "connect-worker"),
    Bool.and(String.eq(line, "AssertionError [ERR_ASSERTION]: Candidate superseded by affected main changes"),
      admission_frame))
  +timeout = Bool.and(String.eq(service, "public-pages"), Bool.and(accepted,
    Bool.and(String.eq(line, "DOMException [TimeoutError]: The operation was aborted due to timeout"),
      readback_frame)))
  +auth = Bool.and(String.eq(service, "public-pages"), Bool.and(Bool.not(accepted),
    Bool.and(String.eq(line, "Error: Cloudflare API HTTP 401"), current_main_frame)))
  Bool.pick(String, superseded, "ci-deployment-candidate-superseded",
    Bool.pick(String, timeout, "ci-deployment-readback-timeout",
      Bool.pick(String, auth, "ci-pages-preflight-unauthorized", "")))

def observe_hosted_deploy(state: Replay, thread: String, id: String, service: String, conclusion: String,
  exit_code: U32, line: String, phase_line: String, accepted: Bool) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  observe_failure(state, thread, id, deployment_label(service, String.trim(line), String.trim(phase_line), accepted), failed)

def connect_deployment_label(+phase: String, +line: String, +origin: String, +previous: String, compared: String) -> String:
  +activation = Bool.and(String.eq(phase, "active-unverified"),
    Bool.and(String.eq(line, "AssertionError [ERR_ASSERTION]: Another publisher owns the active deployment"),
      String.eq(origin, "verifyActivationHistory:connect/tooling/hosting/scripts/profile.ts")))
  +matches = Bool.and(Bool.not(String.is_empty(previous)), String.eq(previous, compared))
  +preflight = Bool.and(String.eq(phase, "preflight"), Bool.and(matches,
    Bool.and(String.eq(line, "AssertionError [ERR_ASSERTION]: Expected \"actual\" to be strictly unequal to:"),
      String.eq(origin, "candidate-not-equal-previous:connect/tooling/hosting/scripts/deploy.ts"))))
  Bool.pick(String, activation, "ci-connect-activation-ownership-conflict",
    Bool.pick(String, preflight, "ci-connect-candidate-already-active", ""))

def observe_connect_deployment(+state: Replay, thread: String, +id: String, conclusion: String, exit_code: U32,
  revision: String, receipt_revision: String, +phase: String, line: String, origin: String, previous: String,
  compared: String, +start: U32, +end: U32) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  +label = connect_deployment_label(phase, line, origin, previous, compared)
  +valid = Bool.and(failed, Bool.and(String.eq(revision, receipt_revision), Bool.not(String.is_empty(label))))
  +closed = closed_clock(start, end)
  +seconds = Bool.pick(U32, closed, U32.sub(end, start), 0)
  Bool.pick(Replay, valid,
    observe_failure_with_duration(observe_timing(state, id, "ci-connect-delivery-owner-step", phase, start, end),
      thread, id, label, True{}, seconds), state)

def replay_files(state: Replay) -> List<&2, FileTotal>:
  match state:
    case Replay{_, files, _, _, _, _, _, _}: Map.values(&2, FileTotal, files)

def replay_costs(state: Replay) -> List<&2, Cost>:
  match state:
    case Replay{_, _, _, costs, _, _, _, _}: Map.values(&2, Cost, costs)

def replay_findings(state: Replay) -> List<&2, Finding>:
  match state:
    case Replay{_, _, _, _, _, _, _, findings}: List.reverse(&2, Finding, findings)

def update_pattern(+pattern: RulePattern, +new_thread: Bool, +seconds: U32) -> RulePattern:
  match pattern:
    case RulePattern{rule, threads, count, timed, +largest}:
      RulePattern{rule, U32.add(threads, Bool.pick(U32, new_thread, 1, 0)), U32.inc(count),
        U32.add(timed, Bool.pick(U32, U32.is_gt(seconds, 0), 1, 0)),
        Bool.pick(U32, U32.is_gt(seconds, largest), seconds, largest)}

def accumulate_pattern(state: RulePatterns, finding: Finding) -> RulePatterns:
  match state finding:
    case RulePatterns{+threads, +totals} Finding{+rule, +thread, _, _, seconds, _, _, _}:
      +key = pair(rule, thread)
      +identified = Bool.not(String.is_empty(thread))
      +fresh = Bool.and(identified, Bool.not(includes(threads, key)))
      +prior = found(~RulePattern, Map.get(RulePattern, RulePattern{rule, 0, 0, 0, 0}, totals, rule))
      Bool.pick(RulePatterns, identified, RulePatterns{Map.set(&2, Bool, threads, key, True{}),
        Map.set(&2, RulePattern, totals, rule, update_pattern(prior, fresh, seconds))}, RulePatterns{threads, totals})

def collect_rule_patterns(findings: List<&2, Finding>, state: RulePatterns) -> RulePatterns:
  match findings:
    case []: state
    case finding <> rest: collect_rule_patterns(rest, accumulate_pattern(state, finding))

def higher_prevalence(first: RulePattern, second: RulePattern) -> Bool:
  match first second:
    case RulePattern{_, +first_threads, first_count, _, _} RulePattern{_, +second_threads, second_count, _, _}:
      Bool.or(U32.is_gt(first_threads, second_threads),
        Bool.and(U32.is_eq(first_threads, second_threads), U32.is_gt(first_count, second_count)))

def ranked_patterns(state: RulePatterns) -> List<&2, RulePattern>:
  match state:
    case RulePatterns{_, totals}: List.sort(~RulePattern, ~higher_prevalence, Map.values(&2, RulePattern, totals))

def replay_patterns(state: Replay) -> List<&2, RulePattern>:
  ranked_patterns(collect_rule_patterns(replay_findings(state), RulePatterns{Map.new(&2, Bool), Map.new(&2, RulePattern)}))
