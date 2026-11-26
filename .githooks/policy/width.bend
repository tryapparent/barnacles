import Base
import ./rules.bend as Rules

def valid_tree_pair(from: String, to: String) -> Bool:
  Rules.valid_tree_pair(from, to)

type TreeEntry is Data:
  Entry{mode: String, kind: String, path: String}

type ChildKind is Data:
  Missing{}
  LeafFile{}
  Gitlink{}
  Nested{}

type EntryPair is Data:
  EntryPair{before: ChildKind, after: ChildKind}

type Directory is Data:
  Directory{children: Map<&2, EntryPair>, eligible: Bool, touched: Bool}

type Counts is Data:
  Counts{files: U32, directories: U32, changed: Bool}

type Violation is Data:
  Overwide{directory: String, files: U32, directories: U32, limit: U32}

def excluded(part: String) -> Bool:
  List.contains(~String, ~String.eq,
    [".git", "target", "node_modules", "vendor", "third_party", "third-party", "__pycache__"], part)

def first_party(parts: List<&2, String>) -> Bool:
  Bool.not(List.any(~&2, ~String, ~excluded, parts))

def first_party_path(path: String) -> Bool:
  first_party(String.split(path, '/'))

def scan_changes(paths: List<&2, String>, found: Bool) -> Bool:
  match paths found:
    case _ True{}: True{}
    case [] False{}: False{}
    case path <> rest False{}: scan_changes(rest, first_party_path(path))

def has_first_party_changes(paths: List<&2, String>) -> Bool:
  scan_changes(paths, False{})

def empty_directory() -> Directory:
  Directory{Map.new(&2, EntryPair), False{}, False{}}

def child_path(+parent: String, +name: String) -> String:
  Bool.pick(String, String.is_empty(parent), name, String.concat([parent, "/", name]))

def entry_pair(previous: EntryPair, kind: ChildKind, candidate: Bool) -> EntryPair:
  match previous candidate:
    case EntryPair{before, after} True{}: EntryPair{before, kind}
    case EntryPair{before, after} False{}: EntryPair{kind, after}

def set_child(found: Map<&2, EntryPair> & EntryPair, name: String, kind: ChildKind, candidate: Bool) -> Map<&2, EntryPair>:
  match found:
    case Tuple{children, previous}: Map.set(&2, EntryPair, children, name, entry_pair(previous, kind, candidate))

def record_child(found: Map<&2, Directory> & Directory, +parent: String, +name: String,
  kind: ChildKind, blob: Bool, candidate: Bool) -> Map<&2, Directory>:
  match found:
    case Tuple{tree, Directory{children, eligible, touched}}:
      +updated = set_child(Map.get(EntryPair, EntryPair{Missing{}, Missing{}}, children, name), name, kind, candidate)
      Map.set(&2, Directory, tree, parent, Directory{updated, Bool.or(blob, eligible), touched})

def record_path(parts: List<&2, String>, tree: Map<&2, Directory>, +parent: String, +kind: ChildKind,
  +blob: Bool, +candidate: Bool) -> Map<&2, Directory>:
  match parts:
    case []: tree
    case name <> []: record_child(Map.get(Directory, empty_directory(), tree, parent), parent, name, kind, blob, candidate)
    case +name <> next <> rest:
      +updated = record_child(Map.get(Directory, empty_directory(), tree, parent), parent, name, Nested{}, blob, candidate)
      record_path(next <> rest, updated, child_path(parent, name), kind, blob, candidate)

def record_first_party(tree: Map<&2, Directory>, parts: List<&2, String>, kind: ChildKind, blob: Bool,
  candidate: Bool, include: Bool) -> Map<&2, Directory>:
  match include:
    case True{}: record_path(parts, tree, "", kind, blob, candidate)
    case False{}: tree

def record_tree(entries: List<&2, TreeEntry>, tree: Map<&2, Directory>, +candidate: Bool) -> Map<&2, Directory>:
  match entries:
    case []: tree
    case Entry{mode, kind, path} <> rest:
      +parts = String.split(path, '/')
      +leaf = Bool.pick(ChildKind, String.eq(mode, "160000"), Gitlink{}, LeafFile{})
      +updated = record_first_party(tree, parts, leaf, String.eq(kind, "blob"), candidate, first_party(parts))
      record_tree(rest, updated, candidate)

def mark_touched(found: Map<&2, Directory> & Directory, directory: String) -> Map<&2, Directory>:
  match found:
    case Tuple{tree, Directory{children, eligible, touched}}:
      Map.set(&2, Directory, tree, directory, Directory{children, eligible, True{}})

def mark_path(parts: List<&2, String>, tree: Map<&2, Directory>, +parent: String) -> Map<&2, Directory>:
  match parts:
    case []: tree
    case name <> []: mark_touched(Map.get(Directory, empty_directory(), tree, parent), parent)
    case +name <> next <> rest: mark_path(next <> rest, tree, child_path(parent, name))

def mark_first_party(tree: Map<&2, Directory>, parts: List<&2, String>, include: Bool) -> Map<&2, Directory>:
  match include:
    case True{}: mark_path(parts, tree, "")
    case False{}: tree

def mark_changes(paths: List<&2, String>, tree: Map<&2, Directory>) -> Map<&2, Directory>:
  match paths:
    case []: tree
    case path <> rest:
      +parts = String.split(path, '/')
      mark_changes(rest, mark_first_party(tree, parts, first_party(parts)))

def entry_kind(kind: ChildKind) -> U32:
  match kind:
    case Missing{}: 0
    case LeafFile{}: 1
    case _: 2

def tool_directory(+name: String) -> Bool:
  Bool.or(String.eq(name, ".github"), String.eq(name, ".githooks"))

def actual_tool_directory(kind: ChildKind, name: String, root: Bool) -> Bool:
  match kind:
    case Nested{}: Bool.and(root, tool_directory(name))
    case _: False{}

def add_child(counts: Counts, pair: EntryPair, name: String, root: Bool) -> Counts:
  match counts pair:
    case Counts{files, directories, changed} EntryPair{before, +after}:
      +kind = entry_kind(after)
      +file = U32.is_eq(kind, 1)
      +directory = Bool.and(U32.is_eq(kind, 2), Bool.not(actual_tool_directory(after, name, root)))
      Counts{U32.add(files, Bool.to_u32(file)), U32.add(directories, Bool.to_u32(directory)),
        Bool.or(changed, U32.is_ne(entry_kind(before), kind))}

def count_children(children: Map<&2, EntryPair>, counts: Counts, +root: Bool) -> Counts:
  match children:
    case MTip{}: counts
    case MLeaf{name, pair}: add_child(counts, pair, name, root)
    case MNode{position, lo, hi}: count_children(hi, count_children(lo, counts, root), root)

def emit_violation(result: List<&2, Violation>, violation: Violation, overwide: Bool) -> List<&2, Violation>:
  match overwide:
    case True{}: violation <> result
    case False{}: result

def add_violation(result: List<&2, Violation>, +directory: String, counts: Counts, +limit: U32) -> List<&2, Violation>:
  match counts:
    case Counts{+files, +directories, changed}:
      +overwide = Bool.and(changed, Bool.or(U32.is_gt(files, limit), U32.is_gt(directories, limit)))
      emit_violation(result, Overwide{directory, files, directories, limit}, overwide)

def check_eligible(result: List<&2, Violation>, +path: String, children: Map<&2, EntryPair>, touched: Bool, check: Bool) -> List<&2, Violation>:
  match check:
    case True{}: add_violation(result, path, count_children(children, Counts{0, 0, touched}, String.is_empty(path)), 10)
    case False{}: result

def assess_directory(result: List<&2, Violation>, +path: String, directory: Directory) -> List<&2, Violation>:
  match directory:
    case Directory{children, eligible, touched}:
      +check = Bool.and(eligible, Bool.not(String.eq(path, ".github/workflows")))
      check_eligible(result, path, children, touched, check)

def assess_tree(tree: Map<&2, Directory>, result: List<&2, Violation>) -> List<&2, Violation>:
  match tree:
    case MTip{}: result
    case MLeaf{path, directory}: assess_directory(result, path, directory)
    case MNode{position, lo, hi}: assess_tree(hi, assess_tree(lo, result))

def check_width(before: List<&2, TreeEntry>, after: List<&2, TreeEntry>, changed: List<&2, String>) -> List<&2, Violation>:
  +tree = record_tree(after, record_tree(before, Map.new(&2, Directory), False{}), True{})
  assess_tree(mark_changes(changed, tree), [])
