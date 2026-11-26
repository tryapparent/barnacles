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

def pr_milestone(start: U32, observed: U32) -> Bool:
  ordered(start, observed)

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

def async_end(start_s: U32, start_ms: U32, end_s: U32, end_ms: U32, unambiguous: Bool) -> Bool:
  Bool.and(unambiguous, interval_ms(start_s, start_ms, end_s, end_ms))

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
