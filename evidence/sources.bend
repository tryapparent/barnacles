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

def tool_label(+name: String, fallback: String) -> String:
  Bool.pick(String, String.eq(name, "exec_command"), "Shell command",
    Bool.pick(String, String.eq(name, "write_stdin"), "Process I/O",
      Bool.pick(String, String.eq(name, "apply_patch"), "Apply patch",
        Bool.pick(String, String.eq(name, "update_plan"), "Update plan",
          Bool.pick(String, String.eq(name, "view_image"), "Inspect image",
            Bool.pick(String, String.eq(name, "web__run"), "Web lookup",
              Bool.pick(String, String.starts_with(name, "mcp__t3_code__"), "T3 operation",
                Bool.pick(String, String.starts_with(name, "mcp__codex_apps__github__"), "GitHub operation", fallback))))))))

type ToolContext is Data:
  Tool{label: String, command: String, categories: String, wrapper: Bool, cell_wait: Bool}

type ShellCommand is Data:
  Command{name: String, args: List<&2, String>}

type ToolInvocation is Data:
  Invocation{receiver: String, method: String, commands: List<&2, ShellCommand>}

def known_command(+program: String, +action: String) -> String:
  Bool.pick(String, String.eq(program, "unknown"), "",
    Bool.pick(String, Bool.or(String.eq(action, "unknown"), String.eq(action, "")), program,
      String.append(program, String.append(" ", action))))

def command_label(+program: String, +word: String) -> String:
  known = label(program, ["git", "gh", "node", "npm", "docker", "rg", "sed", "cat", "curl", "python3", "ffmpeg", "ffprobe", "ls", "jq", "t3-build", "cargo"])
  action = Bool.pick(String, String.eq(program, "git"), label(word, ["status", "diff", "log", "show", "fetch", "add", "commit", "push", "switch", "rev-parse"]),
    Bool.pick(String, String.eq(program, "gh"), label(word, ["pr", "run", "api"]),
      Bool.pick(String, String.eq(program, "node"), label(word, ["--test"]),
        Bool.pick(String, String.eq(program, "npm"), label(word, ["ci", "test", "run"]),
          Bool.pick(String, String.eq(program, "docker"), label(word, ["ps", "run", "inspect", "pull", "compose"]),
            Bool.pick(String, String.eq(program, "cargo"), label(word, ["build", "check", "test", "clippy"]), ""))))))
  known_command(known, action)

def last_word(words: List<&2, String>) -> String:
  match words:
    case []: ""
    case head <> []: head
    case head <> tail: last_word(tail)

def first_word(words: List<&2, String>) -> String:
  match words:
    case []: ""
    case head <> tail: head

def command_words(words: List<&2, String>) -> ShellCommand:
  match words:
    case []: Command{"", []}
    case name <> tail: Command{last_word(String.split(name, '/')), tail}

def skip_env(words: List<&2, String>) -> ShellCommand:
  match words:
    case []: Command{"", []}
    case +head <> +tail:
      Bool.pick(ShellCommand, Bool.or(String.ends_with(head, "="),
        Bool.or(String.eq(head, "-i"), String.eq(head, "--ignore-environment"))), skip_env(tail),
        Bool.pick(ShellCommand, String.eq(head, "--"), command_words(tail), command_words(head <> tail)))

def env_command(name: String, +args: List<&2, String>) -> ShellCommand:
  +program = last_word(String.split(name, '/'))
  Bool.pick(ShellCommand, String.eq(program, "env"), skip_env(args), Command{program, args})

def runner_command(words: List<&2, String>) -> ShellCommand:
  match words:
    case []: Command{"t3-build", []}
    case "--" <> tail: command_words(tail)
    case head <> tail: runner_command(tail)

def unwrap_runner(command: ShellCommand) -> ShellCommand:
  match command:
    case Command{"t3-build", args}: runner_command(args)
    case _: command

def normalize_shell(name: String, args: List<&2, String>) -> ShellCommand:
  unwrap_runner(env_command(name, args))

def git_action(args: List<&2, String>) -> String:
  match args:
    case []: ""
    case "-C" <> value <> tail: git_action(tail)
    case "-c" <> value <> tail: git_action(tail)
    case "--git-dir" <> value <> tail: git_action(tail)
    case "--work-tree" <> value <> tail: git_action(tail)
    case head <> tail: head

def cargo_action(args: List<&2, String>) -> String:
  match args:
    case []: ""
    case +head <> tail:
      Bool.pick(String, String.starts_with(head, "+"), first_word(tail), head)

def shell_action(program: String, +args: List<&2, String>) -> String:
  match program:
    case "git": git_action(args)
    case "cargo": cargo_action(args)
    case _: first_word(args)

def normalized_command_label(command: ShellCommand) -> String:
  match command:
    case Command{+program, words}: command_label(program, shell_action(program, words))

def first_command(commands: List<&2, ShellCommand>) -> String:
  match commands:
    case []: ""
    case Command{name, args} <> tail: normalized_command_label(normalize_shell(name, args))

def rust_category(action: String) -> String:
  match action:
    case "build": "Rust build"
    case "check": "Rust check"
    case "test": "Rust test"
    case "clippy": "Rust lint"
    case _: "Other Rust command"

def git_category(action: String) -> String:
  match action:
    case "push": "Git push"
    case "fetch": "Git fetch"
    case "commit": "Git commit"
    case "status": "Git inspection"
    case "log": "Git inspection"
    case "diff": "Git inspection"
    case "show": "Git inspection"
    case "rev-parse": "Git inspection"
    case _: "Other Git command"

def shell_category(program: String, +action: String) -> String:
  match program:
    case "cargo": rust_category(action)
    case "git": git_category(action)
    case "gh":
      Bool.pick(String, String.eq(action, "pr"), "GitHub PR operation",
        Bool.pick(String, String.eq(action, "run"), "GitHub Actions operation", "GitHub operation"))
    case "node": Bool.pick(String, String.eq(action, "--test"), "JavaScript test", "JavaScript command")
    case "npm":
      Bool.pick(String, String.eq(action, "test"), "JavaScript test",
        Bool.pick(String, String.eq(action, "ci"), "Install dependencies", "Package command"))
    case "docker": "Container operation"
    case "t3-build": "Build runner"
    case "mkdir": "File preparation"
    case "mktemp": "File preparation"
    case "echo": "Shell output"
    case "printf": "Shell output"
    case "test": "Shell check"
    case "rg": "File inspection"
    case "cat": "File inspection"
    case "ls": "File inspection"
    case "tail": "File inspection"
    case _: "Unknown command"

def category_rank(+name: String) -> U32:
  Bool.pick(U32, Bool.or(String.starts_with(name, "Rust "), String.eq(name, "Git push")), 0,
    Bool.pick(U32, Bool.or(String.starts_with(name, "Unknown"), String.starts_with(name, "File ")), 2, 1))

def add_category(+name: String, categories: List<&2, String>) -> List<&2, String>:
  match categories:
    case []: name <> []
    case +head <> +rest:
      Bool.pick(List<&2, String>, String.eq(name, head), head <> rest,
        Bool.pick(List<&2, String>, U32.is_lt(category_rank(name), category_rank(head)), name <> head <> rest,
          head <> add_category(name, rest)))

def normalized_category(command: ShellCommand) -> String:
  match command:
    case Command{+program, words}: shell_category(program, shell_action(program, words))

type CommandMix is Data:
  NoMix{}
  Mix{file_count: Nat, git_count: Nat, build_count: Nat, push_count: Nat}

def mix_category(category: String, mix: CommandMix) -> CommandMix:
  match category mix:
    case "File inspection" Mix{files, git, builds, pushes}: Mix{Nat.add(files, 1n), git, builds, pushes}
    case "Git inspection" Mix{files, git, builds, pushes}: Mix{files, Nat.add(git, 1n), builds, pushes}
    case "Rust build" Mix{files, git, builds, pushes}: Mix{files, git, Nat.add(builds, 1n), pushes}
    case "Git push" Mix{files, git, builds, pushes}: Mix{files, git, builds, Nat.add(pushes, 1n)}
    case _ _: NoMix{}

def count_mix(commands: List<&2, ShellCommand>, mix: CommandMix) -> CommandMix:
  match commands:
    case []: mix
    case Command{name, args} <> tail:
      count_mix(tail, mix_category(normalized_category(normalize_shell(name, args)), mix))

def command_mix(commands: List<&2, ShellCommand>) -> CommandMix:
  match commands:
    case []: NoMix{}
    case _: count_mix(commands, Mix{0n, 0n, 0n, 0n})

def keep_mix_receipt(+seconds: F32, exit_code: U32, running: Bool, +end_seen: Bool, ambiguous: Bool) -> Bool:
  Bool.and(U32.is_eq(exit_code, 0), Bool.and(F32.is_gt(seconds, 0.0),
    Bool.and(end_seen, Bool.not(Bool.or(running, ambiguous)))))

def shell_categories(commands: List<&2, ShellCommand>, categories: List<&2, String>) -> List<&2, String>:
  match commands:
    case []: categories
    case Command{name, args} <> tail:
      shell_categories(tail, add_category(normalized_category(normalize_shell(name, args)), categories))

def shell_invocation(+commands: List<&2, ShellCommand>, categories: List<&2, String>) -> List<&2, String>:
  match commands:
    case []: add_category("Unknown command", categories)
    case _: shell_categories(commands, categories)

def invocation_categories(+method: String, commands: List<&2, ShellCommand>, +categories: List<&2, String>) -> List<&2, String>:
  Bool.pick(List<&2, String>, String.eq(method, "exec_command"), shell_invocation(commands, categories),
    add_category(tool_label(method, "Unknown tool"), categories))

def wrapped_categories(invocations: List<&2, ToolInvocation>, +categories: List<&2, String>) -> List<&2, String>:
  match invocations:
    case []: categories
    case Invocation{receiver, method, commands} <> tail:
      wrapped_categories(tail, Bool.pick(List<&2, String>, String.eq(receiver, "tools"),
        invocation_categories(method, commands, categories), categories))

def first_invocation(invocations: List<&2, ToolInvocation>) -> ToolInvocation:
  match invocations:
    case []: Invocation{"", "", []}
    case +call <> tail:
      match call:
        case Invocation{receiver, method, commands}:
          Bool.pick(ToolInvocation, String.eq(receiver, "tools"), call, first_invocation(tail))

def has_parallel(invocations: List<&2, ToolInvocation>) -> Bool:
  match invocations:
    case []: False{}
    case Invocation{receiver, +method, commands} <> tail:
      Bool.or(Bool.and(String.eq(receiver, "Promise"),
        Bool.or(String.eq(method, "all"), String.eq(method, "allSettled"))), has_parallel(tail))

def joined_categories(categories: List<&2, String>, fallback: String) -> String:
  match categories:
    case []: fallback
    case head <> []: head
    case head <> tail: String.append(head, String.append(" + ", joined_categories(tail, "")))

def tool_script(first: ToolInvocation, +wrapped: List<&2, ToolInvocation>) -> ToolContext:
  match first:
    case Invocation{receiver, +method, commands}:
      Tool{Bool.pick(String, has_parallel(wrapped), "Parallel tool script", tool_label(method, "Tool script")),
        Bool.pick(String, String.eq(method, "exec_command"), first_command(commands), ""),
        joined_categories(wrapped_categories(wrapped, []), "Unknown script"), True{}, False{}}

def tool(+name: String, +direct: List<&2, ShellCommand>, +wrapped: List<&2, ToolInvocation>) -> ToolContext:
  match name:
    case "exec": tool_script(first_invocation(wrapped), wrapped)
    case "wait": Tool{"Cell wait", "", "Cell wait", False{}, True{}}
    case "exec_command":
      Tool{"Shell command", first_command(direct), joined_categories(shell_categories(direct, []), "Unknown command"),
        False{}, False{}}
    case _:
      Tool{tool_label(name, "Other tool"), "", tool_label(name, "Unknown tool"), False{}, False{}}

def merged_at(opened: U32, +merged: U32, confirmed: Bool) -> U32:
  Bool.pick(U32, Bool.and(confirmed, ordered(opened, merged)), merged, 0)

def linux_main_source(+tag: String) -> String:
  Bool.pick(String, String.starts_with(tag, "linux-main-v2-"), String.drop(tag, 14n), "")

def linux_main_asset(state: String, name: String) -> Bool:
  Bool.and(String.eq(state, "uploaded"), String.ends_with(name, "-linux-x86_64.AppImage"))

def may_probe(asset_count: U32, published: U32, public_release: Bool, tag_matches: Bool) -> Bool:
  Bool.and(U32.is_eq(asset_count, 1), Bool.and(U32.is_ne(published, 0),
    Bool.and(public_release, tag_matches)))

type Point is Data:
  Time{s: U32, ms: U32}

def time_order(first: Point, last: Point) -> Bool:
  match first last:
    case Time{a, am} Time{b, bm}: interval_ms(a, am, b, bm)

def has_time(point: Point) -> Bool:
  match point:
    case Time{s, ms}: U32.is_ne(s, 0)

def reasoning(event: String, point: Point) -> Bool:
  Bool.and(String.eq(event, "reasoning"), has_time(point))

def is_turn_boundary(+kind: String) -> Bool:
  Bool.or(Bool.or(String.eq(kind, "task_started"), String.eq(kind, "task_complete")),
    Bool.or(String.eq(kind, "turn_aborted"), Bool.or(String.eq(kind, "user_message"), String.eq(kind, "agent_message"))))

def model_wait_input(previous: String, +envelope: String, +kind: String, call_id: String) -> String:
  Bool.pick(String, Bool.and(String.eq(envelope, "response_item"),
    Bool.or(String.eq(kind, "function_call_output"), String.eq(kind, "custom_tool_call_output"))), call_id,
    Bool.pick(String, Bool.and(String.eq(envelope, "event_msg"), Bool.not(is_turn_boundary(kind))), previous, ""))

type CallState is Data:
  Unseen{orphans: U32}
  Seen{orphans: U32, line: U32, tool: ToolContext, start: Point, finish: Point, target: String, cell: String, terminal: Bool, ambiguous: Bool}

def start_call(state: CallState, line: U32, observed: ToolContext, start: Point, target: String) -> CallState:
  match state:
    case Unseen{orphans}:
      Seen{orphans, line, observed, start, Time{0, 0}, target, "", False{}, False{}}
    case Seen{orphans, old_line, tool, old_start, finish, old_target, cell, terminal, ambiguous}:
      Seen{orphans, old_line, tool, old_start, finish, old_target, cell, terminal, True{}}

def finish_seen(+accept: Bool, orphans: U32, line: U32, observed: ToolContext, start: Point, finish: Point,
  target: String, cell: String, terminal: Bool, ambiguous: Bool, ended: Point,
  yielded: String, completed: Bool) -> CallState:
  match observed:
    case Tool{label, command, categories, +wrapper, +cell_wait}:
      Seen{orphans, line, Tool{label, command, categories, wrapper, cell_wait}, start, Bool.pick(Point, accept, ended, finish), target,
        Bool.pick(String, Bool.and(accept, wrapper), yielded, cell),
        Bool.or(terminal, Bool.and(accept, Bool.and(cell_wait, completed))),
        Bool.or(ambiguous, Bool.not(accept))}

def finish_call(state: CallState, +ended: Point, yielded: String, completed: Bool) -> CallState:
  match state:
    case Unseen{orphans}: Unseen{U32.inc(orphans)}
    case Seen{orphans, line, tool, +start, +finish, target, cell, terminal, ambiguous}:
      finish_seen(Bool.and(Bool.not(has_time(finish)), time_order(start, ended)), orphans, line,
        tool, start, finish, target, cell, terminal, ambiguous, ended, yielded, completed)

type CellFact is Data:
  NoCell{}
  Launch{key: String, owner: String, yielded_at: Point, valid: Bool}
  Terminal{key: String, call_id: String, started_at: Point, ended_at: Point, valid: Bool}

def pick_cell(+id: String, +cell: String, +target: String, +finish: Point, start: Point, +valid: Bool, terminal: Bool) -> CellFact:
  Bool.pick(CellFact, String.eq(cell, ""), Bool.pick(CellFact, Bool.and(terminal, Bool.not(String.eq(target, ""))),
    Terminal{target, id, start, finish, valid}, NoCell{}), Launch{cell, id, finish, valid})

def cell_fact(id: String, state: CallState) -> CellFact:
  match state:
    case Unseen{orphans}: NoCell{}
    case Seen{orphans, line, tool, start, finish, target, cell, terminal, ambiguous}:
      pick_cell(id, cell, target, finish, start, Bool.not(ambiguous), terminal)

type CellPair is Data:
  Pair{launch: CellFact, terminal: CellFact, duplicate: Bool}

def add_cell_fact(pair: CellPair, +fact: CellFact) -> CellPair:
  match pair fact:
    case Pair{NoCell{}, terminal, duplicate} Launch{key, owner, yielded_at, valid}:
      Pair{Launch{key, owner, yielded_at, valid}, terminal, duplicate}
    case Pair{launch, NoCell{}, duplicate} Terminal{key, call_id, started_at, ended_at, valid}:
      Pair{launch, Terminal{key, call_id, started_at, ended_at, valid}, duplicate}
    case Pair{launch, terminal, duplicate} _:
      Pair{launch, terminal, True{}}

type CellLink is Data:
  Unlinked{}
  Linked{owner: String, call_id: String, end: Point}

def cell_link(pair: CellPair, malformed: U32) -> CellLink:
  match pair:
    case Pair{Launch{key, owner, yielded_at, launch_valid}, Terminal{target, call_id, started_at, ended_at, end_valid}, False{}}:
      Bool.pick(CellLink, Bool.and(U32.is_eq(malformed, 0), Bool.and(launch_valid, Bool.and(end_valid, time_order(yielded_at, started_at)))),
        Linked{owner, call_id, ended_at}, Unlinked{})
    case _: Unlinked{}

type CallRecord is Data:
  Ignored{orphans: U32}
  Observed{orphans: U32, line: U32, tool: String, command: String, categories: String, start: Point, finish: Point, launched: Bool, ambiguous: Bool}

def call_record(state: CallState) -> CallRecord:
  match state:
    case Unseen{orphans}: Ignored{orphans}
    case Seen{orphans, line, Tool{label, command, categories, wrapper, cell_wait}, start, finish, target, cell, terminal, +ambiguous}:
      Observed{orphans, line, label, command, categories, start, Bool.pick(Point, ambiguous, Time{0, 0}, finish),
        Bool.not(String.eq(cell, "")), ambiguous}

type Milestone is Data:
  Milestone{id: String, at: U32}

def earlier_milestone(+best: Milestone, +next: Milestone, best_at: U32, next_at: U32, unset: Bool) -> Milestone:
  Bool.pick(Milestone, Bool.or(unset, U32.is_lt(next_at, best_at)), next, best)

def pick_milestone(+best: Milestone, +next: Milestone) -> Milestone:
  match best next:
    case Milestone{+a, +best_at} Milestone{b, +next_at}:
      earlier_milestone(Milestone{a, best_at}, Milestone{b, next_at}, best_at, next_at, String.eq(a, ""))

def pick_review(+best: Milestone, +next: Milestone, opened: U32) -> Milestone:
  match next:
    case Milestone{id, +at}:
      Bool.pick(Milestone, ordered(opened, at), pick_milestone(best, next), best)

def commit_complete(expected: U32, observed: U32) -> Bool:
  U32.is_eq(expected, observed)

def pr_ci_start(event: String, status: String, +conclusion: String, attempt: U32, matched: Bool,
  opened: U32, +started: U32, merged: U32) -> Bool:
  Bool.and(Bool.and(String.eq(event, "pull_request"), U32.is_eq(attempt, 1)),
    Bool.and(Bool.or(String.eq(status, "in_progress"),
      Bool.or(String.eq(conclusion, "success"), String.eq(conclusion, "failure"))),
      Bool.and(matched, Bool.and(ordered(opened, started), ordered(started, merged)))))

def publishing_run(event: String, conclusion: String, +created: U32, +published: U32, updated: U32,
  source_matches: Bool, run_matches: Bool) -> Bool:
  Bool.and(Bool.and(String.eq(event, "workflow_dispatch"), String.eq(conclusion, "success")),
    Bool.and(Bool.and(source_matches, run_matches), Bool.and(ordered(created, published), ordered(published, updated))))

def keep_commit(complete: Bool, milestone: Milestone) -> Bool:
  match milestone:
    case Milestone{id, at}: Bool.and(complete, Bool.and(U32.is_ne(at, 0), Bool.not(String.eq(id, ""))))

type ReleaseOrder is Data:
  Release{published: U32, checked: U32, id: String, index: U32}

def release_before(a: ReleaseOrder, b: ReleaseOrder) -> Bool:
  match a b:
    case Release{+ap, +ac, aid, ai} Release{+bp, +bc, bid, bi}:
      Bool.and(U32.is_ne(ap, 0), Bool.or(U32.is_eq(bi, 0),
        Bool.or(U32.is_lt(ap, bp), Bool.and(U32.is_eq(ap, bp),
          Bool.or(U32.is_lt(ac, bc), Bool.and(U32.is_eq(ac, bc), String.is_lt(aid, bid)))))))

def pick_release(+best: ReleaseOrder, +next: ReleaseOrder, eligible: Bool) -> ReleaseOrder:
  Bool.pick(ReleaseOrder, Bool.and(eligible, release_before(next, best)), next, best)

def release_eligible(shipped: Bool, proof_merge: String, current_merge: String) -> Bool:
  Bool.and(shipped, String.eq(proof_merge, current_merge))

type Owners is Data:
  Owners{count: U32, s: U32, ms: U32}

def count_owner(state: Owners, owning: Bool, s: U32, ms: U32) -> Owners:
  match state owning:
    case Owners{0, previous_s, previous_ms} True{}: Owners{1, s, ms}
    case Owners{count, previous_s, previous_ms} True{}: Owners{U32.inc(count), 0, 0}
    case _ False{}: state
