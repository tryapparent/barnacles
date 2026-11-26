import Base

type Span is Data:
  Interval{start: Nat, end: Nat, observed: Bool}

type ReportWindow is Data:
  Window{start: Nat, end: Nat}

def report_window(+cutoff_ms: Nat) -> ReportWindow:
  Window{Nat.sub(cutoff_ms, 86400000n), cutoff_ms}

def positive(span: Span) -> Bool:
  match span:
    case Interval{start, end, observed}: Bool.and(observed, Nat.is_lt(start, end))

def intersect(left: Span, right: Span) -> Span:
  match left right:
    case Interval{a, b, left_seen} Interval{c, d, right_seen}:
      Interval{Nat.max(a, c), Nat.min(b, d), Bool.and(left_seen, right_seen)}

def overlap(left: Span, right: Span) -> Nat:
  match left right:
    case Interval{a, b, x} Interval{c, d, y}:
      Bool.pick(Nat, Bool.and(x, y), Nat.sub(Nat.min(b, d), Nat.max(a, c)), 0n)

def span_before(left: Span, right: Span) -> Bool:
  match left right:
    case Interval{a, b, x} Interval{c, d, y}: Nat.is_le(a, c)

def merge_span(spans: List<&2, Span>, span: Span) -> List<&2, Span>:
  match spans span:
    case Nil{} Interval{a, b, observed}: Interval{a, b, observed} <> []
    case Con{Interval{+a, +b, +x}, +rest} Interval{+c, +d, +y}:
      Bool.pick(List<&2, Span>, Nat.is_le(c, b), Interval{a, Nat.max(b, d), Bool.and(x, y)} <> rest,
        Interval{c, d, y} <> Interval{a, b, x} <> rest)

def union(spans: List<&2, Span>) -> List<&2, Span>:
  List.foldl(~&2, ~Span, ~List<&2, Span>, ~merge_span, List.sort(~Span, ~span_before, spans), [])

def total(spans: List<&2, Span>, +acc: Nat) -> Nat:
  match spans:
    case []: acc
    case Interval{start, end, observed} <> rest: total(rest, Nat.add(acc, Nat.sub(end, start)))

def overlap_span(+clock: Span, spans: List<&2, Span>, +acc: Nat) -> Nat:
  match spans:
    case []: acc
    case span <> rest: overlap_span(clock, rest, Nat.add(acc, overlap(clock, span)))

def overlap_spans(left: List<&2, Span>, +right: List<&2, Span>, +acc: Nat) -> Nat:
  match left:
    case []: acc
    case span <> tail: overlap_spans(tail, right, overlap_span(span, right, acc))

type Duration is Data:
  Measured{ms: Nat}
  Missing{}

def add_duration(left: Duration, right: Duration) -> Duration:
  match left right:
    case Missing{} value: value
    case value Missing{}: value
    case Measured{a} Measured{b}: Measured{Nat.add(a, b)}

def duration_value(value: Duration) -> Nat:
  match value:
    case Missing{}: 0n
    case Measured{ms}: ms

def measured_overlap(+clock: Span, waits: List<&2, Span>) -> Duration:
  Bool.pick(Duration, positive(clock), Measured{overlap_span(clock, waits, 0n)}, Missing{})

type ActionIdentity is Data:
  Identity{repository: String, run_id: Nat, head_sha: String, attempt: Nat}

def identity_key(identity: ActionIdentity) -> String:
  match identity:
    case Identity{repo, run, sha, attempt}:
      String.append(Nat.show(run), String.append(":", String.append(Nat.show(attempt), String.append(":", String.append(sha, String.append(":", repo))))))

def exact_identity(identity: ActionIdentity) -> Bool:
  match identity:
    case Identity{repository, run_id, head_sha, attempt}:
      Bool.and(Bool.not(String.eq(repository, "")), Bool.and(Bool.not(String.eq(head_sha, "")),
        Bool.and(Nat.is_lt(0n, run_id), Nat.is_lt(0n, attempt))))

type JobClock is Data:
  Job{job_id: Nat, label: String, execution: Span, queue: Span}

type StepClock is Data:
  Step{job_id: Nat, number: Nat, label: String, execution: Span}

type WaitGroup is Data:
  NoWaits{}
  Waits{identity: ActionIdentity, count: Nat, spans: List<&2, Span>, matched: Bool,
        jobs: List<&2, JobClock>, steps: Map<&2, List<&2, StepClock>>}

type WaitInputs is Data:
  Inputs{window: ReportWindow, repository: String, wait_count: Nat, groups: Map<&2, WaitGroup>}

def start_report(window: ReportWindow, repository: String) -> WaitInputs:
  Inputs{window, repository, 0n, Map.new(&2, WaitGroup)}

def add_wait_found(found: Map<&2, WaitGroup> & WaitGroup, +key: String, identity: ActionIdentity, +span: Span) -> Map<&2, WaitGroup>:
  match found:
    case (groups, NoWaits{}):
      Map.set(&2, WaitGroup, groups, key, Waits{identity, 1n, span <> [], False{}, [], Map.new(&2, List<&2, StepClock>)})
    case (groups, Waits{previous, count, spans, matched, jobs, steps}):
      Map.set(&2, WaitGroup, groups, key, Waits{previous, Nat.add(count, 1n), span <> spans, matched, jobs, steps})

def count_wait(window: ReportWindow, scope: String, count: Nat, groups: Map<&2, WaitGroup>,
               exact: Bool, +identity: ActionIdentity, span: Span) -> WaitInputs:
  match exact:
    case False{}: Inputs{window, scope, Nat.add(count, 1n), groups}
    case True{}:
      +key = identity_key(identity)
      Inputs{window, scope, Nat.add(count, 1n), add_wait_found(Map.get(WaitGroup, NoWaits{}, groups, key), key, identity, span)}

def keep_wait(keep: Bool, inputs: WaitInputs, window: ReportWindow, scope: String, count: Nat,
              groups: Map<&2, WaitGroup>, exact: Bool, identity: ActionIdentity, clipped: Span) -> WaitInputs:
  match keep:
    case False{}: inputs
    case True{}: count_wait(window, scope, count, groups, exact, identity, clipped)

def observe_wait(+inputs: WaitInputs, +identity: ActionIdentity, exact: Bool, +span: Span) -> WaitInputs:
  match inputs identity:
    case Inputs{Window{+start, +end}, +scope, count, groups} Identity{repo, run, sha, attempt}:
      +clipped = intersect(Interval{start, end, True{}}, span)
      keep_wait(Bool.and(String.eq(scope, repo), Bool.and(positive(span), positive(clipped))),
        inputs, Window{start, end}, scope, count, groups, Bool.and(exact, exact_identity(identity)), identity, clipped)

type ImportFact is Data:
  AttemptRow{}
  JobRow{job: JobClock}
  StepRow{step: StepClock}

def add_step_found(found: Map<&2, List<&2, StepClock>> & List<&2, StepClock>,
                   key: String, step: StepClock) -> Map<&2, List<&2, StepClock>>:
  match found:
    case (steps, previous): Map.set(&2, List<&2, StepClock>, steps, key, step <> previous)

def add_fact(group: WaitGroup, fact: ImportFact) -> WaitGroup:
  match group fact:
    case Waits{id, count, spans, old, jobs, steps} AttemptRow{}:
      Waits{id, count, spans, True{}, jobs, steps}
    case Waits{id, count, spans, matched, jobs, steps} JobRow{job}:
      Waits{id, count, spans, matched, job <> jobs, steps}
    case Waits{id, count, spans, matched, jobs, steps} StepRow{+step}:
      match step:
        case Step{job_id, number, label, clock}:
          +key = Nat.show(job_id)
          Waits{id, count, spans, matched, jobs,
            add_step_found(Map.get(List<&2, StepClock>, [], steps, key), key, step)}
    case NoWaits{} _: NoWaits{}

def add_import_found(found: Map<&2, WaitGroup> & WaitGroup, key: String, fact: ImportFact) -> Map<&2, WaitGroup>:
  match found:
    case (groups, NoWaits{}): groups
    case (groups, group): Map.set(&2, WaitGroup, groups, key, add_fact(group, fact))

def observe_import(inputs: WaitInputs, identity: ActionIdentity, fact: ImportFact) -> WaitInputs:
  match inputs:
    case Inputs{window, repository, count, groups}:
      +key = identity_key(identity)
      Inputs{window, repository, count, add_import_found(Map.get(WaitGroup, NoWaits{}, groups, key), key, fact)}

type CapturePlan is Data:
  Capture{missing: Nat, attempts: List<&2, ActionIdentity>}

def waits_before(left: WaitGroup, right: WaitGroup) -> Bool:
  match left right:
    case Waits{a, +x, s, m, j, t} Waits{b, +y, u, n, k, v}:
      Bool.or(Nat.is_lt(y, x), Bool.and(Nat.is_eq(x, y), String.is_lt(identity_key(a), identity_key(b))))
    case Waits{a, x, s, m, j, t} NoWaits{}: True{}
    case NoWaits{} _: False{}

def restore_capture_order(attempts: List<&2, ActionIdentity>, ordered: List<&2, ActionIdentity>) -> List<&2, ActionIdentity>:
  match attempts:
    case []: ordered
    case identity <> tail: restore_capture_order(tail, identity <> ordered)

def next_capture(groups: List<&2, WaitGroup>, +limit: Nat, +missing: Nat, +attempts: List<&2, ActionIdentity>) -> CapturePlan:
  match groups:
    case []: Capture{missing, restore_capture_order(attempts, [])}
    case Waits{id, count, spans, False{}, jobs, steps} <> rest:
      next_capture(rest, Nat.sub(limit, 1n), Nat.add(missing, 1n),
        Bool.pick(List<&2, ActionIdentity>, Nat.is_lt(0n, limit), id <> attempts, attempts))
    case _ <> rest: next_capture(rest, limit, missing, attempts)

def capture_plan(inputs: WaitInputs, limit: Nat) -> CapturePlan:
  match inputs:
    case Inputs{window, repo, count, groups}:
      next_capture(List.sort(~WaitGroup, ~waits_before, Map.values(&2, WaitGroup, groups)), Nat.min(limit, 20n), 0n, [])

type ClockEvent is Data:
  Edge{at: Nat, opening: Bool}

def event_before(left: ClockEvent, right: ClockEvent) -> Bool:
  match left right:
    case Edge{a, x} Edge{b, y}: Nat.is_le(a, b)

type Clocks is Data:
  Clocks{edges: List<&2, ClockEvent>, queues: List<&2, Span>}

def collect_clocks(jobs: List<&2, JobClock>, +edges: List<&2, ClockEvent>, +queues: List<&2, Span>) -> Clocks:
  match jobs:
    case []: Clocks{edges, queues}
    case Job{id, label, +execution, +queue} <> tail:
      match execution:
        case Interval{start, end, observed}:
          collect_clocks(tail,
            Bool.pick(List<&2, ClockEvent>, positive(execution), Edge{start, True{}} <> Edge{end, False{}} <> edges, edges),
            Bool.pick(List<&2, Span>, positive(queue), queue <> queues, queues))

type Running is Data:
  Running{all: List<&2, Span>, solo: List<&2, Span>}

def scan_running(events: List<&2, ClockEvent>, +previous: Nat, +active: Nat,
                 +all: List<&2, Span>, +solo: List<&2, Span>) -> Running:
  match events:
    case []: Running{all, solo}
    case Edge{+at, opening} <> rest:
      +elapsed = Nat.is_lt(previous, at)
      +span : Span = Interval{previous, at, True{}}
      scan_running(rest, at, Bool.pick(Nat, opening, Nat.add(active, 1n), Nat.sub(active, 1n)),
        Bool.pick(List<&2, Span>, Bool.and(elapsed, Nat.is_lt(0n, active)), span <> all, all),
        Bool.pick(List<&2, Span>, Bool.and(elapsed, Nat.is_eq(active, 1n)), span <> solo, solo))

def intersect_list(+span: Span, spans: List<&2, Span>, +acc: List<&2, Span>) -> List<&2, Span>:
  match spans:
    case []: acc
    case next <> rest:
      +clipped = intersect(span, next)
      intersect_list(span, rest, Bool.pick(List<&2, Span>, positive(clipped), clipped <> acc, acc))

def intersect_lists(left: List<&2, Span>, +right: List<&2, Span>, acc: List<&2, Span>) -> List<&2, Span>:
  match left:
    case []: acc
    case span <> rest: intersect_lists(rest, right, intersect_list(span, right, acc))

type Coverage is Data:
  Coverage{wait_count: Nat, exact_wait_count: Nat, matched_wait_count: Nat, matched_attempts: Nat,
           unmatched_attempts: Nat, jobless_attempts: Nat, matched_wait_ms: Nat, running_ms: Nat,
           queue_only_ms: Nat, unknown_job_ms: Nat}

type JobInstance is Data:
  Instance{identity: ActionIdentity, job_id: Nat, job_label: String, execution_ms: Duration,
           only_known_running_ms: Duration, queue_ms: Duration}

type StepInstance is Data:
  StepInstance{run_id: Nat, attempt: Nat, job_id: Nat, step_number: Nat, step_label: String, execution_ms: Duration}

type JobSummary is Data:
  Summary{job_label: String, job_count: Nat, execution_ms: Duration, only_known_running_ms: Duration, queue_ms: Duration}

type JobRank is Data:
  Ranked{rank: Nat, summary: JobSummary}

type Attribution is Data:
  Attribution{coverage: Coverage, jobs: List<&2, JobRank>, instances: List<&2, JobInstance>, steps: List<&2, StepInstance>}

type ReportState is Data:
  Report{coverage: Coverage, groups: Map<&2, JobSummary>, instances: List<&2, JobInstance>, steps: List<&2, StepInstance>}

def summarize_job(found: Map<&2, JobSummary> & JobSummary, +label: String,
                  execution: Duration, solo: Duration, queue: Duration) -> Map<&2, JobSummary>:
  match found:
    case (groups, Summary{old_label, count, old_execution, old_solo, old_queue}):
      Map.set(&2, JobSummary, groups, label, Summary{label, Nat.add(count, 1n),
        add_duration(old_execution, execution), add_duration(old_solo, solo), add_duration(old_queue, queue)})

def keep_summary(keep: Bool, groups: Map<&2, JobSummary>, +label: String,
                 execution: Duration, solo: Duration, queue: Duration) -> Map<&2, JobSummary>:
  match keep:
    case False{}: groups
    case True{}: summarize_job(Map.get(JobSummary, Summary{label, 0n, Missing{}, Missing{}, Missing{}}, groups, label),
      label, execution, solo, queue)

def add_instance(state: ReportState, +instance: JobInstance) -> ReportState:
  match state instance:
    case Report{coverage, +groups, instances, steps} Instance{id, job_id, +label, +execution, solo, +queue}:
      Report{coverage, keep_summary(Bool.or(Nat.is_lt(0n, duration_value(execution)), Nat.is_lt(0n, duration_value(queue))),
        groups, label, execution, solo, queue), instance <> instances, steps}

def step_overlap(+step: Span, +job: Span, waits: List<&2, Span>) -> Duration:
  Bool.pick(Duration, Bool.and(positive(step), positive(job)),
    Measured{overlap_span(intersect(step, job), waits, 0n)}, Missing{})

def add_steps(steps: List<&2, StepClock>, state: ReportState, +identity: ActionIdentity, +job: Span,
              +waits: List<&2, Span>) -> ReportState:
  match steps state identity:
    case Nil{} Report{coverage, groups, instances, output} Identity{repo, run, sha, attempt}:
      Report{coverage, groups, instances, output}
    case Con{Step{id, number, label, clock}, tail} Report{coverage, groups, instances, output} Identity{repo, run, sha, attempt}:
      add_steps(tail, Report{coverage, groups, instances,
        StepInstance{run, attempt, id, number, label, step_overlap(clock, job, waits)} <> output},
        identity, job, waits)

def report_job_steps(found: Map<&2, List<&2, StepClock>> & List<&2, StepClock>, state: ReportState,
                     identity: ActionIdentity, job: Span, waits: List<&2, Span>) ->
    Map<&2, List<&2, StepClock>> & ReportState:
  match found:
    case (steps, observed): (steps, add_steps(observed, state, identity, job, waits))

def report_jobs(jobs: List<&2, JobClock>, current: Map<&2, List<&2, StepClock>> & ReportState, +identity: ActionIdentity,
                +waits: List<&2, Span>, +solo: List<&2, Span>) -> ReportState:
  match jobs current:
    case Nil{} remaining:
      match remaining:
        case (steps, state): state
    case Con{Job{+id, label, +execution, queue}, rest} remaining:
      match remaining:
        case (steps, state):
          next = add_instance(state, Instance{identity, id, label, measured_overlap(execution, waits),
            measured_overlap(execution, solo), measured_overlap(queue, waits)})
          report_jobs(rest, report_job_steps(Map.get(List<&2, StepClock>, [], steps, Nat.show(id)), next, identity, execution, waits),
            identity, waits, solo)

def add_coverage(coverage: Coverage, +count: Nat, +matched: Nat, unmatched: Nat, jobless: Nat,
                 +elapsed: Nat, +running: Nat, +queue_only: Nat) -> Coverage:
  match coverage:
    case Coverage{waits, exact, matched_waits, attempts, missing, empty, duration, active, queued, unknown}:
      Coverage{waits, Nat.add(exact, count), Nat.add(matched_waits, Nat.mul(count, matched)),
        Nat.add(attempts, matched), Nat.add(missing, unmatched), Nat.add(empty, jobless), Nat.add(duration, elapsed),
        Nat.add(active, running), Nat.add(queued, queue_only), Nat.add(unknown, Nat.sub(elapsed, Nat.add(running, queue_only)))}

def jobs_empty(jobs: List<&2, JobClock>) -> Nat:
  match jobs:
    case []: 1n
    case _ <> _: 0n

def report_clocks(state: ReportState, identity: ActionIdentity, count: Nat, +waits: List<&2, Span>,
                  +jobs: List<&2, JobClock>, steps: Map<&2, List<&2, StepClock>>,
                  running_clocks: Running, queues: List<&2, Span>) -> ReportState:
  match state running_clocks:
    case Report{coverage, groups, instances, output} Running{+running, solo}:
      +running_ms = overlap_spans(waits, running, 0n)
      active_ms = overlap_spans(waits, union(List.append(&2, Span, running, queues)), 0n)
      next : ReportState = Report{add_coverage(coverage, count, 1n, 0n, jobs_empty(jobs), total(waits, 0n),
        running_ms, Nat.sub(active_ms, running_ms)), groups, instances, output}
      report_jobs(jobs, (steps, next), identity, waits, intersect_lists(waits, solo, []))

def report_matched(state: ReportState, identity: ActionIdentity, count: Nat, waits: List<&2, Span>,
                   jobs: List<&2, JobClock>, steps: Map<&2, List<&2, StepClock>>, clocks: Clocks) -> ReportState:
  match clocks:
    case Clocks{edges, queues}:
      report_clocks(state, identity, count, waits, jobs, steps,
        scan_running(List.sort(~ClockEvent, ~event_before, edges), 0n, 0n, [], []), queues)

def report_group(state: ReportState, group: WaitGroup) -> ReportState:
  match state group:
    case Report{coverage, groups, instances, output} NoWaits{}:
      Report{coverage, groups, instances, output}
    case Report{coverage, groups, instances, output} Waits{identity, count, spans, True{}, +jobs, steps}:
      report_matched(Report{coverage, groups, instances, output}, identity, count, union(spans), jobs, steps, collect_clocks(jobs, [], []))
    case Report{coverage, groups, instances, output} Waits{identity, count, spans, False{}, jobs, steps}:
      Report{add_coverage(coverage, count, 0n, 1n, 0n, 0n, 0n, 0n), groups, instances, output}

def summary_before(left: JobSummary, right: JobSummary) -> Bool:
  match left right:
    case Summary{a, an, ax, asolo, aq} Summary{b, bn, bx, bsolo, bq}:
      +x = duration_value(ax)
      +y = duration_value(bx)
      Bool.or(Nat.is_lt(y, x), Bool.and(Nat.is_eq(x, y), String.is_lt(a, b)))

def assign_rank(jobs: List<&2, JobSummary>, +rank: Nat) -> List<&2, JobRank>:
  match jobs:
    case []: []
    case job <> tail: Ranked{rank, job} <> assign_rank(tail, Nat.add(rank, 1n))

def finish_state(state: ReportState) -> Attribution:
  match state:
    case Report{coverage, groups, instances, steps}:
      Attribution{coverage, assign_rank(List.sort(~JobSummary, ~summary_before, Map.values(&2, JobSummary, groups)), 1n),
        instances, steps}

def finish_report(inputs: WaitInputs) -> Attribution:
  match inputs:
    case Inputs{window, repository, count, groups}:
      finish_state(List.foldl(~&2, ~WaitGroup, ~ReportState, ~report_group, Map.values(&2, WaitGroup, groups),
        Report{Coverage{count, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n}, Map.new(&2, JobSummary), [], []}))
