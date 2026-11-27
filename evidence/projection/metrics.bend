import Base
import ../repository.bend as Repository

type Sample is Data:
  Stats{count: Nat, total: Nat, missing: Nat}

def record(sample: Sample, value: Nat) -> Sample:
  match sample:
    case Stats{count, total, missing}: Stats{Nat.add(count, 1n), Nat.add(total, value), missing}

def interval_valid(+start: Nat, end: Nat) -> Bool:
  Bool.and(Bool.not(Nat.is_eq(start, 0n)), Nat.is_le(start, end))

def unavailable(sample: Sample) -> Sample:
  match sample:
    case Stats{count, total, missing}: Stats{count, total, Nat.add(missing, 1n)}

def record_interval(+sample: Sample, +start: Nat, +end: Nat) -> Sample:
  Bool.pick(Sample, interval_valid(start, end), record(sample, Nat.sub(end, start)), unavailable(sample))

type CycleStage is Data:
  Measured{ms: Nat}
  Missing{}

def cycle_stage(+start: Nat, +finish: Nat) -> CycleStage:
  Bool.pick(CycleStage, interval_valid(start, finish), Measured{Nat.sub(finish, start)}, Missing{})

def count_cycle_stage(+sample: Sample, stage: CycleStage) -> Sample:
  match stage:
    case Measured{ms}: record(sample, ms)
    case Missing{}: unavailable(sample)

type Ratio is Data:
  Fraction{numerator: Nat, denominator: Nat}

def mean(sample: Sample) -> Ratio:
  match sample:
    case Stats{count, total, missing}: Fraction{total, count}

def week(+epoch: Nat) -> Nat:
  Nat.sub(epoch, Nat.mod(Nat.add(epoch, 259200n), 604800n))

def previous_week(epoch: Nat) -> Nat:
  Nat.sub(week(epoch), 604800n)

type Direction is Data:
  Insufficient{}
  Gardening{delta: Ratio}
  Shipping{delta: Ratio}

def difference(+recent: Nat, +prior: Nat, +denominator: Nat) -> Direction:
  Bool.pick(Direction, Nat.is_lt(prior, recent),
    Gardening{Fraction{Nat.sub(recent, prior), denominator}},
    Shipping{Fraction{Nat.sub(prior, recent), denominator}})

def direction(recent: Sample, prior: Sample) -> Direction:
  match recent prior:
    case Stats{+rc, rt, rm} Stats{+pc, pt, pm}:
      Bool.pick(Direction, Bool.or(Nat.is_eq(rc, 0n), Nat.is_eq(pc, 0n)), Insufficient{},
        difference(Nat.mul(rt, pc), Nat.mul(pt, rc), Nat.mul(rc, pc)))

def operation_area(sample: Sample) -> Bool:
  match sample:
    case Stats{count, total, missing}: Nat.is_lt(0n, total)

def measured_total(sample: Sample) -> Ratio:
  match sample:
    case Stats{count, total, missing}: Fraction{total, Nat.min(1n, count)}

def visible_open(owning: Bool, state: String, settled: Bool) -> Bool:
  Bool.and(owning, Bool.and(String.eq(state, "open"), Bool.not(settled)))

type ShippingSample is Data:
  Delivery{shipped: Nat, cycles: Sample}

def record_release(sample: ShippingSample, linked: Bool, elapsed_ms: Nat) -> ShippingSample:
  match sample:
    case Delivery{shipped, +cycles}:
      Delivery{Nat.add(shipped, 1n), Bool.pick(Sample, linked, record(cycles, elapsed_ms), cycles)}

def visible_release(surface: String, published: Nat) -> Bool:
  Bool.and(String.eq(surface, "linux-main-x86_64"), Bool.not(Nat.is_eq(published, 0n)))

def interval_clock(+clock: String) -> String:
  Bool.pick(String, String.eq(clock, "ci_queue"), "CI queue",
    Bool.pick(String, String.eq(clock, "ci_execution"), "CI execution",
      Bool.pick(String, String.eq(clock, "ci_step"), "CI steps",
        Bool.pick(String, String.eq(clock, "async_cell"), "Async cells", "Tool envelopes"))))

def trace_preference(async_spans: Nat, reasoning_events: Nat) -> Bool:
  Bool.and(Bool.not(Nat.is_eq(async_spans, 0n)), Bool.not(Nat.is_eq(reasoning_events, 0n)))

def trace_preferred(+ended: Nat, mixed: Bool, +other_ended: Nat, +other_mixed: Bool) -> Bool:
  Bool.and(Bool.not(Nat.is_eq(ended, 0n)),
    Bool.pick(Bool, mixed,
      Bool.or(Bool.not(other_mixed), Nat.is_lt(other_ended, ended)),
      Bool.and(Bool.not(other_mixed), Nat.is_lt(other_ended, ended))))

def trace_label(+tool: String, +command: String) -> String:
  Bool.pick(String, String.eq(command, ""), tool, String.append(tool, String.append(" · ", command)))

def trace_operation(clock: String, tool: String, command: String, +categories: String) -> String:
  +name = Bool.pick(String, String.eq(categories, ""), trace_label(tool, command), categories)
  Bool.pick(String, String.eq(clock, "async_cell"), String.append("Async cell · ", name), name)

def trace_category_title(parts: List<&2, String>) -> String:
  match parts:
    case []: ""
    case head <> []: head
    case head <> tail: String.append(String.trim(head), String.append(" +", Nat.show(List.length(&2, String, tail))))

def trace_span_name(clock: String, tool: String, command: String, categories: String) -> String:
  trace_operation(clock, tool, command, trace_category_title(String.split(categories, '+')))

type Operation is Data:
  Category{name: String}
  MixedCommand{name: String, group: String}

def observed_parts(parts: List<&2, String>, categories: String) -> Operation:
  match parts:
    case []: Category{"Unknown"}
    case head <> []: Category{head}
    case head <> tail: MixedCommand{"Mixed", String.append("Mixed · ", categories)}

def observed_category(+categories: String) -> Operation:
  Bool.pick(Operation, String.eq(categories, ""), Category{"Unknown"},
    observed_parts(String.split(categories, '+'), categories))

type Focus is Data:
  Window{from: Nat, to: Nat}

def extend_window(window: Focus, +start: Nat, end: Nat) -> Focus:
  match window:
    case Window{+from, to}:
      Window{Bool.pick(Nat, Nat.is_eq(from, 0n), start, Nat.min(from, start)), Nat.max(to, end)}

def trace_parent(clock: String, count: Nat, start: Nat, end: Nat, parent_start: Nat, parent_end: Nat) -> Bool:
  Bool.and(String.eq(clock, "tool_envelope"), Bool.and(Nat.is_eq(count, 1n),
    Bool.and(Nat.is_le(parent_start, start), Nat.is_le(end, parent_end))))

type ActivityScan is Data:
  Scan{latest_end: Nat, open: Bool}

type ActivityStep is Data:
  Hold{}
  Advance{scan: ActivityScan}

def scan_activity(scan: ActivityScan, start: Nat, +end: Nat, until: Nat) -> ActivityStep:
  match scan:
    case Scan{latest_end, open}:
      Bool.pick(ActivityStep, Nat.is_lt(start, until),
        Advance{Scan{Nat.max(latest_end, end), Bool.or(open, Nat.is_eq(end, 0n))}}, Hold{})

def rollout_clean(malformed: Nat, orphans: Nat) -> Bool:
  Nat.is_eq(Nat.add(malformed, orphans), 0n)

def estimate_model_wait(clean: Bool, +result: Nat, at: Nat, scan: ActivityScan) -> Bool:
  match scan:
    case Scan{latest_end, open}:
      Bool.and(clean, Bool.and(Bool.not(open),
        Bool.and(Nat.is_le(latest_end, result), Bool.and(Nat.is_lt(0n, result), Nat.is_lt(result, at)))))

def ranks_before(+total: Nat, key: String, +other_total: Nat, other_key: String) -> Bool:
  Bool.or(Nat.is_lt(other_total, total),
    Bool.and(Nat.is_eq(total, other_total), String.is_lt(key, other_key)))

type DeliveryStage is Data:
  Stage{ending: U32, name: String, value: CycleStage}

def delivery_stages(+thread: Nat, +commit: Nat, +opened: Nat, +ci: Nat, +merged: Nat,
                    +dispatch: Nat, +published: Nat, linked: Bool) -> List<&2, DeliveryStage>:
  Stage{1, "Thread → commit", cycle_stage(thread, commit)} <>
    Stage{2, "Commit → PR open", cycle_stage(commit, opened)} <>
    Stage{3, "PR open → first CI", cycle_stage(opened, ci)} <>
    Stage{4, "First CI → merge", cycle_stage(ci, merged)} <>
    Stage{5, "Merge → dispatch", cycle_stage(merged, dispatch)} <>
    Stage{6, "Dispatch → ship", cycle_stage(dispatch, published)} <>
    Stage{0, "PR open → merge", cycle_stage(opened, merged)} <>
    Stage{0, "Merge → ship", cycle_stage(merged, published)} <>
    Stage{0, "Thread → ship", Bool.pick(CycleStage, linked, cycle_stage(thread, published), Missing{})} <> []

type TimingRow is Data:
  Timing{key: String, clock: String, workflow: Nat, operation: String, stats: Sample}

type TimingGroups is Data:
  Groups{operations: Map<&2, TimingRow>, workflows: Map<&2, TimingRow>,
         totals: Map<&2, TimingRow>, mixed: Map<&2, TimingRow>}

type TimingResult is Data:
  Result{operations: List<&2, TimingRow>, workflows: List<&2, TimingRow>,
         totals: List<&2, TimingRow>, mixed: List<&2, TimingRow>}

def empty_timing() -> TimingGroups:
  Groups{Map.new(&2, TimingRow), Map.new(&2, TimingRow), Map.new(&2, TimingRow), Map.new(&2, TimingRow)}

def timing_record_found(found: Map<&2, TimingRow> & TimingRow, start: Nat, end: Nat) -> Map<&2, TimingRow>:
  match found:
    case (table, Timing{+key, clock, workflow, operation, stats}):
      Map.set(&2, TimingRow, table, key, Timing{key, clock, workflow, operation, record_interval(stats, start, end)})

def timing_record(groups: Map<&2, TimingRow>, +key: String, clock: String, workflow: Nat, operation: String,
                  start: Nat, end: Nat) -> Map<&2, TimingRow>:
  timing_record_found(Map.get(TimingRow, Timing{key, clock, workflow, operation, Stats{0n, 0n, 0n}}, groups, key), start, end)

def timing_key(clock: String, workflow: Nat) -> String:
  String.append(clock, String.append(",", Nat.show(workflow)))

def timing_group_key(clock: String, operation: String) -> String:
  String.append(clock, String.append(",", operation))

def timing_mixed_choice(skip: Bool, mixed: Map<&2, TimingRow>, +clock: String, +group: String, start: Nat, end: Nat) ->
    Map<&2, TimingRow>:
  match skip:
    case True{}: mixed
    case False{}: timing_record(mixed, timing_group_key(clock, group), clock, 0n, group, start, end)

def timing_add_mixed(mixed: Map<&2, TimingRow>, +clock: String, +group: String, start: Nat, end: Nat) ->
    Map<&2, TimingRow>:
  timing_mixed_choice(String.eq(group, ""), mixed, clock, group, start, end)

def timing_add(groups: TimingGroups, +clock: String, +workflow: Nat, +name: String, group: String,
               +start: Nat, +end: Nat) -> TimingGroups:
  match groups:
    case Groups{ops, flows, totals, +mixed}:
      +prefix = timing_key(clock, workflow)
      Groups{timing_record(ops, timing_group_key(prefix, name), clock, workflow, name, start, end),
        timing_record(flows, prefix, clock, workflow, "", start, end),
        timing_record(totals, timing_group_key(clock, name), clock, 0n, name, start, end),
        timing_add_mixed(mixed, clock, group, start, end)}

def timing_observe(groups: TimingGroups, raw_clock: String, workflow: Nat, name: String, start: Nat, end: Nat) ->
    TimingGroups:
  timing_add(groups, interval_clock(raw_clock), workflow, name, "", start, end)

def timing_action_job(groups: TimingGroups, +workflow: Nat, +name: String, created: Nat, queued: Nat,
                      started: Nat, ended: Nat) -> TimingGroups:
  timing_observe(timing_observe(groups, "ci_queue", workflow, name, created, queued),
    "ci_execution", workflow, name, started, ended)

def timing_action_step(groups: TimingGroups, workflow: Nat, name: String, started: Nat, ended: Nat) -> TimingGroups:
  timing_observe(groups, "ci_step", workflow, name, started, ended)

def timing_before(left: TimingRow, right: TimingRow) -> Bool:
  match left right:
    case Timing{a, ac, aw, ao, Stats{an, x, am}} Timing{b, bc, bw, bo, Stats{bn, y, bm}}:
      ranks_before(x, a, y, b)

def sort_merge_pass(~A: Data, ~before: A -> A -> Bool, +size: Nat, runs: List<&2, List<&2, A>>,
                    output: List<&2, List<&2, A>>) -> List<&2, List<&2, A>>:
  match runs:
    case []: List.reverse(&2, List<&2, A>, output)
    case [run]: List.reverse(&2, List<&2, A>, run <> output)
    case first <> second <> tail:
      sort_merge_pass(~A, ~before, size, tail, List.merge.go(~A, ~before, size, ([], first, second)) <> output)

def sort_merge_runs(~A: Data, ~before: A -> A -> Bool, fuel: Nat, +size: Nat, runs: List<&2, List<&2, A>>) ->
    List<&2, A>:
  match fuel:
    case 0n: List.concat(&2, A, runs)
    case 1n+remaining:
      match runs:
        case []: []
        case [run]: run
        case _:
          sort_merge_runs(~A, ~before, remaining, size, sort_merge_pass(~A, ~before, size, runs, []))

def sort_runs(~A: Data, ~before: A -> A -> Bool, input: List<&2, A>, +size: Nat,
              runs: List<&2, List<&2, A>>) -> List<&2, A>:
  match input:
    case []: sort_merge_runs(~A, ~before, size, size, List.reverse(&2, List<&2, A>, runs))
    case item <> tail: sort_runs(~A, ~before, tail, Nat.add(size, 1n), [item] <> runs)

def sort_timing(~A: Data, ~before: A -> A -> Bool, input: List<&2, A>) -> List<&2, A>:
  sort_runs(~A, ~before, input, 0n, [])

def timing_rank(groups: Map<&2, TimingRow>) -> List<&2, TimingRow>:
  sort_timing(~TimingRow, ~timing_before, Map.values(&2, TimingRow, groups))

def timing_result(groups: TimingGroups) -> TimingResult:
  match groups:
    case Groups{ops, flows, totals, mixed}:
      Result{timing_rank(ops), timing_rank(flows), timing_rank(totals), timing_rank(mixed)}

type SessionTiming is Data:
  SessionTiming{envelopes: Sample, cells: Sample}

def empty_session_timing() -> SessionTiming:
  SessionTiming{Stats{0n, 0n, 0n}, Stats{0n, 0n, 0n}}

def session_timing_observe(state: SessionTiming, clock: String, +start: Nat, +end: Nat) -> SessionTiming:
  match state:
    case SessionTiming{+envelopes, +cells}:
      Bool.pick(SessionTiming, String.eq(clock, "async_cell"),
        SessionTiming{envelopes, record_interval(cells, start, end)},
        SessionTiming{record_interval(envelopes, start, end), cells})

type StageSummary is Data:
  StageSummary{name: String, stats: Sample}

type WeekSummary is Data:
  WeekSummary{week: Nat, summary: ShippingSample}

type ShippingReport is Data:
  ShippingReport{delivery: ShippingSample, weeks: Map<&2, WeekSummary>, stages: List<&2, StageSummary>, earliest: Maybe<&2, Nat>}

type ReleaseClocks is Data:
  ReleaseClocks{thread: Nat, commit: Nat, opened: Nat, ci: Nat, merged: Nat, dispatch: Nat, published: Nat, checked: Nat}

type Milestone is Data:
  Milestone{ordinal: U32, name: String, clock: Nat, elapsed: CycleStage}

type Shipment is Data:
  Unpublished{report: ShippingReport}
  Published{report: ShippingReport, milestones: List<&2, Milestone>}

type ShippingSummary is Data:
  ShippingSummary{delivery: ShippingSample, weeks: List<&2, WeekSummary>, stages: List<&2, StageSummary>,
    from: Nat, prior_week: Nat, recent_week: Nat, prior: Sample, recent: Sample, direction: Direction}

def empty_shipping_sample() -> ShippingSample:
  Delivery{0n, Stats{0n, 0n, 0n}}

def initial_stages(stages: List<&2, DeliveryStage>) -> List<&2, StageSummary>:
  match stages:
    case []: []
    case Stage{ending, name, value} <> tail:
      StageSummary{name, Stats{0n, 0n, 0n}} <> initial_stages(tail)

def empty_shipping_report() -> ShippingReport:
  ShippingReport{empty_shipping_sample(), Map.new(&2, WeekSummary),
    initial_stages(delivery_stages(0n, 0n, 0n, 0n, 0n, 0n, 0n, False{})), None{}}

def stage_summaries(summaries: List<&2, StageSummary>, stages: List<&2, DeliveryStage>) -> List<&2, StageSummary>:
  match summaries:
    case []: []
    case StageSummary{name, stats} <> tail:
      match stages:
        case []: []
        case Stage{ending, stage_name, value} <> rest:
          StageSummary{name, count_cycle_stage(stats, value)} <> stage_summaries(tail, rest)

def shipment_week_record(found: Map<&2, WeekSummary> & WeekSummary, key: String, linked: Bool, elapsed: Nat) ->
    Map<&2, WeekSummary>:
  match found:
    case (table, WeekSummary{when, sample}):
      Map.set(&2, WeekSummary, table, key, WeekSummary{when, record_release(sample, linked, elapsed)})

def shipment_week(weeks: Map<&2, WeekSummary>, +epoch: Nat, linked: Bool, elapsed: Nat) -> Map<&2, WeekSummary>:
  +key = Nat.show(epoch)
  shipment_week_record(Map.get(WeekSummary, WeekSummary{epoch, empty_shipping_sample()}, weeks, key), key, linked, elapsed)

def earlier(earliest: Maybe<&2, Nat>, epoch: Nat) -> Nat:
  match earliest:
    case None{}: epoch
    case Some{when}: Nat.min(when, epoch)

def shipment_summary(report: ShippingReport, +published: Nat, +linked: Bool, +elapsed: Nat,
                      stages: List<&2, DeliveryStage>) -> ShippingReport:
  match report:
    case ShippingReport{delivery, weeks, summaries, +earliest}:
      +epoch = week(published)
      ShippingReport{record_release(delivery, linked, elapsed), shipment_week(weeks, epoch, linked, elapsed),
        stage_summaries(summaries, stages), Some{earlier(earliest, epoch)}}

def milestone_elapsed(+ordinal: U32, stages: List<&2, DeliveryStage>) -> CycleStage:
  match stages:
    case []: Missing{}
    case Stage{ending, name, value} <> tail:
      Bool.pick(CycleStage, U32.is_eq(ordinal, ending), value, milestone_elapsed(ordinal, tail))

def release_milestones(clocks: ReleaseClocks, +stages: List<&2, DeliveryStage>) -> List<&2, Milestone>:
  match clocks:
    case ReleaseClocks{thread, commit, opened, ci, merged, dispatch, published, checked}:
      Milestone{0, "Thread started", thread, Missing{}} <>
      Milestone{1, "First commit", commit, milestone_elapsed(1, stages)} <>
      Milestone{2, "PR opened", opened, milestone_elapsed(2, stages)} <>
      Milestone{3, "First PR CI", ci, milestone_elapsed(3, stages)} <>
      Milestone{4, "PR merged", merged, milestone_elapsed(4, stages)} <>
      Milestone{5, "Release dispatch", dispatch, milestone_elapsed(5, stages)} <>
      Milestone{6, "Shipped", published, milestone_elapsed(6, stages)} <>
      Milestone{7, "Access verified", checked, Missing{}} <> []

def shipping_observe_release(report: ShippingReport, +clocks: ReleaseClocks, published: Nat,
                              +linked: Bool, elapsed: Nat) -> Shipment:
  match clocks:
    case ReleaseClocks{thread, commit, opened, ci, merged, dispatch, ship, checked}:
      +stages = delivery_stages(thread, commit, opened, ci, merged, dispatch, ship, linked)
      Published{shipment_summary(report, published, linked, elapsed, stages), release_milestones(clocks, stages)}

def shipping_choice(visible: Bool, report: ShippingReport, published: Nat,
                     clocks: ReleaseClocks, linked: Bool, elapsed: Nat) -> Shipment:
  match visible:
    case True{}: shipping_observe_release(report, clocks, published, linked, elapsed)
    case False{}: Unpublished{report}

def shipping_observe(report: ShippingReport, surface: String, +published: Nat,
                     clocks: ReleaseClocks, linked: Bool, elapsed: Nat) -> Shipment:
  shipping_choice(visible_release(surface, published), report, published, clocks, linked, elapsed)

def week_cycles(found: Map<&2, WeekSummary> & WeekSummary) -> Sample:
  match found:
    case (table, WeekSummary{when, Delivery{shipped, cycles}}): cycles

def shipping_cycles(weeks: Map<&2, WeekSummary>, +epoch: Nat) -> Sample:
  week_cycles(Map.get(WeekSummary, WeekSummary{epoch, empty_shipping_sample()}, weeks, Nat.show(epoch)))

def shipping_result(report: ShippingReport, cutoff: Nat) -> ShippingSummary:
  match report:
    case ShippingReport{delivery, +weeks, stages, +earliest}:
      +recent = previous_week(cutoff)
      +prior = previous_week(recent)
      +a = shipping_cycles(weeks, prior)
      +b = shipping_cycles(weeks, recent)
      +from = earlier(earliest, prior)
      ShippingSummary{delivery, Map.values(&2, WeekSummary, weeks), stages, from, prior, recent, a, b, direction(b, a)}

type WindowedInterval is Data:
  Outside{}
  Untimed{}
  Unplaced{}
  Clipped{start: Nat, end: Nat}

type TimingWindow is Data:
  TimingWindow{key: String, bounds: Focus}

def timing_windows(+cutoff: Nat) -> List<&2, TimingWindow>:
  [TimingWindow{"1h", Window{Nat.sub(cutoff, 3600000n), cutoff}},
   TimingWindow{"24h", Window{Nat.sub(cutoff, 86400000n), cutoff}}]

def in_window(+at: Nat, from: Nat, to: Nat) -> Bool:
  Bool.and(Nat.is_le(from, at), Nat.is_lt(at, to))

def window_interval(+window: Focus, +start: Nat, +end: Nat) -> WindowedInterval:
  match window:
    case Window{+from, +to}:
      +anchor = Bool.pick(Nat, Nat.is_eq(start, 0n), end, start)
      +begin = Nat.max(start, from)
      +finish = Nat.min(end, to)
      Bool.pick(WindowedInterval, interval_valid(start, end),
        Bool.pick(WindowedInterval, Bool.or(Nat.is_lt(begin, finish),
          Bool.and(Nat.is_eq(start, end), in_window(start, from, to))), Clipped{begin, finish}, Outside{}),
        Bool.pick(WindowedInterval, Nat.is_eq(anchor, 0n), Unplaced{},
          Bool.pick(WindowedInterval, in_window(anchor, from, to), Untimed{}, Outside{})))

type Occupancy is Data:
  Occupied{stats: Sample, union: Nat, latest_end: Nat, unplaced: Nat}

def record_occupancy(occupancy: Occupancy, interval: WindowedInterval) -> Occupancy:
  match occupancy interval:
    case Occupied{stats, union, +latest_end, unplaced} Clipped{+start, +end}:
      Occupied{record(stats, Nat.sub(end, start)),
        Nat.add(union, Nat.sub(end, Nat.max(latest_end, start))), Nat.max(latest_end, end), unplaced}
    case Occupied{stats, union, latest_end, unplaced} Untimed{}:
      Occupied{unavailable(stats), union, latest_end, unplaced}
    case Occupied{stats, union, latest_end, unplaced} Unplaced{}:
      Occupied{stats, union, latest_end, Nat.add(unplaced, 1n)}
    case Occupied{stats, union, latest_end, unplaced} Outside{}:
      Occupied{stats, union, latest_end, unplaced}

def observe_timestamp(+window: Focus, +at: Nat) -> Focus:
  Bool.pick(Focus, Nat.is_eq(at, 0n), window, extend_window(window, at, at))

def source_position(window: Focus, +latest: Nat) -> String:
  match window:
    case Window{from, to}:
      Bool.pick(String, Nat.is_eq(latest, 0n), "No observed timestamps",
        Bool.pick(String, Nat.is_lt(latest, from), "Before window",
          Bool.pick(String, Nat.is_lt(latest, to), "Ends in window", "At or after cutoff")))

def timing_clocks() -> List<&2, String>:
  ["Tool envelopes", "Async cells", "CI queue", "CI execution", "CI steps"]

type WindowRow is Data:
  WindowRow{key: String, clock: String, workflow: Nat, operation: String, occupancy: Occupancy}

type WindowGroups is Data:
  WindowGroups{clocks: Map<&2, WindowRow>, operations: Map<&2, WindowRow>, workflows: Map<&2, WindowRow>,
               totals: Map<&2, WindowRow>, mixed: Map<&2, WindowRow>, step_jobs: Map<&2, WindowRow>}

type WindowSummary is Data:
  WindowSummary{clocks: List<&2, WindowRow>, operations: List<&2, WindowRow>, workflows: List<&2, WindowRow>,
                totals: List<&2, WindowRow>, mixed: List<&2, WindowRow>, step_jobs: List<&2, WindowRow>}

def window_record_found(found: Map<&2, WindowRow> & WindowRow, interval: WindowedInterval) -> Map<&2, WindowRow>:
  match found:
    case (table, WindowRow{+key, clock, workflow, operation, occupancy}):
      Map.set(&2, WindowRow, table, key, WindowRow{key, clock, workflow, operation, record_occupancy(occupancy, interval)})

def window_record(groups: Map<&2, WindowRow>, +key: String, clock: String, workflow: Nat, operation: String,
                  interval: WindowedInterval) -> Map<&2, WindowRow>:
  window_record_found(Map.get(WindowRow, WindowRow{key, clock, workflow, operation, Occupied{Stats{0n, 0n, 0n}, 0n, 0n, 0n}},
    groups, key), interval)

def start_clock_groups(clocks: List<&2, String>, groups: Map<&2, WindowRow>) -> Map<&2, WindowRow>:
  match clocks:
    case []: groups
    case +clock <> tail: start_clock_groups(tail, window_record(groups, clock, clock, 0n, "", Outside{}))

def start_window_groups() -> WindowGroups:
  WindowGroups{start_clock_groups(timing_clocks(), Map.new(&2, WindowRow)), Map.new(&2, WindowRow),
    Map.new(&2, WindowRow), Map.new(&2, WindowRow), Map.new(&2, WindowRow), Map.new(&2, WindowRow)}

def window_mix(empty: Bool, table: Map<&2, WindowRow>, +clock: String, +group: String, interval: WindowedInterval) ->
    Map<&2, WindowRow>:
  match empty:
    case True{}: table
    case False{}: window_record(table, timing_group_key(clock, group), clock, 0n, group, interval)

def window_step_job(skip: Bool, table: Map<&2, WindowRow>, +clock: String, +workflow: Nat, +operation: String,
                    +job: String, interval: WindowedInterval) -> Map<&2, WindowRow>:
  match skip:
    case True{}: table
    case False{}:
      +prefix = timing_group_key(timing_key(clock, workflow), Nat.show(String.length(operation)))
      window_record(table, timing_group_key(prefix, String.append(operation, job)), operation, workflow, job, interval)

def window_add(groups: WindowGroups, +clock: String, +workflow: Nat, +operation: String, +group: String, +job: String,
               +interval: WindowedInterval) -> WindowGroups:
  match groups interval:
    case WindowGroups{clocks, ops, flows, totals, mixed, step_jobs} Outside{}:
      WindowGroups{clocks, ops, flows, totals, mixed, step_jobs}
    case WindowGroups{clocks, ops, flows, totals, mixed, step_jobs} Unplaced{}:
      WindowGroups{window_record(clocks, clock, clock, 0n, "", interval), ops, flows, totals, mixed, step_jobs}
    case WindowGroups{clocks, ops, flows, totals, mixed, step_jobs} _:
      +prefix = timing_key(clock, workflow)
      WindowGroups{window_record(clocks, clock, clock, 0n, "", interval),
        window_record(ops, timing_group_key(prefix, operation), clock, workflow, operation, interval),
        window_record(flows, prefix, clock, workflow, "", interval),
        window_record(totals, timing_group_key(clock, operation), clock, 0n, operation, interval),
        window_mix(String.eq(group, ""), mixed, clock, group, interval), window_step_job(String.eq(job, ""), step_jobs, clock, workflow, operation, job, interval)}

type ProcessAttribution is Data:
  ProcessAttribution{cell_status: String, wait_status: String, wait_category: String, io_status: String, io_category: String}

def confirmed_process(+status: String) -> Bool:
  Bool.or(String.eq(status, "process_running"), Bool.or(String.eq(status, "process_exited"),
    Bool.or(String.eq(status, "process_opened"), String.eq(status, "synchronous_process_exit"))))

def one_process_purpose(parts: List<&2, String>) -> String:
  match parts:
    case name <> []: name
    case _: ""

def string_in(+value: String, allowed: List<&2, String>) -> Bool:
  match allowed:
    case []: False{}
    case head <> rest: Bool.or(String.eq(value, head), string_in(value, rest))

def process_purpose(+category: String) -> String:
  watcher = string_in(category, ["Exact GitHub watcher request", "GitHub watcher with incomplete identity"])
  unresolved = string_in(category, ["Unknown", "Unknown tool", "Unknown script", "Unknown command", "Cell wait", "Process I/O"])
  Bool.pick(String, watcher, "GitHub Actions",
    Bool.pick(String, unresolved, "", one_process_purpose(String.split(category, '+'))))

def process_label(+purpose: String, waiting: Bool) -> String:
  match waiting:
    case True{}:
      Bool.pick(String, String.eq(purpose, ""), "Waiting for an unidentified task", String.append("Waiting for ", purpose))
    case False{}:
      Bool.pick(String, String.eq(purpose, ""), "Unidentified process", String.append(purpose, " · process I/O"))

def timing_process_label(confirmed: Bool, category: String, waiting: Bool) -> String:
  process_label(Bool.pick(String, confirmed, process_purpose(category), ""), waiting)

def timing_codex_operation(+category: String, attribution: ProcessAttribution) -> String:
  match category attribution:
    case "Cell wait" ProcessAttribution{cell, wait_state, purpose, io_state, io_purpose}:
      timing_process_label(Bool.and(String.eq(cell, "linked_cell"), confirmed_process(wait_state)), purpose, True{})
    case "Process I/O" ProcessAttribution{cell, wait_state, purpose, io_state, io_purpose}:
      timing_process_label(confirmed_process(io_state), io_purpose, False{})
    case _ _: category

def window_add_category(groups: WindowGroups, clock: String, category: Operation, interval: WindowedInterval) -> WindowGroups:
  match category:
    case Category{name}: window_add(groups, clock, 0n, name, "", "", interval)
    case MixedCommand{name, group}: window_add(groups, clock, 0n, name, group, "", interval)

def window_observe(groups: WindowGroups, bounds: Focus, clock: String, workflow: Nat, operation: String,
                   start: Nat, end: Nat, codex: Bool, job: String) -> WindowGroups:
  match codex:
    case True{}: window_add_category(groups, interval_clock(clock), observed_category(operation), window_interval(bounds, start, end))
    case False{}: window_add(groups, interval_clock(clock), workflow, operation, "", job, window_interval(bounds, start, end))

def window_before(left: WindowRow, right: WindowRow) -> Bool:
  match left right:
    case WindowRow{a, ac, aw, ao, Occupied{Stats{an, x, am}, au, ae, ap}}
         WindowRow{b, bc, bw, bo, Occupied{Stats{bn, y, bm}, bu, be, bp}}:
      ranks_before(x, a, y, b)

def rank_window_rows(table: Map<&2, WindowRow>) -> List<&2, WindowRow>:
  sort_timing(~WindowRow, ~window_before, Map.values(&2, WindowRow, table))

def summarize_window(groups: WindowGroups) -> WindowSummary:
  match groups:
    case WindowGroups{clocks, ops, flows, totals, mixed, step_jobs}:
      WindowSummary{rank_window_rows(clocks), rank_window_rows(ops), rank_window_rows(flows),
        rank_window_rows(totals), rank_window_rows(mixed), rank_window_rows(step_jobs)}

type TimingSelector is Data:
  Selector{workflow: String, operation: String}

def window_has_mixed(groups: List<&2, WindowRow>, +clock: String) -> Bool:
  match groups:
    case []: False{}
    case WindowRow{key, label, workflow, operation, occupancy} <> tail:
      Bool.or(String.eq(label, clock), window_has_mixed(tail, clock))

def operation_selectors(+workflow: String, +operation: String, exact: Bool) -> List<&2, TimingSelector>:
  +all : List<&2, TimingSelector> = [Selector{workflow, "*"}, Selector{workflow, "All operations"}]
  reserved = Bool.or(String.eq(operation, "*"), String.eq(operation, "All operations"))
  Bool.pick(List<&2, TimingSelector>, Bool.and(exact, Bool.not(reserved)), Selector{workflow, operation} <> all, all)

def window_operation_selectors(row: WindowRow, groups: List<&2, WindowRow>, total: Bool) -> List<&2, TimingSelector>:
  match row:
    case WindowRow{key, clock, workflow, +operation, occupancy}:
      operation_selectors(Bool.pick(String, total, "*", Nat.show(workflow)), operation,
        Bool.not(Bool.and(String.eq(operation, "Mixed"), window_has_mixed(groups, clock))))

def window_mixed_selectors(row: WindowRow) -> List<&2, TimingSelector>:
  match row:
    case WindowRow{key, clock, workflow, +operation, occupancy}:
      [Selector{"*", "Mixed"}, Selector{"0", "Mixed"}, Selector{"*", operation}, Selector{"0", operation}]

type TimingSpan is Data:
  TimingSpan{clock: String, workflow: Nat, operation: String, start: Nat, end: Nat, codex: Bool, job: String}

type WindowReport is Data:
  WindowReport{key: String, bounds: Focus, summary: WindowSummary}

def empty_window_spans() -> List<&2, TimingSpan>:
  []

def window_action_job(spans: List<&2, TimingSpan>, +workflow: Nat, +name: String, created: Nat, queued: Nat,
                      started: Nat, ended: Nat) -> List<&2, TimingSpan>:
  TimingSpan{"ci_execution", workflow, name, started, ended, False{}, ""} <>
    TimingSpan{"ci_queue", workflow, name, created, queued, False{}, ""} <> spans

def window_action_step(spans: List<&2, TimingSpan>, workflow: Nat, name: String, +job: String, started: Nat, ended: Nat) ->
    List<&2, TimingSpan>:
  TimingSpan{"ci_step", workflow, name, started, ended, False{}, Bool.pick(String, String.eq(job, ""), "Unidentified job", job)} <> spans

def window_codex_span(spans: List<&2, TimingSpan>, clock: String, categories: String, attribution: ProcessAttribution, start: Nat, end: Nat) ->
    List<&2, TimingSpan>:
  TimingSpan{clock, 0n, timing_codex_operation(categories, attribution), start, end, True{}, ""} <> spans

def window_span_before(left: TimingSpan, right: TimingSpan) -> Bool:
  match left right:
    case TimingSpan{a, b, c, start, d, e, k} TimingSpan{f, g, h, other_start, i, j, l}:
      Nat.is_lt(start, other_start)

def window_group_spans(spans: List<&2, TimingSpan>, +bounds: Focus, state: WindowGroups) -> WindowSummary:
  match spans:
    case []: summarize_window(state)
    case TimingSpan{clock, workflow, operation, start, end, codex, job} <> tail:
      window_group_spans(tail, bounds, window_observe(state, bounds, clock, workflow, operation, start, end, codex, job))

def window_reports_for(windows: List<&2, TimingWindow>, +spans: List<&2, TimingSpan>) -> List<&2, WindowReport>:
  match windows:
    case []: []
    case TimingWindow{key, +bounds} <> tail:
      WindowReport{key, bounds, window_group_spans(spans, bounds, start_window_groups())} <> window_reports_for(tail, spans)

def window_reports(spans: List<&2, TimingSpan>, cutoff: Nat) -> List<&2, WindowReport>:
  window_reports_for(timing_windows(cutoff), sort_timing(~TimingSpan, ~window_span_before, spans))

def measured_union(occupancy: Occupancy) -> Ratio:
  match occupancy:
    case Occupied{Stats{count, total, missing}, union, latest_end, unplaced}:
      Fraction{union, Nat.min(1n, count)}

def repository_name(value: String) -> String:
  Repository.normalized(value)
