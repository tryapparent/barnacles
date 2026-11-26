import Base
import ./rules.bend as Rules
import 0x419ec39802735c4664960ab4b9d962e5/json.bend as Json
import 0xec25e4adfb02e59e4b817801115988ee/bytes.bend as Bytes

def valid_tree_pair(from: String, to: String) -> Bool:
  Rules.valid_tree_pair(from, to)

def path_allowed(+path: String, found: Map<&2, Bool> & Bool) -> Bool:
  match found:
    case Tuple{entries, approved}:
      Bool.or(approved, Bool.or(String.ends_with(path, ".bend"), Bool.or(String.ends_with(path, ".md"),
        Bool.or(String.eq(path, "LICENSE"), String.ends_with(path, "/LICENSE")))))

def allowed_path(directory: Map<&2, Bool>, +path: String) -> Bool:
  path_allowed(path, Map.get(Bool, False{}, directory, path))

def reject_paths(+approved: Map<&2, Bool>, added: List<&2, String>, +rejected: List<&2, String>) -> List<&2, String>:
  match added:
    case []: List.reverse(&2, String, rejected)
    case +path <> tail:
      reject_paths(approved, tail, Bool.pick(List<&2, String>, allowed_path(approved, path), rejected, path <> rejected))

type Registry is Data:
  Invalid{}
  Approved{paths: Map<&2, Bool>}

def registry_paths(paths: List<&1, Json.Val>, index: Registry) -> Registry:
  match paths index:
    case [] _: index
    case Json.Str{path} <> rest Approved{approved}:
      registry_paths(rest, Approved{Map.set(&2, Bool, approved, Bytes.to_string(path), True{})})
    case _ _: Invalid{}

def registry_groups(groups: List<&1, Bytes.Bytes & Json.Val>, index: Registry) -> Registry:
  match groups index:
    case [] _: index
    case (key, Json.Arr{paths}) <> rest Approved{approved}:
      registry_groups(rest, registry_paths(paths, Approved{approved}))
    case _ _: Invalid{}

def read_registry(decoded: Maybe<&1, Json.Val>) -> Registry:
  match decoded:
    case Some{Json.Obj{groups}}: registry_groups(groups, Approved{Map.new(&2, Bool)})
    case _: Invalid{}

type CheckedPaths is Data:
  InvalidRegistry{}
  Checked{rejected: List<&2, String>}

def check_registry(registry: Registry, added: List<&2, String>) -> CheckedPaths:
  match registry:
    case Invalid{}: InvalidRegistry{}
    case Approved{approved}: Checked{reject_paths(approved, added, [])}

def check_paths(text: String, added: List<&2, String>) -> CheckedPaths:
  check_registry(read_registry(Json.parse.strict.unique.bytes(Json.utf8(text), 2)), added)
