import Base
import ../repository.bend as Repository

type JoinState is Data:
  Linked{}
  Missing{}
  Conflict{}

def exact_join(+expected: String, +captured: String) -> JoinState:
  Bool.pick(JoinState, String.eq(captured, ""), Missing{},
    Bool.pick(JoinState, String.eq(expected, captured), Linked{}, Conflict{}))

def span_scan(+session: String, +observations: List<&2, String>, +matched: Bool, +conflict: Bool) -> JoinState:
  match observations:
    case []:
      Bool.pick(JoinState, conflict, Conflict{}, Bool.pick(JoinState, matched, Linked{}, Missing{}))
    case observed <> tail:
      +equal = String.eq(observed, session)
      span_scan(session, tail, Bool.or(matched, equal),
        Bool.or(conflict, Bool.not(Bool.or(equal, String.eq(observed, "")))))

def span_decision(+session: String, +observations: List<&2, String>) -> JoinState:
  span_scan(session, observations, False{}, False{})

def ci_kind(+kind: String) -> Bool:
  Bool.or(String.eq(kind, "query"), String.eq(kind, "watch"))

type NativeBinding is Data:
  NativeBinding{thread: String, reference: String, driver: String, native_driver: String, native_id: String, strength: String}

type BindingChoice is Data:
  NoBinding{}
  Bound{session_id: String, reference_id: String}
  Ambiguous{}

def add_binding(choice: BindingChoice, +session: String, +reference: String) -> BindingChoice:
  match choice:
    case NoBinding{}: Bound{session, reference}
    case Bound{_, _}: Ambiguous{}
    case Ambiguous{}: Ambiguous{}

def observe_binding(valid: Bool, choice: BindingChoice, +session: String, +reference: String) -> BindingChoice:
  match valid:
    case True{}: add_binding(choice, session, reference)
    case False{}: choice

def binding_scan(+thread: String, +requested: String, +refs: List<&2, NativeBinding>, +choice: BindingChoice) -> BindingChoice:
  match refs:
    case []: choice
    case NativeBinding{owner, reference, driver, native_driver, native_id, strength} <> tail:
      +match_id = Bool.or(String.eq(requested, ""), String.eq(requested, native_id))
      +scoped = Bool.and(String.eq(thread, owner), Bool.not(String.eq(reference, "")))
      +valid_driver = Bool.and(String.eq(driver, "codex"), String.eq(native_driver, "codex"))
      +strong = Bool.and(String.eq(strength, "strong"), Bool.not(String.eq(native_id, "")))
      valid = Bool.and(scoped, Bool.and(match_id, Bool.and(valid_driver, strong)))
      binding_scan(thread, requested, tail, observe_binding(valid, choice, native_id, reference))

def choose_binding(+thread: String, +requested: String, +refs: List<&2, NativeBinding>) -> BindingChoice:
  binding_scan(thread, requested, refs, NoBinding{})

def repository_name(value: String) -> String:
  Repository.normalized(value)
