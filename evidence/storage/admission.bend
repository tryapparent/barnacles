import Base

type Snapshot is Data:
  NoSnapshot{}
  Snapshot{revision: Revision}

type Revision is Data:
  Revision{high: U32, low: U32}

type AttemptRevision is Data:
  AttemptRevision{sha: String, status: String, updated: Revision, observed: Revision}

type Admission is Data:
  Admit{}
  Reject{message: String}

type NativeRef is Data:
  NativeRef{driver: String, native_driver: String, native_id: String, strength: String}

def count_native_matches(refs: List<&2, NativeRef>, +session: String, +remaining: U32, +matches: U32) -> Bool:
  match refs:
    case []: U32.is_eq(matches, 1)
    case NativeRef{driver, native_driver, native_id, strength} <> tail:
      found = Bool.and(String.eq(driver, "codex"), Bool.and(String.eq(native_driver, "codex"),
        Bool.and(String.eq(strength, "strong"), String.eq(native_id, session))))
      Bool.and(U32.is_gt(remaining, 0),
        count_native_matches(tail, session, U32.sub(remaining, 1), U32.add(matches, Bool.pick(U32, found, 1, 0))))

def t3_rollout_matches(refs: List<&2, NativeRef>, +session: String) -> Bool:
  Bool.and(Bool.not(String.eq(session, "")), count_native_matches(refs, session, 64, 0))

def words_before(+a: U32, lo_a: U32, +b: U32, lo_b: U32) -> Bool:
  Bool.or(U32.is_lt(a, b), Bool.and(U32.is_eq(a, b), U32.is_lt(lo_a, lo_b)))

def is_nan(high: U32, low: U32) -> Bool:
  words_before(2146435072, 0, U32.and(high, 2147483647), low)

def older(a: Revision, b: Revision) -> Bool:
  match a b:
    case Revision{+ah, +al} Revision{+bh, +bl}:
      +a_negative = U32.is_ge(ah, 2147483648)
      +b_negative = U32.is_ge(bh, 2147483648)
      before = Bool.pick(Bool, a_negative,
        Bool.or(Bool.not(b_negative), words_before(bh, bl, ah, al)),
        Bool.and(Bool.not(b_negative), words_before(ah, al, bh, bl)))
      Bool.and(before, Bool.not(Bool.or(is_nan(ah, al), is_nan(bh, bl))))

def snapshot_admission(previous: Snapshot, revision: Revision, message: String) -> Admission:
  match previous:
    case NoSnapshot{}: Admit{}
    case Snapshot{latest}:
      Bool.pick(Admission, older(revision, latest), Reject{message}, Admit{})

def thread_admission(previous: Snapshot, revision: Revision) -> Admission:
  snapshot_admission(previous, revision, "Older T3 snapshot")

def rollout_admission(previous: Snapshot, revision: Revision) -> Admission:
  snapshot_admission(previous, revision, "Shorter rollout snapshot")

def pr_admission(previous: Snapshot, revision: Revision) -> Admission:
  snapshot_admission(previous, revision, "Older pull request snapshot")

def attempt_admission(previous: Maybe<&2, AttemptRevision>, incoming: AttemptRevision) -> Admission:
  match previous incoming:
    case None{} _: Admit{}
    case Some{AttemptRevision{sha, status, updated, observed}} AttemptRevision{next_sha, next_status, next_updated, next_observed}:
      conflict = Bool.or(Bool.not(String.eq(sha, next_sha)), Bool.and(String.eq(status, "completed"),
        Bool.not(String.eq(next_status, "completed"))))
      stale = Bool.or(older(next_updated, updated), older(next_observed, observed))
      Bool.pick(Admission, Bool.or(conflict, stale),
        Reject{"Conflicting or older observation. Existing evidence was preserved."}, Admit{})
