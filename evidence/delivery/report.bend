import Base

type Provenance is Data:
  Observation{}
  Legacy{checks: List<&2, U32>}

type Proof is Data:
  Proof{channel: String, index: U32, shipped: Bool, merge: String, published: U32, checked: U32,
    asset: String, release_asset: String, release_id: String, source: String,
    dispatch: U32, provenance: Provenance}

type Choice is Data:
  Unproved{}
  Release{index: U32, published: U32, checked: U32, key: String, dispatch: U32}

type Groups is Data:
  NoGroups{}
  Channel{name: String, choice: Choice, rest: Groups}

type Owners is Data:
  Owners{count: U32, s: U32, ms: U32}

type Elapsed is Data:
  Duration{seconds: U32, subtract_ms: U32}
  Unknown{}

type ReportRow is Data:
  ReportRow{index: U32, pr: Elapsed, thread: Elapsed}

def empty_groups() -> Groups:
  NoGroups{}

def empty_owners() -> Owners:
  Owners{0, 0, 0}

def observe_owner(state: Owners, owning: Bool, s: U32, ms: U32) -> Owners:
  match state owning:
    case Owners{0, previous_s, previous_ms} True{}: Owners{1, s, ms}
    case Owners{count, previous_s, previous_ms} True{}: Owners{U32.inc(count), 0, 0}
    case _ False{}: state

def ordered(+start: U32, end: U32) -> Bool:
  Bool.and(U32.is_ne(start, 0), U32.is_le(start, end))

def unique_observation(provenance: Provenance) -> Bool:
  match provenance:
    case Observation{}: True{}
    case Legacy{checks}:
      match checks:
        case _ <> []: True{}
        case _: False{}

def release_key(+id: String, source: String, asset: String) -> String:
  padded = String.append(String.repeat("0", Nat.sub(16n, String.length(id))), id)
  String.append(padded, String.append(":", String.append(source, String.append(":", asset))))

def choice_for(proved: Bool, index: U32, published: U32, checked: U32, dispatch: U32,
  release_id: String, source: String, key_asset: String) -> Choice:
  match proved:
    case True{}:
      Release{index, published, checked, release_key(release_id, source, key_asset), dispatch}
    case False{}:
      Unproved{}

def prefer(+prior: Choice, +candidate: Choice) -> Choice:
  match prior candidate:
    case Unproved{} _: candidate
    case _ Unproved{}: prior
    case Release{pi, +pp, +pc, +pk, +pd} Release{ci, +cp, +cc, +ck, +cd}:
      preferred_dispatch = Bool.and(U32.is_ne(cd, 0), Bool.or(U32.is_eq(pd, 0), U32.is_lt(cd, pd)))
      earlier = Bool.or(U32.is_lt(cp, pp), Bool.and(U32.is_eq(cp, pp),
        Bool.or(U32.is_lt(cc, pc), Bool.and(U32.is_eq(cc, pc),
          Bool.or(String.is_lt(ck, pk), Bool.and(String.eq(ck, pk), preferred_dispatch))))))
      Bool.pick(Choice, earlier, candidate, prior)

def record(groups: Groups, +channel: String, +candidate: Choice) -> Groups:
  match groups:
    case NoGroups{}: Channel{channel, candidate, NoGroups{}}
    case Channel{+name, +prior, +rest}:
      Bool.pick(Unit -> Groups, String.eq(channel, name),
        _ => Channel{name, prefer(prior, candidate), rest},
        _ => Channel{name, prior, record(rest, channel, candidate)})(Unit{})

def observe_release(groups: Groups, current_merge: String, proof: Proof) -> Groups:
  match proof:
    case Proof{channel, index, shipped, merge, +published, +checked, +asset, release_asset, release_id,
      source, dispatch, provenance}:
      eligible = Bool.and(shipped, Bool.and(String.eq(merge, current_merge),
        Bool.and(ordered(published, checked), Bool.and(unique_observation(provenance),
          Bool.and(Bool.not(String.eq(asset, "0")), String.eq(asset, release_asset))))))
      record(groups, channel, choice_for(eligible, index, published, checked, dispatch, release_id, source, asset))

def elapsed(known: Bool, start: U32, offset: U32, end: U32) -> Elapsed:
  match known:
    case True{}: Duration{U32.sub(end, start), offset}
    case False{}: Unknown{}

def report_row(index: U32, +opened: U32, +published: U32, owners: Owners) -> ReportRow:
  match owners:
    case Owners{count, +s, +ms}:
      +ordered_pr = ordered(opened, published)
      thread_started = Bool.and(U32.is_ne(s, 0),
        Bool.or(U32.is_lt(s, opened), Bool.and(U32.is_eq(s, opened), U32.is_eq(ms, 0))))
      linked = Bool.and(U32.is_eq(count, 1), Bool.and(thread_started, ordered_pr))
      ReportRow{index, elapsed(ordered_pr, opened, 0, published), elapsed(linked, s, ms, published)}

def proved_rows(groups: Groups, +opened: U32, +owners: Owners) -> List<&2, ReportRow>:
  match groups:
    case NoGroups{}: []
    case Channel{name, Unproved{}, rest}: proved_rows(rest, opened, owners)
    case Channel{name, Release{index, published, checked, key, dispatch}, rest}:
      report_row(index, opened, published, owners) <> proved_rows(rest, opened, owners)

def at_least_one(rows: List<&2, ReportRow>) -> List<&2, ReportRow>:
  match rows:
    case []: ReportRow{0, Unknown{}, Unknown{}} <> []
    case _: rows

def report_rows(groups: Groups, opened: U32, owners: Owners) -> List<&2, ReportRow>:
  at_least_one(proved_rows(groups, opened, owners))
