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

def count_in_map(clock: String) -> Bool:
  Bool.not(String.eq(clock, "CI steps"))

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

def codex_clock(clock: String) -> String:
  Bool.pick(String, String.eq(clock, "async_cell"), "Async cells", "Tool envelopes")

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

def observed_parts(parts: List<&2, String>) -> String:
  match parts:
    case []: "Unknown"
    case head <> []: head
    case head <> tail: "Mixed"

def observed_category(+categories: String) -> String:
  Bool.pick(String, String.eq(categories, ""), "Unknown", observed_parts(String.split(categories, '+')))

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
