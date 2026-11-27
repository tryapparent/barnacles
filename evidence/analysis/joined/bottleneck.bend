import Base
import ../bottleneck.bend as Study
import ../../storage/codex-otel.bend as Otel
import ./dashboard.bend as Dashboard

type Span is Data:
  Span{id: String, operation: String, start: String, end: String}

type Run is Data:
  Run{id: String, requested: String, started: String, completed: String}

type Job is Data:
  Job{id: String, label: String, status: String, conclusion: String, prior: Bool,
    created: String, queued: String, started: String, completed: String}

type JoinedAnalysis is Data:
  JoinedAnalysis{replay: Study.Replay, runs: U32, spans: U32, attempts: U32, jobs: U32, carried: U32}

def digits(chars: List<&2, Char>, +value: Nat) -> Nat:
  match chars:
    case []: value
    case Chr{code} <> tail:
      digits(tail, Nat.add(Nat.mul(value, 10n), U32.to_nat(U32.sub(code, 48))))

def seconds(+text: String, trailing: Nat) -> U32:
  +parts = Nat.sub(String.length(text), trailing)
  +value = digits(String.to_list(String.take(text, parts)), 0n)
  Bool.pick(U32, Bool.and(Otel.small_decimal(text, 20n), Nat.is_le(value, 4294967295n)),
    U32.from_nat(value), 0)

def span_observation(state: Study.Replay, +id: String, operation: String, +start: String, +end: String) -> Study.Replay:
  +valid = Bool.and(Otel.clock(start), Bool.and(Otel.clock(end), Otel.decimal_before_or_equal(start, end)))
  Study.observe_timing(state, id, "codex-otel-span", operation,
    Bool.pick(U32, valid, seconds(start, 9n), 0), Bool.pick(U32, valid, seconds(end, 9n), 0))

def span_replay(spans: List<&2, Span>, state: Study.Replay) -> Study.Replay:
  match spans:
    case []: state
    case Span{id, operation, start, end} <> tail:
      span_replay(tail, span_observation(state, id, operation, start, end))

def run_replay(runs: List<&2, Run>, state: Study.Replay) -> Study.Replay:
  match runs:
    case []: state
    case Run{+id, requested, +started, completed} <> tail:
      admitted = Study.observe_timing(state, id, "t3-run-admission", "provider run", seconds(requested, 3n), seconds(started, 3n))
      run_replay(tail, Study.observe_timing(admitted, id, "t3-run-envelope", "provider run", seconds(started, 3n), seconds(completed, 3n)))

def job_observation(+state: Study.Replay, +thread: String, +job: Job) -> Study.Replay:
  match job:
    case Job{+id, +label, status, conclusion, prior, created, queued, started, completed}:
      match prior:
        case True{}: state
        case False{}:
          queued_state = Study.observe_timing(state, id, "ci-job-queue", label, seconds(created, 0n), seconds(queued, 0n))
          timed = Study.observe_timing(queued_state, id, "ci-job-execution", label, seconds(started, 0n), seconds(completed, 0n))
          Study.observe_job_result(timed, thread, id, Bool.pick(String, String.eq(status, "completed"), conclusion, ""))

def job_replay(jobs: List<&2, Job>, +thread: String, state: Study.Replay) -> Study.Replay:
  match jobs:
    case []: state
    case job <> tail: job_replay(tail, thread, job_observation(state, thread, job))

def carried_jobs(jobs: List<&2, Job>, +count: U32) -> U32:
  match jobs:
    case []: count
    case Job{_, _, _, _, prior, _, _, _, _} <> tail:
      carried_jobs(tail, U32.add(count, Bool.pick(U32, prior, 1, 0)))

def project(+thread: String, +runs: List<&2, Run>, +spans: List<&2, Span>, attempts: U32, +jobs: List<&2, Job>) -> JoinedAnalysis:
  JoinedAnalysis{job_replay(jobs, thread, span_replay(spans, run_replay(runs, Study.start_replay()))),
    U32.from_nat(List.length(&2, Run, runs)), U32.from_nat(List.length(&2, Span, spans)), attempts,
    U32.from_nat(List.length(&2, Job, jobs)), carried_jobs(jobs, 0)}

def files(result: JoinedAnalysis) -> List<&2, Study.FileTotal>:
  match result:
    case JoinedAnalysis{replay, _, _, _, _, _}: Study.replay_files(replay)

def costs(+result: JoinedAnalysis) -> List<&2, Study.Cost>:
  match result:
    case JoinedAnalysis{replay, _, _, _, _, _}: Study.replay_costs(replay)

def findings(+result: JoinedAnalysis) -> List<&2, Study.Finding>:
  match result:
    case JoinedAnalysis{replay, _, _, _, _, _}: Study.replay_findings(replay)

def patterns(+result: JoinedAnalysis) -> List<&2, Study.RulePattern>:
  match result:
    case JoinedAnalysis{replay, _, _, _, _, _}: Study.replay_patterns(replay)

def window_results(+window: Dashboard.DayWindow, jobs: List<&2, Job>, state: Study.Replay) -> Study.Replay:
  match jobs:
    case []: state
    case Job{+id, _, status, conclusion, prior, _, _, _, completed} <> tail:
      +at = Nat.mul(U32.to_nat(seconds(completed, 0n)), 1000n)
      +eligible = Bool.and(Bool.not(prior), Bool.and(String.eq(status, "completed"), Dashboard.within(window, at)))
      +next = Study.observe_job_result(state, "", id, Bool.pick(String, eligible, conclusion, ""))
      window_results(window, tail, next)

def observations(findings: List<&2, Study.Finding>) -> List<&2, Dashboard.DayObservation>:
  match findings:
    case []: []
    case Study.Finding{rule, _, id, _, _, _, _, _} <> tail:
      Dashboard.DayObservation{rule, id} <> observations(tail)

def window_observations(window: Dashboard.DayWindow, jobs: List<&2, Job>) -> List<&2, Dashboard.DayObservation>:
  observations(Study.replay_findings(window_results(window, jobs, Study.start_replay())))
