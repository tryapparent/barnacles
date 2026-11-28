import Base

def hex_digits(digits: List<&2, Char>) -> Bool:
  match digits:
    case []: True{}
    case +head <> tail:
      Bool.and(Bool.or(Char.is_digit(head), String.contains("abcdef", String.from_list([head]))), hex_digits(tail))

def valid_object_id(+value: String) -> Bool:
  +length = String.length(value)
  Bool.and(Bool.or(Nat.is_eq(length, 40n), Nat.is_eq(length, 64n)), hex_digits(String.to_list(value)))

def valid_tree_pair(+from: String, +to: String) -> Bool:
  Bool.or(Bool.and(String.is_empty(from), String.is_empty(to)),
    Bool.and(valid_object_id(from), valid_object_id(to)))

def excluded_component(part: String) -> Bool:
  List.contains(~String, ~String.eq,
    [".git", "target", "node_modules", "vendor", "third_party", "third-party", "__pycache__"], part)

def comment_action(+before: String, +after: String, old_oid: String, new_oid: String, old_path: String,
  path: String, status: String) -> String:
  +old_file = String.starts_with(before, "100")
  Bool.pick(String, String.eq(after, "000000"), "skip",
    Bool.pick(String, Bool.not(String.starts_with(after, "100")), "unsupported",
      Bool.pick(String, Bool.and(old_file, Bool.and(String.eq(old_path, path), String.eq(old_oid, new_oid))), "skip",
        Bool.pick(String, Bool.and(old_file, Bool.not(String.starts_with(status, "C"))), "compare", "fresh"))))

def increment_comment(+comment: String, found: Map<&2, Nat> & Nat) -> Map<&2, Nat>:
  match found:
    case Tuple{allowance, count}: Map.set(&2, Nat, allowance, comment, Nat.add(count, 1n))

def count_comment(allowance: Map<&2, Nat>, +comment: String) -> Map<&2, Nat>:
  increment_comment(comment, Map.get(Nat, 0n, allowance, comment))

def allowed_count(count: Nat, found: Map<&2, Nat> & Nat) -> Bool:
  match found:
    case Tuple{map, allowed}: Nat.is_le(count, allowed)

def counts_allowed(added: Map<&2, Nat>, +allowance: Map<&2, Nat>) -> Bool:
  match added:
    case MTip{}: True{}
    case MLeaf{comment, count}: allowed_count(count, Map.get(Nat, 0n, allowance, comment))
    case MNode{offset, lo, hi}: Bool.and(counts_allowed(lo, allowance), counts_allowed(hi, allowance))

def comment_counts(comments: List<&2, String>) -> Map<&2, Nat>:
  List.foldl(~&2, ~String, ~Map<&2, Nat>, ~(allowance => comment => count_comment(allowance, comment)), comments, Map.new(&2, Nat))

def comments_allowed(before: List<&2, String>, after: List<&2, String>) -> Bool:
  counts_allowed(comment_counts(after), comment_counts(before))

def all_zero(digits: List<&2, Char>) -> Bool:
  match digits:
    case []: True{}
    case head <> tail: Bool.and(Char.is_eq(head, '0'), all_zero(tail))

def push_base(+local_oid: String, remote_ref: String, remote_oid: String) -> String:
  Bool.pick(String, all_zero(String.to_list(local_oid)), "skip",
    Bool.pick(String, String.eq(remote_ref, "refs/heads/main"),
      Bool.pick(String, all_zero(String.to_list(remote_oid)), "missing", "remote"), "main"))

type Scopes is Data:
  Scopes{collect: Bool, analyze: Bool, hooks: Bool}

def path_scopes(scopes: Scopes, +path: String) -> Scopes:
  match scopes:
    case Scopes{+collect, +analyze, +hooks}:
      Bool.pick(Scopes, Bool.or(String.ends_with(path, ".md"), String.eq(path, "LICENSE")),
        Scopes{collect, analyze, hooks},
        Bool.pick(Scopes, String.starts_with(path, ".githooks/"), Scopes{collect, analyze, True{}},
          Bool.pick(Scopes, String.starts_with(path, "collect/"), Scopes{True{}, True{}, hooks},
            Bool.pick(Scopes, String.starts_with(path, "analyze/"), Scopes{collect, True{}, hooks}, Scopes{True{}, True{}, True{}}))))

def include_scope(name: String, include: Bool, +rest: List<&2, String>) -> List<&2, String>:
  Bool.pick(List<&2, String>, include, name <> rest, rest)

def scope_names(scopes: Scopes) -> List<&2, String>:
  match scopes:
    case Scopes{collect, analyze, hooks}:
      include_scope("collect", collect, include_scope("analyze", analyze, include_scope("hooks", hooks, [])))

def push_scopes(paths: List<&2, String>) -> List<&2, String>:
  scope_names(List.foldl(~&2, ~String, ~Scopes, ~(scopes => path => path_scopes(scopes, path)), paths, Scopes{False{}, False{}, False{}}))

def valid_component(+part: String) -> Bool:
  Bool.not(Bool.or(String.is_empty(part), Bool.or(String.eq(part, "."), String.eq(part, ".."))))

def snapshot_mode(+mode: String, kind: String, path: String) -> Nat:
  allowed = Bool.and(String.eq(kind, "blob"), List.all(~&2, ~String, ~(part => valid_component(part)), String.split(path, '/')))
  Bool.pick(Nat, allowed,
    Bool.pick(Nat, String.eq(mode, "100755"), 493n, Bool.pick(Nat, String.eq(mode, "100644"), 420n, 0n)), 0n)
