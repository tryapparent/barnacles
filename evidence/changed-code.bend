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
