import Base

type Input is Data:
  Path{path: String, touches: U32, encoded: Bool}

type Counter is Data:
  Count{name: String, touches: U32, directory: Bool, children: Map<&2, Counter>}

def empty(name: String, directory: Bool) -> Counter:
  Count{name, 0, directory, Map.new(&2, Counter)}

def append_path(+prefix: String, +name: String) -> String:
  Bool.pick(String, String.is_empty(prefix), name, String.append(prefix, String.append("/", name)))

def save_child(parent: Map<&2, Counter> & Counter, key: String, update: Counter -> Counter) -> Map<&2, Counter>:
  match parent:
    case Tuple{nodes, old}: Map.set(&2, Counter, nodes, key, update(old))

def add(parts: List<&2, String>, node: Counter, +value: U32) -> Counter:
  match parts node:
    case Nil{} Count{name, total, directory, children}:
      Count{name, U32.add(total, value), directory, children}
    case Con{+part, +rest} Count{name, total, directory, children}:
      +branch = Bool.not(List.is_empty(&2, String, rest))
      +key = String.append(Bool.pick(String, branch, "d", "f"), part)
      Count{name, U32.add(total, value), directory,
        save_child(Map.get(Counter, empty(part, branch), children, key), key, old => add(rest, old, value))}

def add_input(tree: Counter, input: Input) -> Counter:
  match input:
    case Path{+path, touches, encoded}:
      add(Bool.pick(List<&2, String>, encoded, [String.append("Base64 / ", path)], String.split(path, '/')), tree, touches)

def count_all(files: List<&2, Input>, tree: Counter) -> Counter:
  match files:
    case Nil{}: tree
    case file <> rest: count_all(rest, add_input(tree, file))

def before(a: Counter, b: Counter) -> Bool:
  match a b:
    case Count{name, +n, directory, children} Count{other, +m, other_directory, other_children}:
      Bool.or(U32.is_gt(n, m), Bool.and(U32.is_eq(n, m), String.is_le(name, other)))

def flatten(children: Map<&2, Counter>, tail: List<&2, Counter>) -> List<&2, Counter>:
  match children:
    case MTip{}: tail
    case MLeaf{key, value}: value <> tail
    case MNode{position, lo, hi}: flatten(lo, flatten(hi, tail))

def sorted(node: Counter) -> List<&2, Counter>:
  match node:
    case Count{name, touches, directory, children}: List.sort(~Counter, ~before, flatten(children, []))

def tree(files: List<&2, Input>) -> Counter:
  count_all(files, empty("Repository", True{}))

def first_directory(nodes: List<&2, Counter>) -> Maybe<&2, Counter>:
  match nodes:
    case Nil{}: None{}
    case Count{name, touches, True{}, children} <> rest: Some{Count{name, touches, True{}, children}}
    case node <> rest: first_directory(rest)

def default_route(depth: Nat, next: Maybe<&2, Counter>) -> List<&2, Counter>:
  match depth next:
    case 1n+rest Some{+node}: node <> default_route(rest, first_directory(sorted(node)))
    case _ _: []

def initial_route(node: Counter) -> List<&2, Counter>:
  default_route(5n, first_directory(sorted(node)))

def share(touches: U32, total: U32) -> F32:
  F32.div(F32.from_nat(U32.to_nat(touches)), F32.from_nat(U32.to_nat(U32.max(total, 1))))

type Slice is Data:
  Band{node: Counter, top: F32, size: F32}

def bands(nodes: List<&2, Counter>, +total: U32, +used: U32) -> List<&2, Slice>:
  match nodes:
    case Nil{}: []
    case +node <> rest:
      match node:
        case Count{name, +touches, directory, children}:
          Band{node, share(used, total), share(touches, total)} <> bands(rest, total, U32.add(used, touches))

type RankedFile is Data:
  FileMatch{path: String, touches: U32, route: List<&2, Counter>}

type FileResults is Data:
  Matches{count: U32, rows: List<&2, RankedFile>}

def result_before(a: RankedFile, b: RankedFile) -> Bool:
  match a b:
    case FileMatch{path, +n, route} FileMatch{other, +m, other_route}:
      Bool.or(U32.is_gt(n, m), Bool.and(U32.is_eq(n, m), String.is_lt(path, other)))

def insert(rows: List<&2, RankedFile>, limit: Nat, +row: RankedFile) -> List<&2, RankedFile>:
  match rows limit:
    case _ 0n: []
    case Nil{} 1n+remaining: [row]
    case Con{+first, rest} 1n+remaining:
      +earlier = result_before(row, first)
      Bool.pick(RankedFile, earlier, row, first) <> insert(rest, remaining, Bool.pick(RankedFile, earlier, first, row))

def add_result(state: FileResults, keep: Bool, result: RankedFile) -> FileResults:
  match state keep:
    case Matches{count, rows} True{}: Matches{U32.inc(count), insert(rows, 10n, result)}
    case Matches{count, rows} False{}: Matches{count, rows}

def find_files(nodes: Map<&2, Counter>, +prefix: String, +route: List<&2, Counter>, +query: String, state: FileResults) -> FileResults:
  match nodes:
    case MTip{}: state
    case MNode{position, left, right}:
      find_files(right, prefix, route, query, find_files(left, prefix, route, query, state))
    case MLeaf{key, Count{+name, +touches, True{}, +children}}:
      find_files(children, append_path(prefix, name), Count{name, touches, True{}, children} <> route, query, state)
    case MLeaf{key, Count{+name, +touches, False{}, children}}:
      +path = append_path(prefix, name)
      add_result(state, String.contains(String.to_lower(path), query),
        FileMatch{path, touches, List.reverse(&2, Counter, Count{name, touches, False{}, children} <> route)})

def search(node: Counter, query: String) -> FileResults:
  match node:
    case Count{name, touches, directory, children}:
      find_files(children, "", [], String.to_lower(String.trim(query)), Matches{0, []})
