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

type Focus is Data:
  Window{from: Nat, to: Nat}

def focus(+window: Focus, clock: String, +start: Nat, +end: Nat) -> Focus:
  match window:
    case Window{+from, to}:
      Bool.pick(Focus, Bool.and(Nat.is_eq(from, 0n),
        Bool.and(String.eq(clock, "async_cell"), interval_valid(start, end))),
        Window{start, end}, Window{from, to})


def ranks_before(+total: Nat, key: String, +other_total: Nat, other_key: String) -> Bool:
  Bool.or(Nat.is_lt(other_total, total),
    Bool.and(Nat.is_eq(total, other_total), String.is_lt(key, other_key)))
