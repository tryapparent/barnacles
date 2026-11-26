import Base

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

def timing_codex_category(groups: TimingGroups, raw_clock: String, category: Operation, start: Nat, end: Nat) -> TimingGroups:
  match category:
    case Category{name}: timing_observe(groups, raw_clock, 0n, name, start, end)
    case MixedCommand{name, group}: timing_add(groups, interval_clock(raw_clock), 0n, name, group, start, end)

def timing_codex(groups: TimingGroups, raw_clock: String, categories: String, start: Nat, end: Nat) -> TimingGroups:
  timing_codex_category(groups, raw_clock, observed_category(categories), start, end)

def timing_before(left: TimingRow, right: TimingRow) -> Bool:
  match left right:
    case Timing{a, ac, aw, ao, Stats{an, x, am}} Timing{b, bc, bw, bo, Stats{bn, y, bm}}:
      ranks_before(x, a, y, b)

def timing_rank(groups: Map<&2, TimingRow>) -> List<&2, TimingRow>:
  List.sort(~TimingRow, ~timing_before, Map.values(&2, TimingRow, groups))

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

type TimingSelector is Data:
  Selector{workflow: String, operation: String, kind: U32}

def clock_has_mixed(groups: List<&2, TimingRow>, +clock: String) -> Bool:
  match groups:
    case []: False{}
    case Timing{key, label, workflow, operation, stats} <> tail:
      Bool.or(String.eq(label, clock), clock_has_mixed(tail, clock))

def show_timing(visible: Bool, +workflow: String, +operation: String) -> List<&2, TimingSelector>:
  match visible:
    case False{}: []
    case True{}:
      +all : List<&2, TimingSelector> = Selector{"*", "*", 0} <> Selector{workflow, "*", 0} <> []
      Bool.pick(List<&2, TimingSelector>, String.eq(operation, "*"), all,
        Selector{"*", operation, 0} <> Selector{workflow, operation, 0} <> all)

def timing_visible(mixed: Bool, groups: List<&2, TimingRow>, clock: String) -> Bool:
  match mixed:
    case False{}: True{}
    case True{}: Bool.not(clock_has_mixed(groups, clock))

def timing_selectors(row: TimingRow, groups: List<&2, TimingRow>) -> List<&2, TimingSelector>:
  match row:
    case Timing{key, clock, workflow, +operation, stats}:
      show_timing(timing_visible(String.eq(operation, "Mixed"), groups, clock),
        Nat.show(workflow), operation)

def mixed_selectors(row: TimingRow) -> List<&2, TimingSelector>:
  match row:
    case Timing{key, clock, workflow, +operation, stats}:
      Selector{"*", "Mixed", 1} <> Selector{"0", "Mixed", 1} <>
      Selector{"*", operation, 1} <> Selector{"0", operation, 1} <> []
