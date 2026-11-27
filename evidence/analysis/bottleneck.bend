import Base

type FileTotal is Data:
  FileTotal{path: String, requests: U32, threads: U32, revisits: U32}

type Cost is Data:
  Cost{clock: String, operation: String, count: U32, seconds: U32, unknown: U32}

type Finding is Data:
  Finding{rule: String, thread: String, id: String, previous: String, seconds: U32, median: U32, p90: U32, peers: U32}

type Attempt is Data:
  Attempt{id: String, started: U32, ended: U32, failed: Bool}

type Peer is Data:
  Peer{revision: String, ended: U32, seconds: U32}

type Replay is Data:
  Replay{seen: Map<&2, Bool>, files: Map<&2, FileTotal>, reads: Map<&2, U32>,
    costs: Map<&2, Cost>, attempts: Map<&2, Attempt>, cohorts: Map<&2, List<&2, Peer>>,
    findings: List<&2, Finding>}

def start_replay() -> Replay:
  Replay{Map.new(&2, Bool), Map.new(&2, FileTotal), Map.new(&2, U32), Map.new(&2, Cost),
    Map.new(&2, Attempt), Map.new(&2, List<&2, Peer>), []}

def pair(+a: String, b: String) -> String:
  String.append(Nat.show(String.length(a)), String.append(":", String.append(a, b)))

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
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("file", pair(thread, pair(id, path)))
      +thread_path = pair(thread, path)
      +previous = found(~U32, Map.get(U32, 0, reads, thread_path))
      +duplicate = includes(seen, event)
      +ordered = U32.is_ge(at, previous)
      +valid = Bool.and(Bool.not(duplicate), Bool.and(ordered, U32.is_gt(at, 0)))
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}),
          file_total(files, path, previous, at), Map.set(&2, U32, reads, thread_path, at),
          costs, attempts, cohorts, findings},
        Replay{seen, files, reads, costs, attempts, cohorts, findings})

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
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("timing", pair(clock, id))
      +closed = Bool.and(U32.is_gt(start, 0), U32.is_ge(end, start))
      Bool.pick(Replay, includes(seen, event), Replay{seen, files, reads, costs, attempts, cohorts, findings},
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          add_cost(costs, clock, operation, closed, U32.sub(end, start)), attempts, cohorts, findings})

def observe_local_admission(state: Replay, +thread: String, +id: String, +wait_ms: U32, bound_ms: U32,
  +allocated: U32, capacity: U32) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("local-admission", pair(thread, id))
      +allocation_valid = Bool.and(U32.is_gt(allocated, 0), U32.is_ge(capacity, allocated))
      +valid = Bool.and(Bool.not(includes(seen, event)), Bool.and(allocation_valid, U32.is_ge(bound_ms, wait_ms)))
      +seconds = U32.div(wait_ms, 1000)
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          add_cost(costs, "local-build-admission", "t3-build", True{}, seconds), attempts, cohorts,
          Bool.pick(List<&2, Finding>, U32.is_ge(wait_ms, 60000),
            Finding{"local-build-admission-slow", thread, id, "", seconds, 0, 0, 0} <> findings, findings)},
        Replay{seen, files, reads, costs, attempts, cohorts, findings})

def update_attempt(state: Replay, thread: String, +id: String, +start: U32, +end: U32, failed: Bool,
  succeeded: Bool, +event: String, target: String, prior: Attempt) -> Replay:
  match state prior:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings} Attempt{previous, +last_start, +last_end, last_failed}:
          +valid = Bool.and(Bool.not(includes(seen, event)), Bool.and(U32.is_gt(start, 0),
            Bool.and(U32.is_ge(start, last_start), U32.is_ge(end, start))))
          +recovery = Bool.and(succeeded, Bool.and(last_failed,
            Bool.and(U32.is_ge(start, last_end), U32.is_le(U32.sub(start, last_end), 1800))))
          Bool.pick(Replay, valid,
            Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs,
              Map.set(&2, Attempt, attempts, target, Attempt{id, start, end, failed}), cohorts,
              Bool.pick(List<&2, Finding>, recovery, Finding{"recovered-attempt", thread, id, previous,
                U32.sub(end, last_end), 0, 0, 0} <> findings, findings)},
            Replay{seen, files, reads, costs, attempts, cohorts, findings})

def observe_attempt(+state: Replay, +thread: String, +id: String, key: String, +start: U32, +end: U32,
  +failed: Bool, +succeeded: Bool) -> Replay:
  match state:
    case Replay{_, _, _, _, attempts, _, _}:
      +event = pair("attempt", pair(thread, id))
      +target = pair("attempt", pair(thread, key))
      update_attempt(state, thread, id, start, end, failed, succeeded, event, target,
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, target)))

def update_repeat(state: Replay, thread: String, +id: String, label: String, +start: U32, end: U32,
  seconds: U32, valid: Bool, +target: String, +event: String, prior: Attempt) -> Replay:
  match state prior:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings} Attempt{previous, _, +last_end, _}:
      +ordered = Bool.and(U32.is_gt(start, 0), U32.is_ge(start, last_end))
      +accept = Bool.and(valid, Bool.and(ordered, Bool.not(includes(seen, event))))
      Bool.pick(Replay, accept,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs,
          Map.set(&2, Attempt, attempts, target, Attempt{id, start, end, False{}}), cohorts,
          Bool.pick(List<&2, Finding>, U32.is_gt(last_end, 0),
            Finding{label, thread, id, previous, seconds, 0, 0, 0} <> findings, findings)},
        Replay{seen, files, reads, costs, attempts, cohorts, findings})

def observe_repeat(+state: Replay, +thread: String, id: String, +label: String, scope: String, execution: String,
  start: U32, end: U32, seconds: U32, valid: Bool) -> Replay:
  match state:
    case Replay{_, _, _, _, attempts, _, _}:
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
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("peer", pair(clock, id))
      +key = pair(clock, cohort)
      +past = found(~List<&2, Peer>, Map.get(List<&2, Peer>, [], cohorts, key))
      +seconds = U32.sub(end, start)
      +valid = Bool.and(eligible, Bool.and(Bool.not(includes(seen, event)),
        Bool.and(U32.is_gt(start, 0), U32.is_ge(end, start))))
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs, attempts,
          Map.set(&2, List<&2, Peer>, cohorts, key, keep_peer(past, revision, end, seconds)),
          with_outlier(findings, earlier_peers(past, revision, start), clock, thread, id, seconds)},
        Replay{seen, files, reads, costs, attempts, cohorts, findings})

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
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("failure", pair(thread, pair(label, id)))
      +valid = Bool.and(failed, Bool.and(Bool.not(String.is_empty(label)), Bool.not(includes(seen, event))))
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs, attempts, cohorts,
          Finding{label, thread, id, "", seconds, 0, 0, 0} <> findings},
        Replay{seen, files, reads, costs, attempts, cohorts, findings})

def observe_failure(state: Replay, thread: String, id: String, label: String, failed: Bool) -> Replay:
  observe_failure_with_duration(state, thread, id, label, failed, 0)

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
  +reason = String.eq(String.trim(annotation), "The job was not acquired by Runner of type hosted even after multiple attempts")
  observe_failure(state, thread, id, "ci-hosted-admission-failure", Bool.and(cancelled, Bool.and(unallocated, reason)))

def pr_notice_reason(pr: U32, +message: String) -> String:
  +prefix = String.append("#", String.append(Nat.show(U32.to_nat(pr)), ": "))
  Bool.pick(String, String.eq(message, String.append(prefix, "merge conflict")), "merge-conflict",
    Bool.pick(String, String.eq(message, String.append(prefix, "checks passed, merge conflict")), "checks-passed-merge-conflict",
      Bool.pick(String, String.eq(message, String.append(prefix, "checks failed")), "checks-failed",
        Bool.pick(String, String.eq(message, String.append(prefix, "checks passed")), "checks-passed", ""))))

def observe_pr_notice(state: Replay, +thread: String, id: String, source_thread: String, visibility: String,
  status: String, truncated: Bool, +pr: U32, message: String) -> Replay:
  +local = Bool.and(String.eq(source_thread, thread), String.eq(visibility, "local"))
  +complete = Bool.and(String.eq(status, "completed"), Bool.not(truncated))
  +reason = pr_notice_reason(pr, message)
  +conflict = Bool.or(String.eq(reason, "merge-conflict"), String.eq(reason, "checks-passed-merge-conflict"))
  +valid = Bool.and(U32.is_gt(pr, 0), Bool.and(local, Bool.and(complete, conflict)))
  observe_failure(state, thread, id, "pr-merge-conflict-observed", valid)

def record_pr_watch_wake(state: Replay, +thread: String, +id: String, watch_id: String, reason: String,
  +seconds: U32, valid: Bool) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("watch-wake", pair(thread, id))
      +accept = Bool.and(valid, Bool.not(includes(seen, event)))
      Bool.pick(Replay, accept,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          add_cost(costs, "t3-pr-watch-parked", reason, True{}, seconds), attempts, cohorts,
          Finding{"t3-pr-watch-parked", thread, id, watch_id, seconds, 0, 0, 0} <> findings},
        Replay{seen, files, reads, costs, attempts, cohorts, findings})

def observe_pr_watch_wake(state: Replay, thread: String, id: String, watch_id: String, +pr: U32, message: String,
  +registered: U32, +parked: U32, +notified: U32, +prior: U32, next: U32, notice_stamp: String,
  requested_stamp: String) -> Replay:
  +reason = pr_notice_reason(pr, message)
  +ordered = Bool.and(U32.is_gt(registered, 0), Bool.and(U32.is_ge(parked, registered), U32.is_ge(notified, parked)))
  +wake = Bool.and(U32.is_gt(prior, 0), Bool.and(U32.is_eq(next, U32.inc(prior)), String.eq(notice_stamp, requested_stamp)))
  +valid = Bool.and(U32.is_gt(pr, 0), Bool.and(Bool.not(String.is_empty(reason)), Bool.and(ordered, wake)))
  record_pr_watch_wake(state, thread, id, watch_id, reason, U32.sub(notified, parked), valid)

def observe_forge_response(state: Replay, thread: String, id: String, operation: String, +status: U32,
  failed: Bool, identified: Bool) -> Replay:
  +server_error = Bool.and(U32.is_ge(status, 500), U32.is_lt(status, 600))
  +create = String.eq(operation, "github-pr-create")
  +valid = Bool.and(Bool.and(create, server_error), Bool.and(failed, identified))
  observe_failure(state, thread, id, "pr-create-http-server-error", valid)

def observe_actions_rate_limit(state: Replay, thread: String, id: String, +operation: String, status: U32, +line: String,
  failed: Bool) -> Replay:
  +read = Bool.and(String.eq(operation, "actions-job-read"), String.eq(line, "gh: API rate limit exceeded (HTTP 403)"))
  +watch = Bool.and(String.eq(operation, "actions-run-watch"), String.eq(line, "failed to get run: HTTP 403: API rate limit exceeded"))
  +valid = Bool.and(failed, Bool.and(U32.is_eq(status, 403), Bool.or(read, watch)))
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
  +timeout = Bool.and(U32.is_eq(exit_code, 124),
    String.eq(String.trim(line), "t3-build: timed out waiting for admission"))
  observe_failure(state, thread, id, "local-build-admission-timeout", timeout)

def observe_socket_preflight(state: Replay, thread: String, id: String, +required: U32, +limit: U32,
  line: String, origin: String) -> Replay:
  +boundary = String.eq(origin, "check_temp_environment:enablement/verification.py")
  +expected = String.append("RuntimeError: verification TMPDIR preflight: socket fixture needs ",
    String.append(U32.show(required), String.append(" pathname bytes; platform permits ", String.append(U32.show(limit), "."))))
  +matches = String.eq(line, expected)
  +exceeded = Bool.and(U32.is_gt(limit, 0), U32.is_gt(required, limit))
  observe_failure(state, thread, id, "local-verification-socket-path-limit", Bool.and(boundary, Bool.and(matches, exceeded)))

def capture_access_label(+line: String, +lookup: Bool, fetch: Bool) -> String:
  +unavailable = Bool.and(lookup, String.starts_with(line, "Error: Capture unavailable (not_found)."))
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
  Bool.pick(String, onboarding, "ci-onboarding-release-artifact-conflict",
    Bool.pick(String, Bool.and(upload, upload_line), "ci-release-upload-server-error", ""))

def observe_hosted_publish(state: Replay, thread: String, id: String, publisher: String, conclusion: String,
  exit_code: U32, status: U32, line: String) -> Replay:
  +failed = Bool.and(String.eq(conclusion, "failure"), U32.is_eq(exit_code, 1))
  observe_failure(state, thread, id, publication_label(publisher, String.trim(line), status), failed)

def observe_failed_step(+state: Replay, thread: String, +id: String, clock: String, operation: String, label: String,
  valid: Bool, start: U32, end: U32) -> Replay:
  Bool.pick(Replay, valid,
    observe_failure(observe_timing(state, id, clock, operation, start, end), thread, id, label, True{}),
    state)

def observe_workflow_gate(+state: Replay, thread: String, +id: String, +job: String, +prerequisite: String,
  +attempt_started: U32, +earliest_job: U32, +previous: U32, +gate: U32, started: U32) -> Replay:
  +original = Bool.and(U32.is_gt(attempt_started, 0), Bool.and(U32.is_ge(earliest_job, attempt_started),
    U32.is_ge(previous, earliest_job)))
  +seconds = U32.sub(gate, previous)
  +ordered = Bool.and(U32.is_ge(gate, previous), Bool.and(U32.is_ge(started, gate), U32.is_ge(seconds, 60)))
  +distinct = Bool.not(String.eq(job, prerequisite))
  +operation = String.append(job, String.append(" needs ", prerequisite))
  +valid = Bool.and(original, Bool.and(ordered, distinct))
  Bool.pick(Replay, valid,
    observe_failure_with_duration(observe_timing(state, id, "ci-workflow-status-gate", operation, previous, gate),
      thread, id, "ci-workflow-status-gate", True{}, seconds), state)

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
  +closed = Bool.and(U32.is_gt(start, 0), U32.is_ge(end, start))
  +seconds = Bool.pick(U32, closed, U32.sub(end, start), 0)
  Bool.pick(Replay, valid,
    observe_failure_with_duration(observe_timing(state, id, "ci-connect-delivery-owner-step", phase, start, end),
      thread, id, label, True{}, seconds), state)

def replay_files(state: Replay) -> List<&2, FileTotal>:
  match state:
    case Replay{_, files, _, _, _, _, _}: Map.values(&2, FileTotal, files)

def replay_costs(state: Replay) -> List<&2, Cost>:
  match state:
    case Replay{_, _, _, costs, _, _, _}: Map.values(&2, Cost, costs)

def replay_findings(state: Replay) -> List<&2, Finding>:
  match state:
    case Replay{_, _, _, _, _, _, findings}: List.reverse(&2, Finding, findings)
