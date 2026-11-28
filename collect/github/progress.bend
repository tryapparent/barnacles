import Base
import ./evidence.bend as Evidence

def ms(seconds: U32) -> Nat:
  Nat.mul(U32.to_nat(seconds), 1000n)

def minus(+a: U32, +b: U32) -> U32:
  U32.sub(a, U32.min(a, b))

def ready(now: U32, due: U32) -> Bool:
  U32.is_ge(now, due)

def new_upper(now: U32) -> U32:
  minus(now, 15)

def live_floor(floor: U32, +watermark: U32, +upper: U32, lookback: U32) -> U32:
  U32.max(floor, U32.min(minus(upper, lookback),
    Bool.pick(U32, U32.is_eq(watermark, 0), minus(upper, 86400), minus(watermark, 120))))

def end_live(+old: U32, upper: U32, gap: String) -> U32:
  Bool.pick(U32, String.is_empty(gap), U32.max(old, upper), old)

type Bounds is Data:
  Window{lo: U32, hi: U32}

def window(floor: U32, +hi: U32) -> Bounds:
  Window{U32.max(floor, minus(hi, 604799)), hi}

def older(floor: U32, lo: U32) -> Bounds:
  window(floor, minus(lo, 1))

def split(+lo: U32, +hi: U32) -> U32:
  U32.sub(hi, U32.div(U32.sub(hi, lo), 2))

type Page is Data:
  Invalid{}
  More{}
  Exhausted{}
  Split{}
  Capped{}

def page_size(+total: U32, page: U32, size: U32) -> Bool:
  +offset = U32.mul(minus(page, 1), 100)
  Bool.and(U32.is_le(offset, total), U32.is_eq(size, U32.min(100, minus(total, offset))))

def count_page(+total: U32, prior: U32, +page: U32, +size: U32, +next: Bool) -> Page:
  +has_more = U32.is_lt(U32.add(U32.mul(minus(page, 1), 100), size), total)
  valid = Bool.and(page_size(total, page, size), Bool.and(Bool.or(U32.is_eq(page, 1), U32.is_eq(prior, total)),
    Bool.or(Bool.and(has_more, next), Bool.not(Bool.or(has_more, next)))))
  Bool.pick(Page, valid, Bool.pick(Page, has_more, More{}, Exhausted{}), Invalid{})

def run_page(+total: U32, prior: U32, page: U32, size: U32, next: Bool, lo: U32, hi: U32) -> Page:
  Bool.pick(Page, U32.is_ge(total, 1000), Bool.pick(Page, U32.is_lt(lo, hi), Split{}, Capped{}),
    count_page(total, prior, page, size, next))

def job_limit(page: Page, number: U32) -> Page:
  match page:
    case More{}: Bool.pick(Page, U32.is_ge(number, 10), Capped{}, More{})
    case _: page

def job_page(total: U32, prior: U32, +page: U32, size: U32, next: Bool) -> Page:
  job_limit(count_page(total, prior, page, size, next), page)

def id_step(found: Map<&2, Bool> & Bool, id: String) -> Maybe<&2, Map<&2, Bool>>:
  match found:
    case (seen, False{}): Some{Map.set(&2, Bool, seen, id, True{})}
    case (_, True{}): None{}

def unique_ids(ids: List<&2, String>, seen: Maybe<&2, Map<&2, Bool>>) -> Bool:
  match ids seen:
    case [] Some{_}: True{}
    case +id <> rest Some{table}: unique_ids(rest, id_step(Map.has(&2, Bool, table, id), id))
    case _ None{}: False{}

def unique(ids: List<&2, String>) -> Bool:
  unique_ids(ids, Some{Map.new(&2, Bool)})

def pull_page(+page: U32, +history: Bool, next: Bool, last_updated: U32, lo: U32) -> Page:
  done = Bool.pick(Bool, history, U32.is_eq(page, 1), Bool.or(Bool.not(next), U32.is_lt(last_updated, lo)))
  Bool.pick(Page, done, Exhausted{}, Bool.pick(Page, Bool.and(Bool.not(history), U32.is_ge(page, 1000)), Capped{}, More{}))

def in_live(+updated: U32, lo: U32, hi: U32) -> Bool:
  Bool.and(U32.is_ge(updated, lo), U32.is_le(updated, hi))

def pull_next(history: Bool, +page: U32) -> U32:
  Bool.pick(U32, history, minus(page, 1), U32.inc(page))

def next_attempt(attempt: U32) -> U32:
  minus(attempt, 1)

def retain(terminal: Bool, jobs_complete: Bool, observed: Bool) -> Bool:
  Bool.not(Bool.and(observed, Bool.and(terminal, jobs_complete)))

def exhausted(lo: U32, floor: U32) -> Bool:
  U32.is_le(lo, floor)

def resume_at(now: U32, failure_count: U32, hint: U32) -> U32:
  delay = U32.min(3600, U32.pow(2, U32.to_nat(U32.min(12, U32.add(failure_count, 4)))))
  U32.max(hint, U32.add(now, delay))

def active_at(now: U32) -> U32:
  U32.add(now, 60)

def sweep_at(now: U32) -> U32:
  U32.add(now, 21600)

def live_at(now: U32) -> U32:
  U32.add(now, 60)

def reason(+status: U32, limited: Bool) -> String:
  Bool.pick(String, limited, "rate_limited",
    Bool.pick(String, Bool.or(U32.is_eq(status, 404), U32.is_eq(status, 410)), "unavailable",
      Bool.pick(String, Bool.or(U32.is_eq(status, 401), U32.is_eq(status, 403)), "access_denied",
        Bool.pick(String, U32.is_eq(status, 422), "unsupported", "transient"))))

def actionable(+gap: String) -> Bool:
  Bool.or(String.eq(gap, "rate_limited"), Bool.or(String.eq(gap, "transient"), String.eq(gap, "inventory_changed")))

def outcome(+blocked: String, gap: String, active: Bool, +done: Bool, history: Bool) -> String:
  Bool.pick(String, Bool.not(String.is_empty(blocked)), Bool.pick(String, actionable(blocked), "retrying", "blocked"),
    Bool.pick(String, active, "working",
      Bool.pick(String, Bool.and(done, Bool.not(String.is_empty(gap))), "blocked",
        Bool.pick(String, Bool.and(history, done), "complete", "idle"))))

def availability(gap: String) -> String:
  match gap:
    case "": "available"
    case "retention_unknown": "unknown"
    case "unavailable": "unavailable"
    case "access_denied": "unavailable"
    case "unsupported": "unavailable"
    case _: "partial"

def coverage(repo: String, +lane: String, status: String, +gap: String, lo: U32, +hi: U32,
    remaining: U32, +page: U32, pending: U32, run: String, +attempt: U32) -> Evidence.Projection:
  key = String.append(lane, String.append(":", String.append(Nat.show(U32.to_nat(hi)), String.append(":", Nat.show(U32.to_nat(page))))))
  Evidence.projection("github_coverage", repo, key, ms(hi), [
    Evidence.string("lane", lane), Evidence.string("status", status), Evidence.optional("gapCode", gap),
    Evidence.string("availability", availability(gap)),
    Evidence.clock("windowStartMs", ms(lo)), Evidence.clock("windowEndMs", ms(hi)),
    Evidence.clock("remainingThroughMs", ms(remaining)), Evidence.clock("page", U32.to_nat(page)),
    Evidence.number("pendingAttempts", U32.to_nat(pending)), Evidence.optional("runId", run),
    Evidence.optional("attempt", Evidence.choose(U32.is_gt(attempt, 0), Nat.show(U32.to_nat(attempt))))])

def health(scope: String, history: Bool, status: String, gap: String, observed: Nat,
    success: U32, newest: U32, oldest: U32) -> String:
  Evidence.render([
    Evidence.clock("observedMs", observed), Evidence.string("kind", "collector_health"), Evidence.number("schemaVersion", 1n),
    Evidence.string("collector", "github"), Evidence.string("scope", scope),
    Evidence.string("lane", Bool.pick(String, history, "backfill", "live")), Evidence.string("status", status),
    Evidence.optional("gapCode", gap),
    Evidence.clock("lastSuccessMs", ms(success)), Evidence.clock("newestSourceMs", ms(newest)),
    Evidence.clock("oldestScannedMs", ms(oldest)), Evidence.clock("scannedUnits", 0n),
    Evidence.clock("eligibleUnits", 0n), Evidence.clock("ingestedRecords", 0n)])


def clock_min(+old: U32, +value: U32) -> U32:
  Bool.pick(U32, U32.is_eq(value, 0), old, Bool.pick(U32, U32.is_eq(old, 0), value, U32.min(old, value)))

def clock_max(old: U32, value: U32) -> U32:
  U32.max(old, value)

def job_first(+old: Nat, +value: Nat) -> Nat:
  Bool.pick(Nat, Nat.is_eq(value, 0n), old, Bool.pick(Nat, Nat.is_eq(old, 0n), value, Nat.min(old, value)))

def job_last(old: Nat, value: Nat) -> Nat:
  Nat.max(old, value)
