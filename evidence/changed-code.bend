import Base

type PathCount is Data:
  ChangedPath{path: String, commits: U32}

def empty_counts() -> Map<&2, U32>:
  Map.new(&2, U32)

def bump(path: String, found: Map<&2, U32> & U32) -> Map<&2, U32>:
  match found:
    case Tuple{counts, previous}:
      Map.set(&2, U32, counts, path, U32.add(previous, 1))

def count_paths(paths: List<&2, String>, counts: Map<&2, U32>) -> Map<&2, U32>:
  match paths:
    case []: counts
    case +path <> rest:
      count_paths(rest, bump(path, Map.get(U32, 0, counts, path)))

def count_commit(counts: Map<&2, U32>, paths: List<&2, String>, shallow_boundary: Bool) -> Map<&2, U32>:
  match shallow_boundary:
    case True{}: counts
    case False{}: count_paths(paths, counts)

def precedes(a: PathCount, b: PathCount) -> Bool:
  match a b:
    case ChangedPath{p, +n} ChangedPath{q, +m}:
      Bool.or(U32.is_gt(n, m), Bool.and(U32.is_eq(n, m), String.is_lt(p, q)))

def insert_ranked(ranked: List<&2, PathCount>, slots: Nat, +candidate: PathCount) -> List<&2, PathCount>:
  match ranked slots:
    case _ 0n: []
    case Nil{} 1n+remaining: [candidate]
    case Con{+head, tail} 1n+remaining:
      +earlier = precedes(candidate, head)
      Bool.pick(PathCount, earlier, candidate, head)
        <> insert_ranked(tail, remaining, Bool.pick(PathCount, earlier, head, candidate))

def rank_tree(counts: Map<&2, U32>, ranked: List<&2, PathCount>, +limit: Nat) -> List<&2, PathCount>:
  match counts:
    case MTip{}: ranked
    case MLeaf{path, commits}: insert_ranked(ranked, limit, ChangedPath{path, commits})
    case MNode{position, lo, hi}: rank_tree(hi, rank_tree(lo, ranked, limit), limit)

def top_paths(counts: Map<&2, U32>) -> List<&2, PathCount>:
  rank_tree(counts, [], 25n)

type HistoryScan is Data:
  Scan{count: U32, more: Bool, paths: Map<&2, U32>}

def start_scan() -> HistoryScan:
  Scan{0, False{}, empty_counts()}

def add_boundary(boundaries: Map<&2, Bool>, id: String) -> Map<&2, Bool>:
  Map.set(&2, Bool, boundaries, id, True{})

def shallow_boundaries(ids: List<&2, String>) -> Map<&2, Bool>:
  List.foldl(~&2, ~String, ~Map<&2, Bool>, ~add_boundary, ids, Map.new(&2, Bool))

def scan_path_counts(ids: Map<&2, Bool> & Bool, paths: List<&2, String>, counts: Map<&2, U32>) -> Map<&2, U32>:
  match ids:
    case Tuple{boundaries, boundary}: count_commit(counts, paths, boundary)

def scan_next(scan: HistoryScan, at_limit: Bool, commit: String, paths: List<&2, String>,
  boundaries: Map<&2, Bool>) -> HistoryScan:
  match scan at_limit:
    case Scan{count, more, counts} True{}: Scan{count, True{}, counts}
    case Scan{count, more, counts} False{}:
      Scan{U32.inc(count), False{}, scan_path_counts(Map.has(&2, Bool, boundaries, commit), paths, counts)}

def scan_commit(+scan: HistoryScan, limit: U32, commit: String, paths: List<&2, String>, boundaries: Map<&2, Bool>) -> HistoryScan:
  match scan:
    case Scan{count, more, counts}: scan_next(scan, U32.is_ge(count, limit), commit, paths, boundaries)

def scan_paths(scan: HistoryScan) -> List<&2, PathCount>:
  match scan:
    case Scan{count, more, counts}: top_paths(counts)
