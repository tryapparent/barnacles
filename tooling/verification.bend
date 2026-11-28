import Base

type Suites is Data:
  Invalid{}
  Selected{directories: List<&2, String>}

def default_suites() -> List<&2, String>:
  "hooks" <> "collector" <> "evidence" <> "dashboard" <> []

def owner_directories() -> List<&2, String>:
  "collector" <> "evidence" <> "dashboard" <> "tooling" <> []

def select_scope(+scope: String, +rest: Suites) -> Suites:
  match rest:
    case Invalid{}: Invalid{}
    case Selected{+directories}:
      Bool.pick(Suites, String.eq(scope, "hooks"), Selected{".githooks" <> "tooling/tests" <> directories},
        Bool.pick(Suites, Bool.or(String.eq(scope, "collector"), Bool.or(String.eq(scope, "evidence"), String.eq(scope, "dashboard"))),
          Selected{scope <> directories}, Invalid{}))

def collect_suites(scopes: List<&2, String>) -> Suites:
  match scopes:
    case []: Selected{[]}
    case scope <> rest: select_scope(scope, collect_suites(rest))

def select_suites(scopes: List<&2, String>) -> Suites:
  match scopes:
    case []: collect_suites(default_suites())
    case scope <> rest: collect_suites(scope <> rest)

def is_test(path: String) -> Bool:
  String.ends_with(path, ".test.ts")

def owner_grammar(+extension: String) -> String:
  Bool.pick(String, String.eq(extension, ".tsx"), "tsx",
    Bool.pick(String, Bool.or(String.eq(extension, ".ts"), Bool.or(String.eq(extension, ".mts"), String.eq(extension, ".cts"))),
      "typescript", Bool.pick(String, Bool.or(String.eq(extension, ".js"), Bool.or(String.eq(extension, ".mjs"),
        Bool.or(String.eq(extension, ".cjs"), String.eq(extension, ".jsx")))), "javascript", "")))

def published_entry(+owner: String, +target: String) -> Bool:
  Bool.or(Bool.and(String.eq(target, "tooling/bend.ts"), Bool.or(String.eq(owner, "collector"), String.eq(owner, "evidence"))),
    Bool.or(Bool.and(String.eq(owner, "collector"), String.eq(target, "evidence/index.ts")),
      Bool.and(String.eq(owner, "dashboard"), String.eq(target, "evidence/read.ts"))))

def local_import(+owner: String, +path: String, +target: String, target_owner: String) -> Bool:
  Bool.or(String.eq(owner, target_owner), Bool.or(published_entry(owner, target),
    Bool.or(Bool.and(String.eq(path, "dashboard/prepare.test.ts"), String.eq(target, "evidence/index.ts")),
      Bool.and(Bool.or(String.eq(path, "dashboard/3d/compiler.mjs"),
        Bool.or(String.eq(path, "dashboard/plow/build.ts"), String.eq(path, "dashboard/prepare.ts"))),
        String.eq(target, "tooling/bend.ts")))))

def disallowed_specifier(+value: String) -> Bool:
  Bool.or(String.is_empty(value), Bool.or(String.contains(value, "\\"),
    Bool.or(String.starts_with(value, "/"), Bool.or(String.starts_with(value, "#"),
      Bool.or(String.starts_with(value, "file:"), Bool.or(String.eq(value, "plow"), String.starts_with(value, "plow/")))))))

def ordinary_import(+value: String, owner: String, path: String, target: String, target_owner: String) -> Bool:
  Bool.and(Bool.not(disallowed_specifier(value)),
    Bool.or(Bool.not(String.starts_with(value, ".")), local_import(owner, path, target, target_owner)))

def generated_import(+path: String, +expression: String) -> Bool:
  Bool.or(Bool.and(String.eq(path, "tooling/bend.ts"), String.eq(expression, "pathToFileURL(path).href")),
    Bool.and(String.eq(path, "dashboard/plow/smoke.mjs"),
      String.eq(expression, "pathToFileURL(resolve(directory, 'worker.mjs')).href")))

def allowed_import(owner: String, +path: String, callee: String, expression: String, value: String, target: String, target_owner: String) -> Bool:
  Bool.or(Bool.and(String.eq(callee, "import"), generated_import(path, expression)),
    ordinary_import(value, owner, path, target, target_owner))
