import Base
import ./repository.bend as Repository

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

def bounded_title(within_limit: Bool, value: String) -> String:
  match within_limit:
    case True{}: String.trim(value)
    case False{}: ""

def source_title(+value: String) -> String:
  bounded_title(Nat.is_le(String.length(value), 512n), value)

def poll_pr_needed(+updated: U32, +stored: U32, listed_title: String, saved_title: String) -> Bool:
  Bool.or(U32.is_gt(updated, stored), Bool.and(U32.is_eq(updated, stored),
    Bool.and(String.eq(saved_title, ""), Bool.not(String.eq(source_title(listed_title), "")))))

def poll_attempt_needed(updated: U32, stored: U32, status: String) -> Bool:
  Bool.or(U32.is_gt(updated, stored), Bool.not(String.eq(status, "completed")))

def poll_release_recorded(shipped: Bool, stored: String, source: String) -> Bool:
  Bool.and(shipped, same_revision(stored, source))

def proves_ancestry(base: String, merge_base: String, +expected: String, status: String) -> Bool:
  Bool.and(String.eq(status, "ahead"), Bool.and(String.eq(base, expected), String.eq(merge_base, expected)))

def asset_access(http_status: U32, bytes: U32, range_matches: Bool) -> Bool:
  Bool.and(range_matches, Bool.and(U32.is_eq(http_status, 206), U32.is_eq(bytes, 1)))

def shipping(merged: U32, +published: U32, checked: U32, ancestry: Bool, access: Bool) -> Bool:
  Bool.and(ancestry, Bool.and(access, Bool.and(ordered(merged, published), ordered(published, checked))))

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
  Invocation{receiver: String, method: String, commands: List<&2, ShellCommand>, printed: Bool, exact: List<&2, ShellCommand>, handle: String, read_only: Bool}

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
    case Invocation{receiver, method, commands, printed, exact, handle, read_only} <> tail:
      wrapped_categories(tail, Bool.pick(List<&2, String>, String.eq(receiver, "tools"),
        invocation_categories(method, commands, categories), categories))

def first_invocation(invocations: List<&2, ToolInvocation>) -> ToolInvocation:
  match invocations:
    case []: Invocation{"", "", [], False{}, [], "", False{}}
    case +call <> tail:
      match call:
        case Invocation{receiver, method, commands, printed, exact, handle, read_only}:
          Bool.pick(ToolInvocation, String.eq(receiver, "tools"), call, first_invocation(tail))

def has_parallel(invocations: List<&2, ToolInvocation>) -> Bool:
  match invocations:
    case []: False{}
    case Invocation{receiver, +method, commands, printed, exact, handle, read_only} <> tail:
      Bool.or(Bool.and(String.eq(receiver, "Promise"),
        Bool.or(String.eq(method, "all"), String.eq(method, "allSettled"))), has_parallel(tail))

def joined_categories(categories: List<&2, String>, fallback: String) -> String:
  match categories:
    case []: fallback
    case head <> []: head
    case head <> tail: String.append(head, String.append(" + ", joined_categories(tail, "")))

def tool_script(first: ToolInvocation, +wrapped: List<&2, ToolInvocation>) -> ToolContext:
  match first:
    case Invocation{receiver, +method, commands, printed, exact, handle, read_only}:
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

def poll_release_source(tag: String, published: U32, draft: Bool) -> String:
  Bool.pick(String, Bool.and(U32.is_ne(published, 0), Bool.not(draft)), linux_main_source(tag), "")

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

type RunClocks is Data:
  RunClocks{started: Point, completed: Point}

def t3_run_clocks(requested: Point, +started: Point, +completed: Point) -> RunClocks:
  +started_known = time_order(requested, started)
  RunClocks{Bool.pick(Point, started_known, started, Time{0, 0}),
    Bool.pick(Point, Bool.and(started_known, time_order(started, completed)), completed, Time{0, 0})}

def github_link(host: String) -> Bool:
  String.eq(host, "github.com")

def reasoning(event: String, point: Point) -> Bool:
  Bool.and(String.eq(event, "reasoning"), has_time(point))

def is_turn_boundary(+kind: String) -> Bool:
  Bool.or(Bool.or(String.eq(kind, "task_started"), String.eq(kind, "task_complete")),
    Bool.or(String.eq(kind, "turn_aborted"), Bool.or(String.eq(kind, "user_message"), String.eq(kind, "agent_message"))))

def tool_output(+kind: String) -> Bool:
  Bool.or(String.eq(kind, "function_call_output"), String.eq(kind, "custom_tool_call_output"))

def model_wait_input(previous: String, +envelope: String, +kind: String, call_id: String) -> String:
  Bool.pick(String, Bool.and(String.eq(envelope, "response_item"),
    tool_output(kind)), call_id,
    Bool.pick(String, Bool.and(String.eq(envelope, "event_msg"), Bool.not(is_turn_boundary(kind))), previous, ""))

type CallState is Data:
  Unseen{orphans: U32}
  Seen{orphans: U32, line: U32, tool: ToolContext, start: Point, finish: Point, result_line: U32, target: String,
    cell: String, terminal: Bool, ambiguous: Bool}

def start_call(state: CallState, line: U32, observed: ToolContext, start: Point, target: String) -> CallState:
  match state:
    case Unseen{orphans}:
      Seen{orphans, line, observed, start, Time{0, 0}, 0, target, "", False{}, False{}}
    case Seen{orphans, old_line, tool, old_start, finish, result_line, old_target, +cell, terminal, ambiguous}:
      Seen{orphans, old_line, tool, old_start, finish, result_line, old_target, cell, terminal, True{}}

def finish_call(state: CallState, line: U32, +ended: Point, yielded: String, completed: Bool) -> CallState:
  match state:
    case Unseen{orphans}: Unseen{U32.inc(orphans)}
    case Seen{orphans, opened, tool, +start, finish, result_line, target, +cell, terminal, ambiguous}:
      match result_line:
        case 0:
          Seen{orphans, opened, tool, start, ended, line, target, yielded, completed,
            Bool.or(ambiguous, Bool.not(time_order(start, ended)))}
        case _:
          Seen{orphans, opened, tool, start, finish, result_line, target, cell, terminal, True{}}

type CellFact is Data:
  NoCell{}
  Launch{key: String, owner: String, yielded_at: Point, yielded_line: U32, valid: Bool}
  Terminal{key: String, call_id: String, started_at: Point, started_line: U32, ended_at: Point, valid: Bool}

def cell_fact(+id: String, state: CallState) -> CellFact:
  match state:
    case Seen{orphans, line, Tool{label, command, categories, wrapper, wait}, +start, +finish, result_line,
      +target, +cell, terminal, ambiguous}:
      +valid = Bool.and(Bool.not(ambiguous), U32.is_eq(orphans, 0))
      Bool.pick(CellFact, Bool.and(wrapper, Bool.not(String.eq(cell, ""))), Launch{cell, id, finish, result_line, valid},
        Bool.pick(CellFact, Bool.and(wait, Bool.and(terminal, Bool.not(String.eq(target, "")))),
          Terminal{target, id, start, line, finish, valid}, NoCell{}))
    case _: NoCell{}

type CellPair is Data:
  Pair{launch: CellFact, terminal: CellFact, duplicate: Bool}

def add_cell_fact(pair: CellPair, +fact: CellFact) -> CellPair:
  match pair fact:
    case Pair{NoCell{}, terminal, duplicate} Launch{key, owner, yielded_at, yielded_line, valid}:
      Pair{fact, terminal, duplicate}
    case Pair{launch, NoCell{}, duplicate} Terminal{key, call_id, started_at, +started_line, ended_at, valid}:
      Pair{launch, fact, duplicate}
    case Pair{launch, terminal, duplicate} _:
      Pair{launch, terminal, True{}}

def cell_order(yielded_at: Point, yielded_line: U32, started_at: Point, started_line: U32) -> Bool:
  Bool.and(U32.is_lt(yielded_line, started_line), time_order(yielded_at, started_at))

type CellLink is Data:
  Unlinked{}
  Linked{owner: String, call_id: String, end: Point}

def cell_link(pair: CellPair, clean: Bool) -> CellLink:
  match pair:
    case Pair{Launch{key, owner, yielded_at, yielded_line, launch_valid},
      Terminal{target, call_id, started_at, started_line, ended_at, end_valid}, False{}}:
      Bool.pick(CellLink, Bool.and(clean, Bool.and(launch_valid, Bool.and(end_valid,
        cell_order(yielded_at, yielded_line, started_at, started_line)))),
        Linked{owner, call_id, ended_at}, Unlinked{})
    case _: Unlinked{}

type WaitCell is Data:
  NotWait{}
  WaitCell{status: String, owner: String}

def before_cell_terminal(terminal: CellFact, line: U32, +result_line: U32, finish: Point) -> Bool:
  match terminal:
    case Terminal{target, call_id, started_at, +started_line, ended_at, valid}:
      Bool.and(valid, Bool.or(U32.is_eq(line, started_line),
        Bool.and(U32.is_ne(result_line, 0), cell_order(finish, result_line, started_at, started_line))))
    case _: True{}

def match_wait_cell(pair: CellPair, +line: U32, +result_line: U32, +start: Point, +finish: Point) -> WaitCell:
  match pair:
    case Pair{launch, terminal, True{}}: WaitCell{"ambiguous_cell", ""}
    case Pair{Launch{key, owner, yielded_at, yielded_line, valid}, terminal, False{}}:
      Bool.pick(WaitCell, Bool.and(valid, Bool.and(cell_order(yielded_at, yielded_line, start, line),
        before_cell_terminal(terminal, line, result_line, finish))),
        WaitCell{"linked_cell", owner}, WaitCell{"ambiguous_cell", ""})
    case _: WaitCell{"missing_cell_launch", ""}

def wait_cell(state: CallState, pair: CellPair, clean: Bool) -> WaitCell:
  match state:
    case Seen{orphans, line, Tool{label, command, categories, wrapper, True{}}, start, finish, result_line,
      +target, +cell, terminal, ambiguous}:
      Bool.pick(WaitCell, Bool.not(clean), WaitCell{"incomplete_rollout", ""},
        Bool.pick(WaitCell, String.eq(target, ""), WaitCell{"missing_cell_id", ""},
          Bool.pick(WaitCell, Bool.or(ambiguous, Bool.not(Bool.or(String.eq(cell, ""), String.eq(cell, target)))),
            WaitCell{"ambiguous_cell", ""}, match_wait_cell(pair, line, result_line, start, finish))))
    case _: NotWait{}

def clean_rollout(malformed: U32, orphans: U32) -> Bool:
  Bool.and(U32.is_eq(malformed, 0), U32.is_eq(orphans, 0))

type CallRecord is Data:
  Ignored{orphans: U32}
  Observed{orphans: U32, line: U32, tool: String, command: String, categories: String, start: Point, finish: Point,
    result_line: U32, launched: Bool, target: String, ambiguous: Bool}

def call_record(state: CallState) -> CallRecord:
  match state:
    case Unseen{orphans}: Ignored{orphans}
    case Seen{orphans, line, Tool{label, command, categories, wrapper, wait}, +start, +finish, result_line,
      target, cell, terminal, +ambiguous}:
      Observed{orphans, line, label, command, categories, start, Bool.pick(Point, ambiguous, Time{0, 0}, finish),
        result_line, Bool.and(wrapper, Bool.not(String.eq(cell, ""))), target, ambiguous}

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

def source_identity(+actual: String, expected: String) -> Bool:
  Bool.and(Bool.not(String.eq(actual, "")), String.eq(actual, expected))

def pr_identity(number: String, expected_number: String, repo: String, expected_repo: String) -> Bool:
  Bool.and(source_identity(number, expected_number), source_identity(repo, expected_repo))

def workflow_complete(expected: String, returned: String, size: U32, array_seen: Bool) -> Bool:
  Bool.and(array_seen, Bool.and(U32.is_le(size, 100), source_identity(expected, returned)))

def reviews_complete(size: U32) -> Bool:
  U32.is_lt(size, 100)

type PRTarget is Data:
  PRTarget{number: String, repo: String, fork: String, branch: String, opened: U32, merged: U32}

type PRLink is Data:
  PRLink{number: String, repo: String}

type WorkflowRun is Data:
  WorkflowRun{id: String, event: String, status: String, conclusion: String, attempt: String,
    repo: String, fork: String, branch: String, revision: String, links_known: Bool, links: List<&2, PRLink>, started: U32}

def search_pr_ci(target: PRTarget) -> Bool:
  match target:
    case PRTarget{number, repo, fork, branch, opened, merged}:
      Bool.and(ordered(opened, merged), Bool.and(Bool.not(String.eq(repo, "")), Bool.not(String.eq(branch, ""))))

def has_workflow_link(+number: String, +repo: String, links: List<&2, PRLink>) -> Bool:
  match links:
    case []: False{}
    case PRLink{linked_number, linked_repo} <> rest:
      Bool.or(pr_identity(linked_number, number, linked_repo, repo), has_workflow_link(number, repo, rest))

def has_revision(+revision: String, revisions: List<&2, String>) -> Bool:
  match revisions:
    case []: False{}
    case head <> rest:
      Bool.or(source_identity(revision, head), has_revision(revision, rest))

def pr_run_matches(target: PRTarget, run: WorkflowRun, revisions: List<&2, String>, complete: Bool) -> Bool:
  match target run:
    case PRTarget{number, +base, head, branch, opened, merged}
         WorkflowRun{id, event, status, conclusion, attempt, repo, fork, ref, revision, links_known, links, started}:
      match links:
        case []:
          Bool.and(links_known, Bool.and(complete,
            Bool.and(pr_identity(repo, base, fork, head), Bool.and(source_identity(ref, branch), has_revision(revision, revisions)))))
        case _:
          Bool.and(links_known, has_workflow_link(number, base, links))

def workflow_start(+target: PRTarget, +run: WorkflowRun, revisions: List<&2, String>, complete: Bool, +best: Milestone) -> Milestone:
  match target run:
    case PRTarget{number, base, head, ref, opened, merged}
         WorkflowRun{+id, event, status, conclusion, attempt, repo, fork, branch, revision, links_known, links, +started}:
      Bool.pick(Milestone, pr_ci_start(event, status, conclusion,
        Bool.pick(U32, String.eq(attempt, "1"), 1, 0), pr_run_matches(target, run, revisions, complete), opened, started, merged),
        pick_milestone(best, Milestone{id, started}), best)

def no_milestone() -> Milestone:
  Milestone{"", 4294967295}

type MilestoneInventory is Data:
  Inventory{best: Milestone, seen: Map<&2, Bool>}
  Ambiguous{}

def take_milestone(id: String, best: Milestone, found: Map<&2, Bool> & Bool) -> MilestoneInventory:
  match id found:
    case "" _: Ambiguous{}
    case _ Tuple{seen, True{}}: Ambiguous{}
    case _ Tuple{seen, False{}}: Inventory{best, Map.set(&2, Bool, seen, id, True{})}

def observe_workflow(inventory: MilestoneInventory, +run: WorkflowRun, target: PRTarget,
  revisions: List<&2, String>, complete: Bool) -> MilestoneInventory:
  match inventory run:
    case Inventory{best, seen} WorkflowRun{+id, event, status, conclusion, attempt, repo, fork, branch, revision, links_known, links, started}:
      take_milestone(id, workflow_start(target, run, revisions, complete, best), Map.has(&2, Bool, seen, id))
    case _ _: Ambiguous{}

def workflow_milestone(inventory: MilestoneInventory) -> Milestone:
  match inventory:
    case Inventory{best, seen}: best
    case Ambiguous{}: no_milestone()

def scan_pr_workflows(runs: List<&2, WorkflowRun>, +target: PRTarget, +revisions: List<&2, String>, +complete: Bool,
  inventory: MilestoneInventory) -> Milestone:
  match runs:
    case []: workflow_milestone(inventory)
    case run <> rest:
      scan_pr_workflows(rest, target, revisions, complete, observe_workflow(inventory, run, target, revisions, complete))

def first_pr_workflow(runs: List<&2, WorkflowRun>, target: PRTarget, revisions: List<&2, String>, complete: Bool) -> Milestone:
  scan_pr_workflows(runs, target, revisions, complete, Inventory{no_milestone(), Map.new(&2, Bool)})

type DispatchRun is Data:
  DispatchRun{id: String, event: String, conclusion: String, title: String, created: U32, updated: U32}

def publishing_title(+title: String, source: String, +id: String) -> Bool:
  +expected = String.concat(["main · source ", source, " · candidate run ", id])
  Bool.and(Bool.not(String.eq(id, "")),
    Bool.or(String.eq(title, expected), String.starts_with(title, String.append(expected, " ·"))))

def keep_dispatch(best: Milestone, next: Milestone, eligible: Bool, updated: Map<&2, Bool>) -> MilestoneInventory:
  match best eligible:
    case _ False{}: Inventory{best, updated}
    case Milestone{"", before} True{}: Inventory{next, updated}
    case _ _: Ambiguous{}

def add_dispatch(best: Milestone, next: Milestone, eligible: Bool, found: Map<&2, Bool> & Bool) -> MilestoneInventory:
  match next found:
    case Milestone{"", at} _: Ambiguous{}
    case _ Tuple{seen, True{}}: Ambiguous{}
    case Milestone{+id, at} Tuple{seen, False{}}:
      keep_dispatch(best, Milestone{id, at}, eligible, Map.set(&2, Bool, seen, id, True{}))

def observe_dispatch(inventory: MilestoneInventory, run: DispatchRun, source: String, published: U32) -> MilestoneInventory:
  match inventory run:
    case Inventory{best, seen} DispatchRun{+id, event, conclusion, title, +created, updated}:
      add_dispatch(best, Milestone{id, created}, publishing_run(event, conclusion, created, published, updated,
        publishing_title(title, source, id), True{}), Map.has(&2, Bool, seen, id))
    case _ _: Ambiguous{}

def scan_dispatch(runs: List<&2, DispatchRun>, +source: String, +published: U32, inventory: MilestoneInventory) -> Milestone:
  match runs:
    case []: workflow_milestone(inventory)
    case run <> rest: scan_dispatch(rest, source, published, observe_dispatch(inventory, run, source, published))

def release_dispatch(runs: List<&2, DispatchRun>, source: String, published: U32) -> Milestone:
  scan_dispatch(runs, source, published, Inventory{no_milestone(), Map.new(&2, Bool)})

type CommitObservation is Data:
  CommitObservation{complete: Bool, first: Milestone}

type CommitInventory is Data:
  Commits{count: U32, selection: MilestoneInventory}

def observe_commit(inventory: CommitInventory, +commit: Milestone) -> CommitInventory:
  match inventory commit:
    case Commits{count, Inventory{best, seen}} Milestone{+id, at}:
      Commits{U32.inc(count), take_milestone(id, pick_milestone(best, commit), Map.has(&2, Bool, seen, id))}
    case _ _: Commits{0, Ambiguous{}}

def commit_observation(expected: String, inventory: CommitInventory) -> CommitObservation:
  match inventory:
    case Commits{count, Inventory{+best, seen}}:
      +complete = String.eq(expected, U32.show(count))
      CommitObservation{complete, Bool.pick(Milestone, keep_commit(complete, best), best, no_milestone())}
    case _: CommitObservation{False{}, no_milestone()}

def pr_commits(expected: String, commits: List<&2, Milestone>) -> CommitObservation:
  commit_observation(expected, List.foldl(~&2, ~Milestone, ~CommitInventory,
    ~(state => commit => observe_commit(state, commit)), commits, Commits{0, Inventory{no_milestone(), Map.new(&2, Bool)}}))

type ReviewObservation is Data:
  ReviewObservation{complete: Bool, first: Milestone}

def earliest_review(reviews: List<&2, Milestone>, +opened: U32, count: U32, best: Milestone) -> ReviewObservation:
  match reviews:
    case []: ReviewObservation{reviews_complete(count), best}
    case review <> rest: earliest_review(rest, opened, U32.inc(count), pick_review(best, review, opened))

def pr_reviews(reviews: List<&2, Milestone>, opened: U32) -> ReviewObservation:
  earliest_review(reviews, opened, 0, no_milestone())

def same_tag(observed: String, requested: String) -> Bool:
  source_identity(observed, requested)

def tag_matches(kind: String, revision: String, source: String) -> Bool:
  Bool.and(String.eq(kind, "commit"), source_identity(revision, source))

def ancestry_request(+merge: String, source: String, tag_verified: Bool) -> String:
  Bool.pick(String, Bool.and(tag_verified, Bool.not(String.eq(merge, ""))),
    Bool.pick(String, same_revision(merge, source), "equal", "compare"), "unknown")

def ancestry_result(base: String, merge_base: String, expected: String, status: String) -> String:
  Bool.pick(String, proves_ancestry(base, merge_base, expected, status), "ancestor", "unproven")

def release_shipped(merged: U32, published: U32, checked: U32, +ancestry: String, access: Bool) -> Bool:
  shipping(merged, published, checked, Bool.or(String.eq(ancestry, "equal"), String.eq(ancestry, "ancestor")), access)

type ReleaseAsset is Data:
  ReleaseAsset{index: U32, state: String, name: String}

def asset_chars(name: String) -> Bool:
  match name:
    case SNil{}: True{}
    case SCon{+c, tail}:
      Bool.and(Bool.or(Char.is_alpha(c), Bool.or(Char.is_digit(c),
        Bool.or(Char.is_eq(c, '.'), Bool.or(Char.is_eq(c, '_'), Bool.or(Char.is_eq(c, '+'), Char.is_eq(c, '-')))))), asset_chars(tail))

type AssetSelection is Data:
  Candidate{index: U32}
  Competing{}

def consider_asset(selection: AssetSelection, index: U32, eligible: Bool) -> AssetSelection:
  match selection eligible:
    case Candidate{0} True{}: Candidate{index}
    case _ True{}: Competing{}
    case _ False{}: selection

def select_asset(selection: AssetSelection, asset: ReleaseAsset) -> AssetSelection:
  match asset:
    case ReleaseAsset{index, state, +name}:
      consider_asset(selection, index, Bool.and(linux_main_asset(state, name), asset_chars(name)))

type AssetChoice is Data:
  AssetChoice{index: U32, probe: Bool}

def asset_choice(selection: AssetSelection, published: U32, public_release: Bool, verified: Bool) -> AssetChoice:
  match selection:
    case Competing{}: AssetChoice{0, False{}}
    case Candidate{+index}:
      AssetChoice{index, may_probe(Bool.pick(U32, U32.is_ne(index, 0), 1, 0), published, public_release, verified)}

def choose_asset(assets: List<&2, ReleaseAsset>, published: U32, public_release: Bool, verified: Bool) -> AssetChoice:
  asset_choice(List.foldl(~&2, ~ReleaseAsset, ~AssetSelection, ~select_asset, assets, Candidate{0}), published, public_release, verified)

def range_matches(header: String, size: String) -> Bool:
  String.eq(header, String.append("content-range: bytes 0-0/", size))

def rollout_timestamp(original: Point, envelope: Point) -> Point:
  match original:
    case Time{0, 0}: envelope
    case _: original

def rollout_session(+previous: String, observed: String) -> Bool:
  Bool.or(String.eq(previous, ""), String.eq(previous, observed))

def rollout_event(+kind: String) -> String:
  Bool.pick(String, Bool.or(String.eq(kind, "function_call"), String.eq(kind, "custom_tool_call")), "start",
    Bool.pick(String, tool_output(kind), "finish", ""))

def all_digits(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: True{}
    case head <> tail: Bool.and(Char.is_digit(head), all_digits(tail))

def decimal(+value: String) -> Bool:
  Bool.and(Bool.not(String.is_empty(value)), Bool.and(Bool.not(String.starts_with(value, "0")),
    all_digits(String.to_list(value))))

type PrintedOutput is Data:
  PrintedOutput{statement: String, call: String, printer: String, args: U32, optional: Bool}

def prints_result(output: PrintedOutput) -> Bool:
  match output:
    case PrintedOutput{"expression_statement", "call_expression", "text", 1, False{}}: True{}
    case _: False{}

type BindingSyntax is Data:
  BindingSyntax{declaration: String, count: U32, kind: String, name: String}

def bound_result(binding: BindingSyntax, kind: String, name: String) -> Bool:
  match binding kind:
    case BindingSyntax{"lexical_declaration", 1, "identifier", bound} "identifier": String.eq(bound, name)
    case _ _: False{}

def printed_process(+statements: U32, output: PrintedOutput, binding: BindingSyntax, kind: String, name: String) -> Bool:
  Bool.and(prints_result(output), Bool.or(U32.is_eq(statements, 1),
    Bool.and(U32.is_eq(statements, 2), bound_result(binding, kind, name))))

def literal_kind(kind: String) -> Bool:
  Bool.not(String.eq(label(kind, ["string", "template_string", "number", "true", "false", "null"]), "unknown"))

def literal_fields(fields: List<&2, String>) -> Bool:
  Bool.not(List.any(~&2, ~String, ~(kind => Bool.not(literal_kind(kind))), fields))

def awaited_process(awaited: String, call: String, +callee: String, arity: U32, optional: Bool,
  +fields: List<&2, String>, poll: Bool) -> Bool:
  match awaited call arity optional:
    case "await_expression" "call_expression" 1 False{}:
      Bool.and(Bool.or(String.eq(callee, "tools.write_stdin"), Bool.and(Bool.not(poll), String.eq(callee, "tools.exec_command"))),
        Bool.and(Bool.not(List.is_empty(&2, String, fields)), literal_fields(fields)))
    case _ _ _ _: False{}

def loop_digits(bounded: Bool, +value: String) -> Bool:
  match bounded:
    case True{}: Bool.or(String.eq(value, "0"), decimal(value))
    case False{}: False{}

def loop_count(kind: String, +value: String) -> Bool:
  loop_digits(Bool.and(String.eq(kind, "number"), Nat.is_le(String.length(value), 3n)), value)

def identifier_char(+char: Char) -> Bool:
  Bool.or(Char.is_alpha(char), Bool.or(Char.is_digit(char), Char.is_eq(char, '_')))

def identifier_rest(name: String, valid: Bool) -> Bool:
  match name valid:
    case _ False{}: False{}
    case SNil{} True{}: True{}
    case SCon{head, tail} True{}: identifier_rest(tail, identifier_char(head))

def loop_index(name: String) -> Bool:
  match name:
    case SNil{}: False{}
    case SCon{+head, rest}:
      identifier_rest(rest, Bool.or(Char.is_alpha(head), Char.is_eq(head, '_')))

def last_iteration(value: Maybe<&2, U32>) -> String:
  match value:
    case Some{0}: "-1"
    case Some{count}: U32.show(U32.sub(count, 1))
    case None{}: ""

def loop_stop(+stop: String, index: String, ceiling: String, result: String) -> Bool:
  +closed = String.concat(["(!", result, ".session_id"])
  Bool.or(String.eq(stop, String.append(closed, ")")),
    String.eq(stop, String.concat([closed, "||", index, "===", last_iteration(U32.read(ceiling)), ")"])))

type PollLoop is Data:
  PollLoop{kind: String, initial_kind: String, initial: String, ceiling_kind: String, ceiling: String,
    condition: String, increment: String, body: String, statements: U32, branch: String, alternative: Bool,
    stop: String, consequence: String, actions: U32, exit: String, exit_args: U32, output_kind: String, output_name: String}

def loop_shape(+kind: String, body: String, statements: U32, branch: String, alternative: Bool,
  consequence: String, actions: U32, exit: String, exit_args: U32) -> Bool:
  Bool.and(String.eq(kind, "for_statement"), Bool.and(String.eq(body, "statement_block"),
    Bool.and(U32.is_eq(statements, 2), Bool.and(String.eq(branch, "if_statement"), Bool.and(Bool.not(alternative),
      Bool.and(String.eq(consequence, "statement_block"), Bool.and(U32.is_eq(actions, 2),
        Bool.and(String.eq(exit, "break_statement"), U32.is_eq(exit_args, 0)))))))))

def loop_bounds(initial_kind: String, initial: String, ceiling_kind: String, +ceiling: String,
  condition: String, increment: String, +i: String) -> Bool:
  Bool.and(loop_index(i), Bool.and(loop_count(initial_kind, initial), Bool.and(loop_count(ceiling_kind, ceiling),
    Bool.and(String.eq(condition, String.concat([i, "<", ceiling])), String.eq(increment, String.append(i, "++"))))))

def poll_loop(loop: PollLoop, index: BindingSyntax, +result: BindingSyntax, output: PrintedOutput) -> Bool:
  match loop index:
    case PollLoop{kind, initial_kind, initial, ceiling_kind, +ceiling, condition, increment,
      body, statements, branch, alternative, stop, consequence, actions, exit, exit_args, output_kind, +printed}
      BindingSyntax{"lexical_declaration", 1, "identifier", +i}:
      Bool.and(prints_result(output), Bool.and(bound_result(result, output_kind, printed),
        Bool.and(Bool.not(String.eq(i, printed)), Bool.and(loop_bounds(initial_kind, initial, ceiling_kind, ceiling, condition, increment, i),
          Bool.and(loop_shape(kind, body, statements, branch, alternative, consequence, actions, exit, exit_args),
            loop_stop(stop, i, ceiling, printed))))))
    case _ _: False{}

type ShellSyntax is Data:
  OtherShell{}
  ShellLiteral{command: ShellCommand, nested_kinds: List<&2, String>}
  ShellBinary{operators: List<&2, String>, left: ShellSyntax, right: ShellSyntax}

def substitution(+kind: String) -> Bool:
  Bool.or(String.eq(kind, "command_substitution"), String.eq(kind, "process_substitution"))

def has_substitution(kinds: List<&2, String>) -> Bool:
  List.any(~&2, ~String, ~(kind => substitution(kind)), kinds)

def append_shell(left: List<&2, ShellCommand>, right: List<&2, ShellCommand>) -> List<&2, ShellCommand>:
  match left right:
    case Nil{} _: []
    case _ Nil{}: []
    case _ _: List.append(&2, ShellCommand, left, right)

def sequential_commands(syntax: ShellSyntax) -> List<&2, ShellCommand>:
  match syntax:
    case OtherShell{}: []
    case ShellLiteral{command, kinds}:
      Bool.pick(List<&2, ShellCommand>, has_substitution(kinds), [], [command])
    case ShellBinary{Con{"&&", Nil{}}, left, right}:
      append_shell(sequential_commands(left), sequential_commands(right))
    case _: []

def sequential_shell(statements: U32, syntax: ShellSyntax) -> List<&2, ShellCommand>:
  Bool.pick(List<&2, ShellCommand>, U32.is_eq(statements, 1), sequential_commands(syntax), [])

type ExactShell is Data:
  ExactShell{kind: String, command: ShellCommand, nested: List<&2, String>, redirects: List<&2, String>}

def bad_shell_node(+kind: String) -> Bool:
  Bool.or(substitution(kind), Bool.or(String.eq(kind, "variable_assignment"),
    Bool.or(String.eq(kind, "heredoc_redirect"), String.eq(kind, "herestring_redirect"))))

def bad_redirect(+text: String) -> Bool:
  Bool.not(Bool.or(String.starts_with(text, ">"), Bool.or(String.starts_with(text, "1>"), String.starts_with(text, "2>"))))

def exact_statements(statements: List<&2, ExactShell>, remaining: U32, kept: List<&2, ShellCommand>) -> List<&2, ShellCommand>:
  match statements remaining:
    case [] _: List.reverse(&2, ShellCommand, kept)
    case _ 0: []
    case ExactShell{"command", command, nested, redirects} <> tail _:
      Bool.pick(List<&2, ShellCommand>,
        Bool.or(List.any(~&2, ~String, ~(node => bad_shell_node(node)), nested), List.any(~&2, ~String, ~(redirect => bad_redirect(redirect)), redirects)),
        [], exact_statements(tail, U32.sub(remaining, 1), command <> kept))
    case _ _: []

def exact_shell(separators: List<&2, String>, statements: List<&2, ExactShell>) -> List<&2, ShellCommand>:
  Bool.pick(List<&2, ShellCommand>, List.any(~&2, ~String, ~(kind => Bool.not(String.eq(kind, ";"))), separators),
    [], exact_statements(statements, 3, []))

type ReasoningMarker is Data:
  Marker{line: U32, observed: Point, input: String}

type RolloutMetadata is Data:
  RolloutMetadata{session: String, malformed: U32, previous: String, newest_markers: List<&2, ReasoningMarker>}

type MetadataStep is Data:
  MetadataStep{state: RolloutMetadata, action: String}

def empty_rollout_metadata() -> RolloutMetadata:
  RolloutMetadata{"", 0, "", []}

def rollout_bad_line(meta: RolloutMetadata) -> RolloutMetadata:
  match meta:
    case RolloutMetadata{session, malformed, previous, markers}:
      RolloutMetadata{session, U32.inc(malformed), previous, markers}

def rollout_clear_result(meta: RolloutMetadata, session: String) -> RolloutMetadata:
  match meta:
    case RolloutMetadata{old, malformed, previous, markers}: RolloutMetadata{session, malformed, "", markers}

def rollout_markers(meta: RolloutMetadata) -> List<&2, ReasoningMarker>:
  match meta:
    case RolloutMetadata{session, malformed, previous, markers}: List.reverse(&2, ReasoningMarker, markers)

def record_metadata(known_session: Bool, call_event: Bool, valid_id: Bool, mark: Bool,
  action: String, line: U32, observed: Point, previous: String, meta: RolloutMetadata) -> MetadataStep:
  match known_session call_event valid_id mark meta:
    case False{} _ _ _ _: MetadataStep{rollout_bad_line(meta), ""}
    case True{} True{} False{} _ _: MetadataStep{rollout_bad_line(meta), ""}
    case True{} _ _ True{} RolloutMetadata{session, malformed, input, markers}:
      MetadataStep{RolloutMetadata{session, malformed, input, Marker{line, observed, previous} <> markers}, action}
    case _ _ _ _ _: MetadataStep{meta, action}

def record_response(+action: String, known_session: Bool, valid_id: Bool, kind: String, line: U32,
  +observed: Point, previous: String, meta: RolloutMetadata) -> MetadataStep:
  record_metadata(known_session, Bool.not(String.eq(action, "")), valid_id, reasoning(kind, observed),
    action, line, observed, previous, meta)

def call_id_chars(id: String) -> Bool:
  match id:
    case SNil{}: True{}
    case SCon{+c, rest}:
      Bool.and(Bool.or(Char.is_alpha(c), Bool.or(Char.is_digit(c),
        Bool.or(Char.is_eq(c, '_'), Bool.or(Char.is_eq(c, ':'), Char.is_eq(c, '-'))))), call_id_chars(rest))

def valid_call_id(+id: String) -> Bool:
  Bool.and(Bool.not(String.eq(id, "")), call_id_chars(id))

type RolloutEnvelope is Data:
  SessionMetadata{}
  ResponseItem{}
  OtherEnvelope{}

def record_envelope(route: RolloutEnvelope, meta: RolloutMetadata, +envelope: String, +kind: String, +id: String,
  +observed_session: String, line: U32, observed: Point) -> MetadataStep:
  match route meta:
    case SessionMetadata{} RolloutMetadata{+session, malformed, previous, markers}:
      MetadataStep{RolloutMetadata{observed_session, malformed, "", markers},
        Bool.pick(String, rollout_session(session, observed_session), "", "conflict")}
    case ResponseItem{} RolloutMetadata{+session, malformed, +previous, markers}:
      +valid_id = valid_call_id(id)
      record_response(rollout_event(kind), Bool.not(String.eq(session, "")), valid_id, kind, line, observed, previous,
        RolloutMetadata{session, malformed, model_wait_input(previous, envelope, kind, Bool.pick(String, valid_id, id, "")), markers})
    case OtherEnvelope{} RolloutMetadata{session, malformed, previous, markers}:
      MetadataStep{RolloutMetadata{session, malformed, model_wait_input(previous, envelope, kind, id), markers}, ""}

def rollout_metadata(meta: RolloutMetadata, +envelope: String, kind: String, id: String,
  observed_session: String, line: U32, observed: Point) -> MetadataStep:
  route = Bool.pick(RolloutEnvelope, String.eq(envelope, "session_meta"), SessionMetadata{},
    Bool.pick(RolloutEnvelope, String.eq(envelope, "response_item"), ResponseItem{}, OtherEnvelope{}))
  record_envelope(route, meta, envelope, kind, id, observed_session, line, observed)

type RolloutPhase is Data:
  AwaitingMetadata{}
  SingleSource{}
  ForkSource{}
  InvalidMetadata{}
  UnprovenFork{}
  ConflictingMetadata{}

type RolloutAdmission is Data:
  Gate{phase: RolloutPhase, session: String, parent: String, boundary: U32, inherited: U32, unassigned: U32, keep: Bool}

def rollout_admission() -> RolloutAdmission:
  Gate{AwaitingMetadata{}, "", "", 0, 0, 0, False{}}

def rollout_file_status(available: Bool, regular: Bool, empty: Bool, oversized: Bool) -> String:
  Bool.pick(String, available,
    Bool.pick(String, regular, Bool.pick(String, empty, "empty", Bool.pick(String, oversized, "oversized", "scan")), "not_regular"),
    "unavailable")

def rollout_header(+id: String, +parent: String, fork: String, shared: String, +boundary: U32, line: U32, ordinal_ok: Bool,
  +unassigned: U32) -> RolloutAdmission:
  match id boundary:
    case "" _: Gate{InvalidMetadata{}, "", "", 0, 0, unassigned, False{}}
    case _ 0: Gate{SingleSource{}, id, "", 0, 0, unassigned, False{}}
    case _ _:
      valid = Bool.and(ordinal_ok, Bool.and(U32.is_eq(line, 1), U32.is_gt(boundary, 1)))
      linked = Bool.and(String.eq(parent, fork), Bool.and(String.eq(parent, shared),
        Bool.and(Bool.not(String.eq(parent, "")), Bool.not(String.eq(parent, id)))))
      Bool.pick(RolloutAdmission, Bool.and(valid, linked), Gate{ForkSource{}, id, parent, boundary, 0, unassigned, False{}},
        Gate{UnprovenFork{}, "", "", 0, 0, unassigned, False{}})

def rollout_fork_line(+session: String, +parent: String, +boundary: U32, +inherited: U32, +unassigned: U32,
  +line: U32, ordinal_ok: Bool, +meta: Bool, id: String, shared: String, declares_fork: Bool) -> RolloutAdmission:
  embedded = U32.is_eq(line, 2)
  header_ok = Bool.pick(Bool, embedded, Bool.and(meta, Bool.and(String.eq(id, parent), Bool.and(String.eq(shared, parent), Bool.not(declares_fork)))), Bool.not(meta))
  +before = U32.is_le(line, boundary)
  valid = Bool.and(ordinal_ok, header_ok)
  Bool.pick(RolloutAdmission, valid,
    Gate{ForkSource{}, session, parent, boundary, Bool.pick(U32, before, U32.inc(inherited), inherited), unassigned,
      Bool.not(before)},
    Gate{UnprovenFork{}, session, parent, boundary, inherited, unassigned, False{}})

def add_if(+count: U32, test: Bool) -> U32:
  Bool.pick(U32, test, U32.inc(count), count)

def rollout_line(state: RolloutAdmission, +meta: Bool, +id: String, parent: String, fork: String, shared: String,
  +boundary: U32, line: U32, ordinal_ok: Bool, decoded: Bool) -> RolloutAdmission:
  match state:
    case Gate{AwaitingMetadata{}, _, _, _, _, +unassigned, _}:
      Bool.pick(RolloutAdmission, meta, rollout_header(id, parent, fork, shared, boundary, line, ordinal_ok, unassigned),
        Gate{AwaitingMetadata{}, "", "", 0, 0, add_if(unassigned, decoded), False{}})
    case Gate{SingleSource{}, +session, _, _, _, +unassigned, _}:
      same = Bool.and(String.eq(id, session), U32.is_eq(boundary, 0))
      Bool.pick(RolloutAdmission, Bool.and(meta, Bool.not(same)),
        Gate{ConflictingMetadata{}, session, "", 0, 0, unassigned, False{}},
        Gate{SingleSource{}, session, "", 0, 0, unassigned, Bool.not(meta)})
    case Gate{ForkSource{}, session, source_parent, start, inherited, unassigned, _}:
      rollout_fork_line(session, source_parent, start, inherited, unassigned, line, ordinal_ok, meta, id, shared, U32.is_ne(boundary, 0))
    case _: state

def rollout_status(state: RolloutAdmission, lines: U32, complete_read: Bool) -> String:
  match state complete_read:
    case _ False{}: "read_failed"
    case Gate{SingleSource{}, _, _, _, _, _, _} True{}: "admitted"
    case Gate{ForkSource{}, _, _, boundary, _, _, _} True{}:
      Bool.pick(String, U32.is_gt(lines, boundary), "admitted_fork_suffix", "unproven_fork")
    case Gate{AwaitingMetadata{}, _, _, _, _, _, _} True{}: "missing_metadata"
    case Gate{InvalidMetadata{}, _, _, _, _, _, _} True{}: "invalid_metadata"
    case Gate{UnprovenFork{}, _, _, _, _, _, _} True{}: "unproven_fork"
    case Gate{ConflictingMetadata{}, _, _, _, _, _, _} True{}: "conflicting_metadata"

type RolloutQuality is Data:
  Quality{missing_start: U32, missing_end: U32, missing_async_end: U32, ambiguous_calls: U32,
    mix_candidates: U32, mix_receipts: U32, mixed_calls: U32, mixed_without_receipt: U32}

def is_mix(candidate: CommandMix) -> Bool:
  match candidate:
    case Mix{_, _, _, _}: True{}
    case NoMix{}: False{}

def has_multiple_categories(parts: List<&2, String>) -> Bool:
  match parts:
    case _ <> _ <> _: True{}
    case _: False{}

def rollout_call_quality(state: RolloutQuality, start: Point, finish: Point, launched: Bool, async_end: Point,
  ambiguous: Bool, categories: String, candidate: CommandMix, +received: Bool) -> RolloutQuality:
  match state:
    case Quality{starts, ends, async_ends, conflicts, candidates, receipts, groups, gaps}:
      +mixed = has_multiple_categories(String.split(categories, '+'))
      Quality{add_if(starts, Bool.not(has_time(start))), add_if(ends, Bool.not(has_time(finish))),
        add_if(async_ends, Bool.and(launched, Bool.not(has_time(async_end)))), add_if(conflicts, ambiguous),
        add_if(candidates, is_mix(candidate)), add_if(receipts, received),
        add_if(groups, mixed), add_if(gaps, Bool.and(mixed, Bool.not(received)))}

def rollout_admitted(+status: String) -> Bool:
  Bool.or(String.eq(status, "admitted"), String.eq(status, "admitted_fork_suffix"))

type RolloutClocks is Data:
  Clocks{first: Point, last: Point}

def rollout_clock(clocks: RolloutClocks, +at: Point) -> RolloutClocks:
  match clocks:
    case Clocks{+first, +last}:
      Clocks{Bool.pick(Point, Bool.or(Bool.not(has_time(at)), time_order(first, at)), first, at),
        Bool.pick(Point, time_order(last, at), at, Bool.pick(Point, has_time(last), last, at))}

def rollout_pairing_gaps(malformed: U32, oversized: U32, cutoff: U32, unassigned: U32) -> U32:
  U32.add(U32.add(malformed, oversized), U32.add(cutoff, unassigned))

def delivery_thread_link(owner_count: U32, link_count: U32, start: Point, opened: Point) -> String:
  match owner_count link_count:
    case 0 0: "no_link"
    case 0 _: "no_owning_link"
    case 1 _: Bool.pick(String, time_order(start, opened), "verified", "thread_clock_conflict")
    case _ _: "ambiguous_owner"

def proof_matches_merge(+proof_merge: String, current_merge: String) -> Bool:
  Bool.and(Bool.not(String.eq(proof_merge, "")), String.eq(proof_merge, current_merge))

def delivery_release_link(selected: Bool, has_proof: Bool, matching_merge: Bool) -> String:
  match selected has_proof matching_merge:
    case True{} _ _: "verified"
    case False{} False{} _: "no_release_proof"
    case False{} True{} True{}: "release_unverified"
    case False{} True{} False{}: "no_proof_for_current_merge"

def delivery_endpoint(at: Point) -> String:
  Bool.pick(String, has_time(at), "observed", "missing")

def delivery_stage(+start: Point, +end: Point) -> String:
  Bool.pick(String, has_time(start),
    Bool.pick(String, has_time(end), Bool.pick(String, time_order(start, end), "observed", "clock_conflict"), "missing_end"),
    Bool.pick(String, has_time(end), "missing_start", "missing_both"))

def delivery_thread_window(+created: Point, +window_start: Point) -> String:
  Bool.pick(String, Bool.and(has_time(created), has_time(window_start)),
    Bool.pick(String, time_order(window_start, created), "at_or_after_window_start", "before_window_start"), "unknown")

def delivery_thread_stage(link: String, start: Point, end: Point) -> String:
  Bool.pick(String, String.eq(link, "thread_clock_conflict"), "clock_conflict", delivery_stage(start, end))

type DeliveryClocks is Data:
  DeliveryTimes{thread_started: Point, first_commit: Point, pr_opened: Point, first_ci: Point,
    first_review: Point, pr_merged: Point, release_dispatched: Point, published: Point, access_checked: Point}

type DeliveryEndpoints is Data:
  Endpoints{thread_started: String, first_commit: String, pr_opened: String, first_ci: String,
    first_review: String, pr_merged: String, release_dispatched: String, published: String, access_checked: String}

type DeliveryStages is Data:
  Stages{thread_to_commit: String, commit_to_open: String, open_to_first_ci: String, first_ci_to_merge: String,
    merge_to_dispatch: String, dispatch_to_publication: String, open_to_merge: String, merge_to_publication: String,
    thread_to_publication: String, publication_to_access_check: String}

def delivery_endpoints(clocks: DeliveryClocks) -> DeliveryEndpoints:
  match clocks:
    case DeliveryTimes{thread, commit, opened, ci, review, merge, dispatch, published, checked}:
      Endpoints{delivery_endpoint(thread), delivery_endpoint(commit), delivery_endpoint(opened),
        delivery_endpoint(ci), delivery_endpoint(review), delivery_endpoint(merge), delivery_endpoint(dispatch),
        delivery_endpoint(published), delivery_endpoint(checked)}

def delivery_stages(clocks: DeliveryClocks, +thread_link: String) -> DeliveryStages:
  match clocks:
    case DeliveryTimes{+thread, +commit, +opened, +ci, review, +merge, +dispatch, +published, checked}:
      Stages{delivery_thread_stage(thread_link, thread, commit), delivery_stage(commit, opened),
        delivery_stage(opened, ci), delivery_stage(ci, merge), delivery_stage(merge, dispatch),
        delivery_stage(dispatch, published), delivery_stage(opened, merge), delivery_stage(merge, published),
        delivery_thread_stage(thread_link, thread, published), delivery_stage(published, checked)}

type WatchIdentity is Data:
  NoWatch{}
  ExactWatch{repository: String, run_id: String, head_sha: String, attempt: String}

def all_hex(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: True{}
    case +head <> tail:
      Bool.and(Bool.or(Char.is_digit(head), String.contains("abcdef", String.from_list([head]))), all_hex(tail))

def watch_identity(+repo: String, +run: String, +sha: String, +attempt: String) -> WatchIdentity:
  Bool.pick(WatchIdentity, Bool.and(Repository.valid(repo), Bool.and(decimal(run),
    Bool.and(decimal(attempt), Bool.and(Nat.is_eq(String.length(sha), 40n), all_hex(String.to_list(sha)))))),
    ExactWatch{String.to_lower(repo), run, sha, attempt}, NoWatch{})

def watcher_flags(words: List<&2, String>) -> WatchIdentity:
  match words:
    case [run, repo_flag, repo, head_flag, sha, attempt_flag, attempt, timeout_flag, timeout, interval_flag, interval]:
      flags = Bool.and(String.eq(repo_flag, "--repo"), Bool.and(String.eq(head_flag, "--head"),
        Bool.and(String.eq(attempt_flag, "--attempt"), Bool.and(String.eq(timeout_flag, "--timeout"),
          String.eq(interval_flag, "--interval")))))
      Bool.pick(WatchIdentity, Bool.and(flags, Bool.and(decimal(timeout), decimal(interval))),
        watch_identity(repo, run, sha, attempt), NoWatch{})
    case _: NoWatch{}

type ProcessInput is Data:
  NoProcess{}
  LaunchProcess{category: String, watch: WatchIdentity}
  PollProcess{handle: String}
  UnresolvedProcess{status: String, handle: String, potential_io: Bool}

def watcher_launch(watch: WatchIdentity) -> ProcessInput:
  match watch:
    case NoWatch{}: LaunchProcess{"GitHub watcher with incomplete identity", NoWatch{}}
    case +watch: LaunchProcess{"Exact GitHub watcher request", watch}

def gh_watch_arguments(words: List<&2, String>) -> Bool:
  match words:
    case group <> action <> tail: Bool.and(String.eq(group, "run"), String.eq(action, "watch"))
    case _: False{}

def process_launch_words(command: ShellCommand, +category: String) -> ProcessInput:
  match command:
    case Command{+program, +args}:
      Bool.pick(ProcessInput, String.eq(program, "gh_owned_wait.py"), watcher_launch(watcher_flags(args)),
        Bool.pick(ProcessInput, Bool.and(String.eq(program, "gh"), gh_watch_arguments(args)),
          LaunchProcess{"GitHub watcher with incomplete identity", NoWatch{}}, LaunchProcess{category, NoWatch{}}))

def process_launch(exact: List<&2, ShellCommand>, +category: String) -> ProcessInput:
  match exact:
    case [Command{+program, +args}]:
      process_launch_words(Bool.pick(ShellCommand, Bool.or(String.eq(program, "python3"), String.eq(program, "python")),
        command_words(args), Command{last_word(String.split(program, '/')), args}), category)
    case Command{+name, [+arg]} <> tail:
      Bool.pick(ProcessInput, Bool.or(Bool.and(String.eq(name, "umask"), String.eq(arg, "077")),
        Bool.and(String.eq(name, "set"), String.eq(arg, "-e"))), process_launch(tail, category),
        LaunchProcess{category, NoWatch{}})
    case _: LaunchProcess{category, NoWatch{}}

def process_poll(+handle: String, read_only: Bool, printed: Bool) -> ProcessInput:
  Bool.pick(ProcessInput, String.is_empty(handle), UnresolvedProcess{"dynamic_process_handle", "", True{}},
    Bool.pick(ProcessInput, Bool.and(read_only, printed), PollProcess{handle},
      UnresolvedProcess{"unsupported_process_wrapper", handle, True{}}))

type Invocations is Data:
  ProcessInvocations{launches: U32, polls: U32}

def process_invocations(invocations: List<&2, ToolInvocation>, +launches: U32, +polls: U32) -> Invocations:
  match invocations:
    case []: ProcessInvocations{launches, polls}
    case Invocation{+receiver, +method, commands, printed, exact, handle, read_only} <> tail:
      process_invocations(tail,
        U32.add(launches, Bool.to_u32(Bool.and(String.eq(receiver, "tools"), String.eq(method, "exec_command")))),
        U32.add(polls, Bool.to_u32(Bool.and(String.eq(receiver, "tools"), String.eq(method, "write_stdin")))))

def wrapped_process(counts: Invocations, first: ToolInvocation, +category: String) -> ProcessInput:
  match counts first:
    case ProcessInvocations{1, 0} Invocation{"tools", "exec_command", commands, True{}, exact, handle, read_only}:
      process_launch(exact, category)
    case ProcessInvocations{0, 1} Invocation{"tools", "write_stdin", commands, printed, exact, handle, read_only}:
      process_poll(handle, read_only, printed)
    case ProcessInvocations{0, 0} _:
      UnresolvedProcess{"unsupported_process_wrapper", "", False{}}
    case ProcessInvocations{1, 0} _:
      UnresolvedProcess{"unsupported_process_wrapper", "", True{}}
    case _ _:
      UnresolvedProcess{"multiple_process_invocations", "", True{}}

def process_input_category(+name: String, +exact: List<&2, ShellCommand>, +wrapped: List<&2, ToolInvocation>,
  +handle: String, +read_only: Bool, +categories: String) -> ProcessInput:
  Bool.pick(ProcessInput, String.eq(name, "exec_command"), process_launch(exact, categories),
    Bool.pick(ProcessInput, String.eq(name, "exec"),
      wrapped_process(process_invocations(wrapped, 0, 0), first_invocation(wrapped), categories),
      Bool.pick(ProcessInput, String.eq(name, "write_stdin"), process_poll(handle, read_only, True{}), NoProcess{})))

def process_input(name: String, exact: List<&2, ShellCommand>, wrapped: List<&2, ToolInvocation>,
  handle: String, read_only: Bool, observed: ToolContext) -> ProcessInput:
  match observed:
    case Tool{tool, command, categories, wrapper, wait}:
      process_input_category(name, exact, wrapped, handle, read_only, categories)

type ProcessReceipt is Data:
  MissingReceipt{}
  InvalidReceipt{}
  RunningReceipt{handle: String, seconds: F32}
  ExitReceipt{code: U32, seconds: F32}

def process_receipt(+handle: String, has_handle: Bool, +code: U32, +has_exit: Bool, +seconds: F32) -> ProcessReceipt:
  Bool.pick(ProcessReceipt, Bool.and(F32.is_ge(seconds, 0.0), F32.is_le(seconds, 86400.0)),
    Bool.pick(ProcessReceipt, has_handle,
      Bool.pick(ProcessReceipt, Bool.and(Bool.not(String.is_empty(handle)), Bool.not(has_exit)),
        RunningReceipt{handle, seconds}, InvalidReceipt{}),
      Bool.pick(ProcessReceipt, Bool.and(has_exit, U32.is_le(code, 255)),
        ExitReceipt{code, seconds}, InvalidReceipt{})), InvalidReceipt{})

type ProcessSlot is Data:
  Vacant{}
  Conflict{}
  Live{owner: String, category: String, watch: WatchIdentity, line: U32, end: Point}

type ProcessFact is Data:
  ProcessFact{status: String, owner: String, category: String, watch: WatchIdentity, receipt: ProcessReceipt}

type ProcessStep is Data:
  ProcessStep{slot: ProcessSlot, fact: ProcessFact}

def process_gap(status: String, slot: ProcessSlot, receipt: ProcessReceipt) -> ProcessStep:
  ProcessStep{slot, ProcessFact{status, "", "", NoWatch{}, receipt}}

def receipt_handle(receipt: ProcessReceipt) -> String:
  match receipt:
    case RunningReceipt{handle, seconds}: handle
    case _: ""

def process_key(input: ProcessInput, receipt: ProcessReceipt) -> String:
  match input:
    case PollProcess{handle}: handle
    case UnresolvedProcess{status, +handle, potential_io}:
      Bool.pick(String, String.is_empty(handle), receipt_handle(receipt), handle)
    case _: receipt_handle(receipt)

def open_process(slot: ProcessSlot, +owner: String, +category: String, +watch: WatchIdentity,
  line: U32, end: Point, +receipt: ProcessReceipt) -> ProcessStep:
  match slot:
    case Vacant{}:
      ProcessStep{Live{owner, category, watch, line, end}, ProcessFact{"process_opened", owner, category, watch, receipt}}
    case _:
      process_gap("ambiguous_process_handle", Conflict{}, receipt)

def finish_poll(+handle: String, +owner: String, +category: String, +watch: WatchIdentity, +line: U32, +end: Point,
  +receipt: ProcessReceipt) -> ProcessStep:
  match receipt:
    case RunningReceipt{echoed, seconds}:
      Bool.pick(ProcessStep, String.eq(echoed, handle),
        ProcessStep{Live{owner, category, watch, line, end}, ProcessFact{"process_running", owner, category, watch, receipt}},
        process_gap("contradictory_process_receipt", Conflict{}, receipt))
    case ExitReceipt{code, seconds}:
      ProcessStep{Vacant{}, ProcessFact{"process_exited", owner, category, watch, receipt}}
    case MissingReceipt{}:
      ProcessStep{Conflict{}, ProcessFact{"missing_process_receipt", owner, category, watch, receipt}}
    case InvalidReceipt{}:
      ProcessStep{Conflict{}, ProcessFact{"invalid_process_receipt", owner, category, watch, receipt}}

def poll_process(slot: ProcessSlot, +handle: String, start_line: U32, start: Point,
  +line: U32, +end: Point, +receipt: ProcessReceipt) -> ProcessStep:
  match slot:
    case Vacant{}: process_gap("missing_process_launch", Conflict{}, receipt)
    case Conflict{}: process_gap("ambiguous_process_handle", Conflict{}, receipt)
    case Live{owner, category, watch, prior_line, prior_end}:
      Bool.pick(ProcessStep, cell_order(prior_end, prior_line, start, start_line),
        finish_poll(handle, owner, category, watch, line, end, receipt),
        process_gap("ambiguous_process_order", Conflict{}, receipt))

def process_result(input: ProcessInput, +slot: ProcessSlot, +receipt: ProcessReceipt, +owner: String,
  start_line: U32, start: Point, +line: U32, +end: Point, +valid: Bool) -> ProcessStep:
  match input receipt:
    case LaunchProcess{category, watch} RunningReceipt{handle, seconds}:
      Bool.pick(ProcessStep, valid, open_process(slot, owner, category, watch, line, end, receipt),
        process_gap("ambiguous_process_launch", Conflict{}, receipt))
    case LaunchProcess{category, watch} ExitReceipt{code, seconds}:
      Bool.pick(ProcessStep, valid, ProcessStep{slot, ProcessFact{"synchronous_process_exit", owner, category, watch, receipt}},
        process_gap("ambiguous_process_launch", slot, receipt))
    case LaunchProcess{category, watch} _:
      process_gap("missing_process_launch_receipt", slot, receipt)
    case PollProcess{handle} _:
      Bool.pick(ProcessStep, valid, poll_process(slot, handle, start_line, start, line, end, receipt),
        process_gap("incomplete_process_poll", Conflict{}, receipt))
    case UnresolvedProcess{status, handle, potential_io} _:
      process_gap(status, Conflict{}, receipt)
    case _ _:
      process_gap("cell_without_supported_process", slot, receipt)

def extra_handle(+primary: String, +echoed: String) -> String:
  Bool.pick(String, Bool.or(String.is_empty(primary), String.eq(primary, echoed)), "", echoed)

def process_taint(input: ProcessInput, +receipt: ProcessReceipt) -> String:
  match input:
    case PollProcess{handle}: extra_handle(handle, receipt_handle(receipt))
    case UnresolvedProcess{status, handle, potential_io}: extra_handle(handle, receipt_handle(receipt))
    case _: ""

def process_observer(fact: ProcessFact) -> WatchIdentity:
  match fact:
    case ProcessFact{+status, owner, category, watch, receipt}:
      Bool.pick(WatchIdentity, Bool.or(String.eq(status, "process_running"), String.eq(status, "process_exited")),
        watch, NoWatch{})

def process_has_payload(receipt: ProcessReceipt) -> Bool:
  match receipt:
    case MissingReceipt{}: False{}
    case _: True{}

def process_receipt_invalid(receipt: ProcessReceipt) -> Bool:
  match receipt:
    case InvalidReceipt{}: True{}
    case _: False{}

def process_barrier(input: ProcessInput, receipt: ProcessReceipt, handle: String, +ambiguous: Bool) -> Bool:
  match input:
    case UnresolvedProcess{status, candidate, potential_io}:
      Bool.and(String.is_empty(handle), Bool.or(potential_io, process_has_payload(receipt)))
    case LaunchProcess{category, watch}:
      Bool.and(String.is_empty(handle), Bool.or(ambiguous, process_receipt_invalid(receipt)))
    case PollProcess{candidate}: ambiguous
    case _: False{}

def observed_slot(+slot: ProcessSlot, barrier: U32) -> ProcessSlot:
  match slot:
    case Live{owner, category, watch, line, end}:
      Bool.pick(ProcessSlot, U32.is_gt(barrier, line), Conflict{}, slot)
    case _: slot

def valid_process_result(+clean: Bool, ambiguous: Bool, start: Point, end: Point) -> Bool:
  Bool.and(clean, Bool.and(Bool.not(ambiguous), time_order(start, end)))

type ProcessObservation is Data:
  ProcessObservation{call: String, result_call: String, result_line: U32, handle: String, fact: ProcessFact,
    observer: WatchIdentity, start: Point, end: Point}

type Receipt is Data:
  NoReceipt{}
  Receipt{seconds: F32, code: U32, running: Bool}

type RolloutCall is Data:
  EmptyCall{}
  SavedCall{call: CallState, mix: CommandMix, receipt: Receipt, process: ProcessInput, result: ProcessReceipt,
    direct: Bool}

type RolloutCalls is Data:
  Calls{index: Map<&2, RolloutCall>, newest_first: List<&2, String>}

def empty_rollout_calls() -> RolloutCalls:
  Calls{Map.new(&2, RolloutCall), []}

type CallEvent is Data:
  Started{line: U32, tool: ToolContext, stamp: Point, target: String, mix: CommandMix, process: ProcessInput,
    direct: Bool}
  Finished{line: U32, stamp: Point, yielded: String, completed: Bool, receipt: ProcessReceipt}

def receipt_for(mix: CommandMix, +previous: Receipt, +received: Receipt) -> Receipt:
  match mix received:
    case NoMix{} _: previous
    case _ NoReceipt{}: previous
    case _ _: received

def model_receipt(receipt: ProcessReceipt) -> Receipt:
  match receipt:
    case ExitReceipt{code, seconds}: Receipt{seconds, code, False{}}
    case _: NoReceipt{}

def first_result(state: CallState, previous: ProcessReceipt, received: ProcessReceipt) -> ProcessReceipt:
  match state:
    case Seen{_, _, _, _, _, 0, _, _, _, _}: received
    case _: previous

def first_process(state: CallState, previous: ProcessInput, next: ProcessInput) -> ProcessInput:
  match state:
    case Unseen{_}: next
    case _: previous

def observe_call(current: RolloutCall, event: CallEvent) -> RolloutCall:
  match current event:
    case EmptyCall{} Started{line, tool, stamp, target, mix, process, direct}:
      SavedCall{start_call(Unseen{0}, line, tool, stamp, target), mix, NoReceipt{}, process, MissingReceipt{}, direct}
    case EmptyCall{} Finished{line, stamp, yielded, completed, receipt}:
      SavedCall{finish_call(Unseen{0}, line, stamp, yielded, completed), NoMix{}, NoReceipt{}, NoProcess{}, MissingReceipt{}, False{}}
    case SavedCall{+call, old_mix, receipt, previous, result, seen_direct} Started{line, tool, stamp, target, mix, process, direct}:
      SavedCall{start_call(call, line, tool, stamp, target), mix, receipt, first_process(call, previous, process),
        result, Bool.or(seen_direct, direct)}
    case SavedCall{+call, +mix, previous, process, result, direct} Finished{line, stamp, yielded, completed, +received}:
      SavedCall{finish_call(call, line, stamp, yielded, completed), mix, receipt_for(mix, previous, model_receipt(received)),
        process, first_result(call, result, received), direct}

def add_rollout_call(+id: String, event: CallEvent, order: List<&2, String>,
  found: Map<&2, RolloutCall> & RolloutCall) -> RolloutCalls:
  match found:
    case Tuple{index, EmptyCall{}}:
      Calls{Map.set(&2, RolloutCall, index, id, observe_call(EmptyCall{}, event)), id <> order}
    case Tuple{index, saved}:
      Calls{Map.set(&2, RolloutCall, index, id, observe_call(saved, event)), order}

def rollout_call(calls: RolloutCalls, +id: String, event: CallEvent) -> RolloutCalls:
  match calls:
    case Calls{index, order}: add_rollout_call(id, event, order, Map.get(RolloutCall, EmptyCall{}, index, id))

def accepts_model_script(name: String) -> Bool:
  String.eq(name, "exec")

def direct_process(+name: String) -> Bool:
  Bool.or(String.eq(name, "exec_command"), String.eq(name, "write_stdin"))

def rollout_start(calls: RolloutCalls, id: String, line: U32, +name: String, stamp: Point, target: String,
  direct: List<&2, ShellCommand>, +wrapped: List<&2, ToolInvocation>, sequential: List<&2, ShellCommand>,
  exact: List<&2, ShellCommand>, handle: String, read_only: Bool) -> RolloutCalls:
  +observed = tool(name, direct, wrapped)
  rollout_call(calls, id, Started{line, observed, stamp, target,
    Bool.pick(CommandMix, accepts_model_script(name), command_mix(sequential), NoMix{}),
    process_input(name, exact, wrapped, handle, read_only, observed), direct_process(name)})

def direct_call(found: Map<&2, RolloutCall> & RolloutCall) -> Bool:
  match found:
    case Tuple{_, SavedCall{_, _, _, _, _, direct}}: direct
    case _: False{}

def direct_result(calls: RolloutCalls, id: String) -> Bool:
  match calls:
    case Calls{index, order}: direct_call(Map.get(RolloutCall, EmptyCall{}, index, id))

def rollout_finish(calls: RolloutCalls, id: String, line: U32, stamp: Point, yielded: String, completed: Bool,
  receipt: ProcessReceipt) -> RolloutCalls:
  rollout_call(calls, id, Finished{line, stamp, yielded, completed, receipt})

def add_cell(key: String, fact: CellFact, found: Map<&2, CellPair> & CellPair) -> Map<&2, CellPair>:
  match found:
    case Tuple{cells, pair}: Map.set(&2, CellPair, cells, key, add_cell_fact(pair, fact))

def record_cell(+fact: CellFact, cells: Map<&2, CellPair>) -> Map<&2, CellPair>:
  match fact:
    case NoCell{}: cells
    case Launch{+key, owner, yielded_at, yielded_line, valid}:
      add_cell(key, fact, Map.get(CellPair, Pair{NoCell{}, NoCell{}, False{}}, cells, key))
    case Terminal{+key, call_id, started_at, started_line, ended_at, valid}:
      add_cell(key, fact, Map.get(CellPair, Pair{NoCell{}, NoCell{}, False{}}, cells, key))

def collect_cells(calls: Map<&2, RolloutCall>, cells: Map<&2, CellPair>) -> Map<&2, CellPair>:
  match calls:
    case MTip{}: cells
    case MLeaf{id, EmptyCall{}}: cells
    case MLeaf{id, SavedCall{state, mix, receipt, process, result, direct}}: record_cell(cell_fact(id, state), cells)
    case MNode{position, lo, hi}: collect_cells(hi, collect_cells(lo, cells))

def record_link(link: CellLink, links: Map<&2, CellLink>) -> Map<&2, CellLink>:
  match link:
    case Unlinked{}: links
    case Linked{+owner, call_id, end}: Map.set(&2, CellLink, links, owner, Linked{owner, call_id, end})

def collect_links(cells: Map<&2, CellPair>, +clean: Bool, links: Map<&2, CellLink>) -> Map<&2, CellLink>:
  match cells:
    case MTip{}: links
    case MLeaf{key, pair}: record_link(cell_link(pair, clean), links)
    case MNode{position, lo, hi}: collect_links(hi, clean, collect_links(lo, clean, links))

def call_orphans(state: CallState) -> U32:
  match state:
    case Unseen{orphans}: orphans
    case Seen{orphans, line, tool, start, finish, result_line, target, cell, terminal, ambiguous}: orphans

def count_orphans(calls: Map<&2, RolloutCall>) -> U32:
  match calls:
    case MLeaf{id, SavedCall{state, mix, receipt, process, result, direct}}: call_orphans(state)
    case MNode{position, lo, hi}: U32.add(count_orphans(lo), count_orphans(hi))
    case _: 0

type ModelSample is Data:
  NoSample{}
  Sample{mix: CommandMix, seconds: F32}

def model_sample(mix: CommandMix, receipt: Receipt, finish: Point, ambiguous: Bool) -> ModelSample:
  match mix receipt:
    case Mix{files, git, builds, pushes} Receipt{+seconds, code, running}:
      Bool.pick(ModelSample, keep_mix_receipt(seconds, code, running, has_time(finish), ambiguous),
        Sample{Mix{files, git, builds, pushes}, seconds}, NoSample{})
    case _ _: NoSample{}

type RolloutRecord is Data:
  RolloutRecord{id: String, record: CallRecord, link: CellLink, candidate: CommandMix, sample: ModelSample}

type RolloutSummary is Data:
  Summary{orphans: U32, records: List<&2, RolloutRecord>, cells: Map<&2, CellPair>, clean: Bool,
    observations: List<&2, ProcessObservation>}

def add_record(id: String, +record: CallRecord, link: CellLink, +mix: CommandMix, receipt: Receipt,
  records: List<&2, RolloutRecord>) -> List<&2, RolloutRecord>:
  match record:
    case Ignored{extra}: records
    case Observed{extra, line, tool, command, categories, start, finish, result_line, launched, target, ambiguous}:
      RolloutRecord{id, record, link, mix, model_sample(mix, receipt, finish, ambiguous)} <> records

def add_saved(id: String, link: CellLink, records: List<&2, RolloutRecord>, saved: RolloutCall) -> List<&2, RolloutRecord>:
  match saved:
    case EmptyCall{}: records
    case SavedCall{call, mix, receipt, process, result, direct}: add_record(id, call_record(call), link, mix, receipt, records)

def add_found(id: String, records: List<&2, RolloutRecord>, call_found: Map<&2, RolloutCall> & RolloutCall,
  link_found: Map<&2, CellLink> & CellLink) -> List<&2, RolloutRecord>:
  match call_found link_found:
    case Tuple{calls, saved} Tuple{links, link}: add_saved(id, link, records, saved)

def summarize_calls(ids: List<&2, String>, +calls: Map<&2, RolloutCall>, +links: Map<&2, CellLink>,
  records: List<&2, RolloutRecord>) -> List<&2, RolloutRecord>:
  match ids:
    case []: records
    case +id <> rest:
      summarize_calls(rest, calls, links, add_found(id, records,
        Map.get(RolloutCall, EmptyCall{}, calls, id), Map.get(CellLink, Unlinked{}, links, id)))

type ProcessOperation is Data:
  Operation{call: String, line: U32, start: Point, result_call: String, result_line: U32, end: Point,
    ambiguous: Bool, input: ProcessInput, receipt: ProcessReceipt}

def found_call(found: Map<&2, RolloutCall> & RolloutCall) -> RolloutCall:
  match found:
    case Tuple{_, saved}: saved

def saved_call(id: String, calls: Map<&2, RolloutCall>) -> RolloutCall:
  found_call(Map.get(RolloutCall, EmptyCall{}, calls, id))

def operation_line(line: U32, +result_line: U32) -> U32:
  Bool.pick(U32, U32.is_eq(result_line, 0), line, result_line)

def line_byte(value: U32) -> Char:
  Char.from_u32(U32.add(32, U32.and(value, 255)))

def line_key(+line: U32) -> String:
  String.from_list([line_byte(U32.shrn(line, 24n)), line_byte(U32.shrn(line, 16n)),
    line_byte(U32.shrn(line, 8n)), line_byte(line)])

def schedule_process(operation: ProcessOperation, key: String,
  found: Map<&2, List<&2, ProcessOperation>> & List<&2, ProcessOperation>) -> Map<&2, List<&2, ProcessOperation>>:
  match found:
    case Tuple{lines, queued}: Map.set(&2, List<&2, ProcessOperation>, lines, key, operation <> queued)

def result_operation(call: String, +line: U32, start: Point, ambiguous: Bool, input: ProcessInput,
  result_call: String, result: RolloutCall, pending: Map<&2, List<&2, ProcessOperation>>) -> Map<&2, List<&2, ProcessOperation>>:
  match result:
    case SavedCall{Seen{_, _, _, _, end, +result_line, _, _, _, result_ambiguous}, _, _, _, receipt, _}:
      +key = line_key(operation_line(line, result_line))
      schedule_process(Operation{call, line, start, result_call, result_line, end, Bool.or(ambiguous, result_ambiguous), input, receipt},
        key, Map.get(List<&2, ProcessOperation>, [], pending, key))
    case _: pending

def operation_for(+saved: RolloutCall, +id: String, +line: U32, +start: Point, +ambiguous: Bool,
  link: CellLink, calls: Map<&2, RolloutCall>, pending: Map<&2, List<&2, ProcessOperation>>) -> Map<&2, List<&2, ProcessOperation>>:
  match saved link:
    case EmptyCall{} _: pending
    case SavedCall{_, _, _, NoProcess{}, _, _} _: pending
    case SavedCall{_, _, _, input, _, _} Linked{_, +result_call, _}:
      result_operation(id, line, start, ambiguous, input, result_call, saved_call(result_call, calls), pending)
    case SavedCall{_, _, _, input, _, _} Unlinked{}:
      result_operation(id, line, start, ambiguous, input, id, saved, pending)

def collect_operations(records: List<&2, RolloutRecord>, +calls: Map<&2, RolloutCall>,
  pending: Map<&2, List<&2, ProcessOperation>>) -> Map<&2, List<&2, ProcessOperation>>:
  match records:
    case []: pending
    case RolloutRecord{+id, Observed{_, line, _, _, _, start, _, _, _, _, ambiguous}, link, _, _} <> rest:
      collect_operations(rest, calls, operation_for(saved_call(id, calls), id, line, start, ambiguous, link, calls, pending))
    case _ <> rest: collect_operations(rest, calls, pending)

type ProcessHistory is Data:
  History{slots: Map<&2, ProcessSlot>, barrier: U32, observations: List<&2, ProcessObservation>}

def put_process_slot(+key: String, slot: ProcessSlot, table: Map<&2, ProcessSlot>) -> Map<&2, ProcessSlot>:
  match key:
    case "": table
    case _: Map.set(&2, ProcessSlot, table, key, slot)

def record_process(operation: ProcessOperation, +handle: String, next: ProcessStep, slots: Map<&2, ProcessSlot>,
  barrier: U32, observations: List<&2, ProcessObservation>) -> ProcessHistory:
  match operation next:
    case Operation{call, line, start, result_call, +result_line, end, _, input, receipt} ProcessStep{slot, +fact}:
      History{put_process_slot(process_taint(input, receipt), Conflict{}, put_process_slot(handle, slot, slots)),
        barrier, ProcessObservation{call, result_call, result_line, handle, fact, process_observer(fact), start, end} <> observations}

def advance_process(found: Map<&2, ProcessSlot> & ProcessSlot, +operation: ProcessOperation, +handle: String,
  +barrier: U32, clean: Bool, observations: List<&2, ProcessObservation>) -> ProcessHistory:
  match found operation:
    case Tuple{table, slot} Operation{+call, +line, +start, _, +result_line, +end, +ambiguous, +input, +receipt}:
      record_process(operation, handle, process_result(input, observed_slot(slot, barrier), receipt, call,
        line, start, result_line, end, valid_process_result(clean, ambiguous, start, end)), table,
        Bool.pick(U32, process_barrier(input, receipt, handle, ambiguous), operation_line(line, result_line), barrier),
        observations)

def observe_process(history: ProcessHistory, +operation: ProcessOperation, clean: Bool) -> ProcessHistory:
  match history operation:
    case History{slots, barrier, observations} Operation{_, _, _, _, _, _, _, input, receipt}:
      +handle = process_key(input, receipt)
      advance_process(Map.get(ProcessSlot, Vacant{}, slots, handle), operation, handle, barrier, clean, observations)

def process_observations(history: ProcessHistory) -> List<&2, ProcessObservation>:
  match history:
    case History{_, _, observations}: List.reverse(&2, ProcessObservation, observations)

def observe_operations(ordered: List<&2, ProcessOperation>, +clean: Bool, history: ProcessHistory) -> ProcessHistory:
  match ordered:
    case []: history
    case operation <> rest: observe_operations(rest, clean, observe_process(history, operation, clean))

def observe_process_lines(lines: Map<&2, List<&2, ProcessOperation>>, +clean: Bool, history: ProcessHistory) -> ProcessHistory:
  match lines:
    case MTip{}: history
    case MLeaf{_, operations}: observe_operations(operations, clean, history)
    case MNode{_, low, high}: observe_process_lines(high, clean, observe_process_lines(low, clean, history))

def rollout_process_observations(records: List<&2, RolloutRecord>, calls: Map<&2, RolloutCall>,
  clean: Bool) -> List<&2, ProcessObservation>:
  process_observations(observe_process_lines(
    collect_operations(List.reverse(&2, RolloutRecord, records), calls, Map.new(&2, List<&2, ProcessOperation>)),
    clean, History{Map.new(&2, ProcessSlot), 0, []}))

def summarize_rollout(+orphans: U32, +clean: Bool, +cells: Map<&2, CellPair>, +index: Map<&2, RolloutCall>,
  order: List<&2, String>) -> RolloutSummary:
  +records = summarize_calls(order, index, collect_links(cells, clean, Map.new(&2, CellLink)), [])
  Summary{orphans, records, cells, clean, rollout_process_observations(records, index, clean)}

def finish_rollout_calls(calls: RolloutCalls, malformed: U32) -> RolloutSummary:
  match calls:
    case Calls{+index, order}:
      +orphans = count_orphans(index)
      summarize_rollout(orphans, clean_rollout(malformed, orphans), collect_cells(index, Map.new(&2, CellPair)), index, order)

def lookup_wait(call_found: Map<&2, RolloutCall> & RolloutCall, cell_found: Map<&2, CellPair> & CellPair,
  clean: Bool) -> WaitCell:
  match call_found cell_found:
    case Tuple{calls, SavedCall{state, mix, receipt, process, result, direct}} Tuple{cells, pair}: wait_cell(state, pair, clean)
    case _ _: NotWait{}

def rollout_wait(calls: RolloutCalls, id: String, target: String, cells: Map<&2, CellPair>, clean: Bool) -> WaitCell:
  match calls:
    case Calls{index, order}:
      lookup_wait(Map.get(RolloutCall, EmptyCall{}, index, id),
        Map.get(CellPair, Pair{NoCell{}, NoCell{}, False{}}, cells, target), clean)

type WatchOverlap is Data:
  NoOverlap{}
  Overlap{start: Point, end: Point}

type Observer is Data:
  Observer{session: String, launch: String}

def independent_observers(first: Observer, second: Observer) -> Bool:
  match first second:
    case Observer{a_session, a_launch} Observer{b_session, b_launch}:
      Bool.not(Bool.and(String.eq(a_session, b_session), String.eq(a_launch, b_launch)))

def watch_overlap(first: Observer, second: Observer, +a_start: Point, +a_end: Point, +b_start: Point, +b_end: Point) -> WatchOverlap:
  +start = Bool.pick(Point, time_order(a_start, b_start), b_start, a_start)
  +end = Bool.pick(Point, time_order(a_end, b_end), a_end, b_end)
  Bool.pick(WatchOverlap, Bool.and(independent_observers(first, second),
    Bool.and(time_order(start, end), Bool.not(time_order(end, start)))), Overlap{start, end}, NoOverlap{})

def repository_name(value: String) -> String:
  Repository.normalized(value)

type WatchPoll is Data:
  Poll{index: Nat, observer: Observer, start: Point, end: Point}

type IndexedOverlap is Data:
  IndexedOverlap{first: Nat, second: Nat, start: Point, end: Point}

type OverlapScan is Data:
  OverlapScan{active: List<&2, WatchPoll>, newest: List<&2, IndexedOverlap>}

def add_overlap(first: Nat, second: Nat, overlap: WatchOverlap, newest: List<&2, IndexedOverlap>) -> List<&2, IndexedOverlap>:
  match overlap:
    case NoOverlap{}: newest
    case Overlap{start, end}: IndexedOverlap{first, second, start, end} <> newest

def retain_poll(keep: Bool, +previous: WatchPoll, current: WatchPoll, state: OverlapScan) -> OverlapScan:
  match keep previous current state:
    case True{} Poll{first, a, a_start, a_end} Poll{second, b, b_start, b_end} OverlapScan{active, newest}:
      OverlapScan{previous <> active, add_overlap(first, second, watch_overlap(a, b, a_start, a_end, b_start, b_end), newest)}
    case _ _ _ _: state

def compare_poll(state: OverlapScan, +previous: WatchPoll, +current: WatchPoll) -> OverlapScan:
  match previous current:
    case Poll{first, a, a_start, a_end} Poll{second, b, b_start, b_end}:
      retain_poll(time_order(b_start, a_end), previous, current, state)

def keep_current(state: OverlapScan, current: WatchPoll) -> OverlapScan:
  match state:
    case OverlapScan{active, newest}: OverlapScan{List.reverse(&2, WatchPoll, current <> active), newest}

def compare_active(active: List<&2, WatchPoll>, +current: WatchPoll, state: OverlapScan) -> OverlapScan:
  match active:
    case []: state
    case previous <> tail: compare_active(tail, current, compare_poll(state, previous, current))

def sweep_poll(state: OverlapScan, +current: WatchPoll) -> OverlapScan:
  match state:
    case OverlapScan{active, newest}:
      keep_current(compare_active(active, current, OverlapScan{[], newest}), current)

def ordered_overlaps(state: OverlapScan) -> List<&2, IndexedOverlap>:
  match state:
    case OverlapScan{active, newest}: List.reverse(&2, IndexedOverlap, newest)

def watch_overlaps(polls: List<&2, WatchPoll>) -> List<&2, IndexedOverlap>:
  ordered_overlaps(List.foldl(~&2, ~WatchPoll, ~OverlapScan, ~(scan => current => sweep_poll(scan, current)),
    polls, OverlapScan{[], []}))
