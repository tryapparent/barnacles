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
