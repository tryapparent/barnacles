import Base

def ordered(+start: U32, end: U32) -> Bool:
  Bool.and(U32.is_ne(start, 0), U32.is_le(start, end))

def interval_ms(+start_s: U32, start_ms: U32, +end_s: U32, end_ms: U32) -> Bool:
  Bool.and(ordered(start_s, end_s),
    Bool.or(U32.is_lt(start_s, end_s), U32.is_le(start_ms, end_ms)))

def origin(created_by: String, +source: String) -> String:
  Bool.pick(String, Bool.and(String.eq(created_by, "user"),
    Bool.or(String.eq(source, "web"), String.eq(source, "mobile"))), "manual_t3", "unknown")

def owns_pr(+source: String) -> Bool:
  Bool.or(String.eq(source, "created"), String.eq(source, "agent"))

def label(+value: String, allowed: List<&2, String>) -> String:
  match allowed:
    case []: "unknown"
    case candidate <> rest:
      Bool.pick(String, String.eq(value, candidate), value, label(value, rest))

def thread_status(value: String) -> String:
  label(value, "idle" <> "preparing" <> "queued" <> "starting" <> "running" <> "waiting" <> "completed"
    <> "interrupted" <> "failed" <> "cancelled" <> "rolled_back" <> [])

def link_source(value: String) -> String:
  label(value, "created" <> "agent" <> "manual" <> "stack" <> "stack-dismissed" <> [])

def link_state(value: String) -> String:
  label(value, "open" <> "closed" <> "merged" <> [])

def same_revision(merge_sha: String, release_sha: String) -> Bool:
  String.eq(merge_sha, release_sha)

def proves_ancestry(base: String, merge_base: String, +expected: String, status: String) -> Bool:
  Bool.and(String.eq(status, "ahead"), Bool.and(String.eq(base, expected), String.eq(merge_base, expected)))

def asset_access(http_status: U32, bytes: U32, range_matches: Bool) -> Bool:
  Bool.and(range_matches, Bool.and(U32.is_eq(http_status, 206), U32.is_eq(bytes, 1)))

def shipping(merged: U32, +published: U32, checked: U32, ancestry: Bool, access: Bool) -> Bool:
  Bool.and(ancestry, Bool.and(access, Bool.and(ordered(merged, published), ordered(published, checked))))

type Elapsed is Data:
  Duration{seconds: U32, subtract_ms: U32}
  Unknown{}

def elapsed(known: Bool, started: U32, offset_ms: U32, ended: U32) -> Elapsed:
  match known:
    case True{}: Duration{U32.sub(ended, started), offset_ms}
    case False{}: Unknown{}

def pr_to_release(+opened: U32, +published: U32) -> Elapsed:
  elapsed(ordered(opened, published), opened, 0, published)

def thread_to_release(owner_count: U32, +started: U32, +offset_ms: U32, +opened: U32, +published: U32) -> Elapsed:
  elapsed(Bool.and(U32.is_eq(owner_count, 1),
    Bool.and(interval_ms(started, offset_ms, opened, 0), ordered(opened, published))),
    started, offset_ms, published)

def tool_label(+name: String) -> String:
  Bool.pick(String, String.eq(name, "wait"), "cell wait",
    Bool.pick(String, String.eq(name, "exec"), "tool wrapper",
      Bool.pick(String, String.eq(name, "exec_command"), "command",
        Bool.pick(String, String.eq(name, "write_stdin"), "process wait", "other tool"))))

def merged_at(opened: U32, +merged: U32, confirmed: Bool) -> U32:
  Bool.pick(U32, Bool.and(confirmed, ordered(opened, merged)), merged, 0)

def linux_main_source(+tag: String) -> String:
  Bool.pick(String, String.starts_with(tag, "linux-main-v2-"), String.drop(tag, 14n), "")

def linux_main_asset(state: String, name: String) -> Bool:
  Bool.and(String.eq(state, "uploaded"), String.ends_with(name, "-linux-x86_64.AppImage"))

def may_probe(asset_count: U32, published: U32, public_release: Bool, tag_matches: Bool) -> Bool:
  Bool.and(U32.is_eq(asset_count, 1), Bool.and(U32.is_ne(published, 0),
    Bool.and(public_release, tag_matches)))

type Point is Data:
  Time{s: U32, ms: U32}

def time_order(first: Point, last: Point) -> Bool:
  match first last:
    case Time{a, am} Time{b, bm}: interval_ms(a, am, b, bm)

def has_time(point: Point) -> Bool:
  match point:
    case Time{s, ms}: U32.is_ne(s, 0)

type CallState is Data:
  Unseen{orphans: U32}
  Seen{orphans: U32, line: U32, tool: String, start: Point, finish: Point, target: String, cell: String, terminal: Bool, ambiguous: Bool}

def start_call(state: CallState, line: U32, name: String, start: Point, target: String) -> CallState:
  match state:
    case Unseen{orphans}:
      Seen{orphans, line, tool_label(name), start, Time{0, 0}, target, "", False{}, False{}}
    case Seen{orphans, old_line, tool, old_start, finish, old_target, cell, terminal, ambiguous}:
      Seen{orphans, old_line, tool, old_start, finish, old_target, cell, terminal, True{}}

def finish_seen(+accept: Bool, orphans: U32, line: U32, +tool: String, start: Point, finish: Point,
  target: String, cell: String, terminal: Bool, ambiguous: Bool, ended: Point,
  yielded: String, completed: Bool) -> CallState:
  Seen{orphans, line, tool, start, Bool.pick(Point, accept, ended, finish), target,
    Bool.pick(String, Bool.and(accept, String.eq(tool, "tool wrapper")), yielded, cell),
    Bool.or(terminal, Bool.and(accept, Bool.and(String.eq(tool, "cell wait"), completed))),
    Bool.or(ambiguous, Bool.not(accept))}

def finish_call(state: CallState, +ended: Point, yielded: String, completed: Bool) -> CallState:
  match state:
    case Unseen{orphans}: Unseen{U32.inc(orphans)}
    case Seen{orphans, line, tool, +start, +finish, target, cell, terminal, ambiguous}:
      finish_seen(Bool.and(Bool.not(has_time(finish)), time_order(start, ended)), orphans, line,
        tool, start, finish, target, cell, terminal, ambiguous, ended, yielded, completed)

type CellFact is Data:
  NoCell{}
  Launch{key: String, owner: String, yielded_at: Point, valid: Bool}
  Terminal{key: String, call_id: String, started_at: Point, ended_at: Point, valid: Bool}

def pick_cell(+id: String, +cell: String, +target: String, +finish: Point, start: Point, +valid: Bool, terminal: Bool) -> CellFact:
  Bool.pick(CellFact, String.eq(cell, ""), Bool.pick(CellFact, Bool.and(terminal, Bool.not(String.eq(target, ""))),
    Terminal{target, id, start, finish, valid}, NoCell{}), Launch{cell, id, finish, valid})

def cell_fact(id: String, state: CallState) -> CellFact:
  match state:
    case Unseen{orphans}: NoCell{}
    case Seen{orphans, line, tool, start, finish, target, cell, terminal, ambiguous}:
      pick_cell(id, cell, target, finish, start, Bool.not(ambiguous), terminal)

type CellPair is Data:
  Pair{launch: CellFact, terminal: CellFact, duplicate: Bool}

def add_cell_fact(pair: CellPair, +fact: CellFact) -> CellPair:
  match pair fact:
    case Pair{NoCell{}, terminal, duplicate} Launch{key, owner, yielded_at, valid}:
      Pair{Launch{key, owner, yielded_at, valid}, terminal, duplicate}
    case Pair{launch, NoCell{}, duplicate} Terminal{key, call_id, started_at, ended_at, valid}:
      Pair{launch, Terminal{key, call_id, started_at, ended_at, valid}, duplicate}
    case Pair{launch, terminal, duplicate} _:
      Pair{launch, terminal, True{}}

type CellLink is Data:
  Unlinked{}
  Linked{owner: String, call_id: String, end: Point}

def cell_link(pair: CellPair, malformed: U32) -> CellLink:
  match pair:
    case Pair{Launch{key, owner, yielded_at, launch_valid}, Terminal{target, call_id, started_at, ended_at, end_valid}, False{}}:
      Bool.pick(CellLink, Bool.and(U32.is_eq(malformed, 0), Bool.and(launch_valid, Bool.and(end_valid, time_order(yielded_at, started_at)))),
        Linked{owner, call_id, ended_at}, Unlinked{})
    case _: Unlinked{}

type CallRecord is Data:
  Ignored{orphans: U32}
  Observed{orphans: U32, line: U32, tool: String, start: Point, finish: Point, launched: Bool, ambiguous: Bool}

def call_record(state: CallState) -> CallRecord:
  match state:
    case Unseen{orphans}: Ignored{orphans}
    case Seen{orphans, line, tool, start, finish, target, cell, terminal, +ambiguous}:
      Observed{orphans, line, tool, start, Bool.pick(Point, ambiguous, Time{0, 0}, finish),
        Bool.not(String.eq(cell, "")), ambiguous}

type Milestone is Data:
  Milestone{id: String, at: U32}

def earlier_milestone(+best: Milestone, +next: Milestone, best_at: U32, next_at: U32, unset: Bool) -> Milestone:
  Bool.pick(Milestone, Bool.or(unset, U32.is_lt(next_at, best_at)), next, best)

def pick_milestone(+best: Milestone, +next: Milestone) -> Milestone:
  match best next:
    case Milestone{+a, +best_at} Milestone{b, +next_at}:
      earlier_milestone(Milestone{a, best_at}, Milestone{b, next_at}, best_at, next_at, String.eq(a, ""))

def pick_review(+best: Milestone, +next: Milestone, opened: U32) -> Milestone:
  match next:
    case Milestone{id, +at}:
      Bool.pick(Milestone, ordered(opened, at), pick_milestone(best, next), best)

def commit_complete(expected: U32, observed: U32) -> Bool:
  U32.is_eq(expected, observed)

def keep_commit(complete: Bool, milestone: Milestone) -> Bool:
  match milestone:
    case Milestone{id, at}: Bool.and(complete, Bool.and(U32.is_ne(at, 0), Bool.not(String.eq(id, ""))))

type ReleaseOrder is Data:
  Release{published: U32, checked: U32, id: String, index: U32}

def release_before(a: ReleaseOrder, b: ReleaseOrder) -> Bool:
  match a b:
    case Release{+ap, +ac, aid, ai} Release{+bp, +bc, bid, bi}:
      Bool.and(U32.is_ne(ap, 0), Bool.or(U32.is_eq(bi, 0),
        Bool.or(U32.is_lt(ap, bp), Bool.and(U32.is_eq(ap, bp),
          Bool.or(U32.is_lt(ac, bc), Bool.and(U32.is_eq(ac, bc), String.is_lt(aid, bid)))))))

def pick_release(+best: ReleaseOrder, +next: ReleaseOrder, eligible: Bool) -> ReleaseOrder:
  Bool.pick(ReleaseOrder, Bool.and(eligible, release_before(next, best)), next, best)

def release_eligible(shipped: Bool, proof_merge: String, current_merge: String) -> Bool:
  Bool.and(shipped, String.eq(proof_merge, current_merge))

type Owners is Data:
  Owners{count: U32, s: U32, ms: U32}

def count_owner(state: Owners, owning: Bool, s: U32, ms: U32) -> Owners:
  match state owning:
    case Owners{0, previous_s, previous_ms} True{}: Owners{1, s, ms}
    case Owners{count, previous_s, previous_ms} True{}: Owners{U32.inc(count), 0, 0}
    case _ False{}: state
