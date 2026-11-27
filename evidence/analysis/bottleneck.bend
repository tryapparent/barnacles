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

def update_cost(costs: Map<&2, Cost>, key: String, clock: String, operation: String, +start: U32, +end: U32,
  total: Cost) -> Map<&2, Cost>:
  match total:
    case Cost{_, _, count, seconds, unknown}:
      +closed = Bool.and(U32.is_gt(start, 0), U32.is_ge(end, start))
      Map.set(&2, Cost, costs, key, Cost{clock, operation,
        U32.add(count, Bool.pick(U32, closed, 1, 0)),
        U32.add(seconds, Bool.pick(U32, closed, U32.sub(end, start), 0)),
        U32.add(unknown, Bool.pick(U32, closed, 0, 1))})

def add_cost(+costs: Map<&2, Cost>, +clock: String, +operation: String, +start: U32, +end: U32) -> Map<&2, Cost>:
  +key = pair(clock, operation)
  update_cost(costs, key, clock, operation, start, end, found(~Cost, Map.get(Cost, Cost{clock, operation, 0, 0, 0}, costs, key)))

def observe_timing(state: Replay, id: String, +clock: String, operation: String, start: U32, end: U32) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("timing", pair(clock, id))
      Bool.pick(Replay, includes(seen, event), Replay{seen, files, reads, costs, attempts, cohorts, findings},
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads,
          add_cost(costs, clock, operation, start, end), attempts, cohorts, findings})

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
      +target = pair(thread, key)
      update_attempt(state, thread, id, start, end, failed, succeeded, event, target,
        found(~Attempt, Map.get(Attempt, Attempt{"", 0, 0, False{}}, attempts, target)))

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

def prerequisite_label(+line: String) -> String:
  +missing_checker = String.starts_with(line, "Staged checker could not load installed tools")
  +missing_typescript = Bool.and(String.starts_with(line, "Dependency policy failed: Staged TypeScript "),
    String.contains(line, ": locked TypeScript dependencies are missing for staged"))
  Bool.pick(String, Bool.or(missing_checker, missing_typescript), "staged-verification-prerequisite", "")

def observe_failure(state: Replay, +thread: String, +id: String, +label: String, failed: Bool) -> Replay:
  match state:
    case Replay{+seen, +files, +reads, +costs, +attempts, +cohorts, +findings}:
      +event = pair("failure", pair(thread, pair(label, id)))
      +valid = Bool.and(failed, Bool.and(Bool.not(String.is_empty(label)), Bool.not(includes(seen, event))))
      Bool.pick(Replay, valid,
        Replay{Map.set(&2, Bool, seen, event, True{}), files, reads, costs, attempts, cohorts,
          Finding{label, thread, id, "", 0, 0, 0, 0} <> findings},
        Replay{seen, files, reads, costs, attempts, cohorts, findings})

def observe_diagnostic(state: Replay, thread: String, id: String, line: String, failed: Bool) -> Replay:
  observe_failure(state, thread, id, prerequisite_label(String.trim(line)), failed)

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

def replay_files(state: Replay) -> List<&2, FileTotal>:
  match state:
    case Replay{_, files, _, _, _, _, _}: Map.values(&2, FileTotal, files)

def replay_costs(state: Replay) -> List<&2, Cost>:
  match state:
    case Replay{_, _, _, costs, _, _, _}: Map.values(&2, Cost, costs)

def replay_findings(state: Replay) -> List<&2, Finding>:
  match state:
    case Replay{_, _, _, _, _, _, findings}: List.reverse(&2, Finding, findings)
