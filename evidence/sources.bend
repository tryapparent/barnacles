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

type Receipt is Data:
  NoReceipt{}
  Receipt{seconds: F32, code: U32, running: Bool}

type RolloutCall is Data:
  EmptyCall{}
  SavedCall{call: CallState, mix: CommandMix, receipt: Receipt}

type RolloutCalls is Data:
  Calls{index: Map<&2, RolloutCall>, newest_first: List<&2, String>}

def empty_rollout_calls() -> RolloutCalls:
  Calls{Map.new(&2, RolloutCall), []}

type CallEvent is Data:
  Started{line: U32, tool: ToolContext, stamp: Point, target: String, mix: CommandMix}
  Finished{stamp: Point, yielded: String, completed: Bool, receipt: Receipt}

def receipt_for(mix: CommandMix, +previous: Receipt, +received: Receipt) -> Receipt:
  match mix received:
    case NoMix{} _: previous
    case _ NoReceipt{}: previous
    case _ _: received

def observe_call(current: RolloutCall, event: CallEvent) -> RolloutCall:
  match current event:
    case EmptyCall{} Started{line, tool, stamp, target, mix}:
      SavedCall{start_call(Unseen{0}, line, tool, stamp, target), mix, NoReceipt{}}
    case EmptyCall{} Finished{stamp, yielded, completed, receipt}:
      SavedCall{finish_call(Unseen{0}, stamp, yielded, completed), NoMix{}, NoReceipt{}}
    case SavedCall{call, old_mix, receipt} Started{line, tool, stamp, target, mix}:
      SavedCall{start_call(call, line, tool, stamp, target), mix, receipt}
    case SavedCall{call, +mix, previous} Finished{stamp, yielded, completed, received}:
      SavedCall{finish_call(call, stamp, yielded, completed), mix, receipt_for(mix, previous, received)}

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

def rollout_start(calls: RolloutCalls, id: String, line: U32, +name: String, stamp: Point, target: String,
  direct: List<&2, ShellCommand>, wrapped: List<&2, ToolInvocation>, sequential: List<&2, ShellCommand>) -> RolloutCalls:
  rollout_call(calls, id, Started{line, tool(name, direct, wrapped), stamp, target,
    Bool.pick(CommandMix, accepts_model_script(name), command_mix(sequential), NoMix{})})

def rollout_finish(calls: RolloutCalls, id: String, stamp: Point, yielded: String, completed: Bool, receipt: Receipt) -> RolloutCalls:
  rollout_call(calls, id, Finished{stamp, yielded, completed, receipt})

def add_cell(key: String, fact: CellFact, found: Map<&2, CellPair> & CellPair) -> Map<&2, CellPair>:
  match found:
    case Tuple{cells, pair}: Map.set(&2, CellPair, cells, key, add_cell_fact(pair, fact))

def record_cell(+fact: CellFact, cells: Map<&2, CellPair>) -> Map<&2, CellPair>:
  match fact:
    case NoCell{}: cells
    case Launch{+key, owner, yielded_at, valid}:
      add_cell(key, fact, Map.get(CellPair, Pair{NoCell{}, NoCell{}, False{}}, cells, key))
    case Terminal{+key, call_id, started_at, ended_at, valid}:
      add_cell(key, fact, Map.get(CellPair, Pair{NoCell{}, NoCell{}, False{}}, cells, key))

def collect_cells(calls: Map<&2, RolloutCall>, cells: Map<&2, CellPair>) -> Map<&2, CellPair>:
  match calls:
    case MTip{}: cells
    case MLeaf{id, EmptyCall{}}: cells
    case MLeaf{id, SavedCall{state, mix, receipt}}: record_cell(cell_fact(id, state), cells)
    case MNode{position, lo, hi}: collect_cells(hi, collect_cells(lo, cells))

def record_link(link: CellLink, links: Map<&2, CellLink>) -> Map<&2, CellLink>:
  match link:
    case Unlinked{}: links
    case Linked{+owner, call_id, end}: Map.set(&2, CellLink, links, owner, Linked{owner, call_id, end})

def collect_links(cells: Map<&2, CellPair>, +malformed: U32, links: Map<&2, CellLink>) -> Map<&2, CellLink>:
  match cells:
    case MTip{}: links
    case MLeaf{key, pair}: record_link(cell_link(pair, malformed), links)
    case MNode{position, lo, hi}: collect_links(hi, malformed, collect_links(lo, malformed, links))

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
  RolloutRecord{id: String, record: CallRecord, link: CellLink, sample: ModelSample}

type RolloutSummary is Data:
  Summary{orphans: U32, records: List<&2, RolloutRecord>}

def summarize_call(id: String, +record: CallRecord, link: CellLink, mix: CommandMix, receipt: Receipt,
  summary: RolloutSummary) -> RolloutSummary:
  match record summary:
    case Ignored{extra} Summary{orphans, records}: Summary{U32.add(orphans, extra), records}
    case Observed{extra, line, tool, command, categories, start, finish, launched, ambiguous} Summary{orphans, records}:
      Summary{U32.add(orphans, extra), RolloutRecord{id, record, link, model_sample(mix, receipt, finish, ambiguous)} <> records}

def summarize_saved(id: String, link: CellLink, summary: RolloutSummary, saved: RolloutCall) -> RolloutSummary:
  match saved:
    case EmptyCall{}: summary
    case SavedCall{call, mix, receipt}: summarize_call(id, call_record(call), link, mix, receipt, summary)

def summarize_found(id: String, summary: RolloutSummary, call_found: Map<&2, RolloutCall> & RolloutCall,
  link_found: Map<&2, CellLink> & CellLink) -> RolloutSummary:
  match call_found link_found:
    case Tuple{calls, saved} Tuple{links, link}: summarize_saved(id, link, summary, saved)

def summarize_calls(ids: List<&2, String>, +calls: Map<&2, RolloutCall>, +links: Map<&2, CellLink>,
  summary: RolloutSummary) -> RolloutSummary:
  match ids:
    case []: summary
    case +id <> rest:
      summarize_calls(rest, calls, links, summarize_found(id, summary,
        Map.get(RolloutCall, EmptyCall{}, calls, id), Map.get(CellLink, Unlinked{}, links, id)))

def finish_rollout_calls(calls: RolloutCalls, malformed: U32) -> RolloutSummary:
  match calls:
    case Calls{+index, order}:
      summarize_calls(order, index, collect_links(collect_cells(index, Map.new(&2, CellPair)),
        malformed, Map.new(&2, CellLink)), Summary{0, []})

def has_script_sample(found: Map<&2, RolloutCall> & RolloutCall) -> Bool:
  match found:
    case Tuple{calls, SavedCall{state, Mix{files, git, builds, pushes}, receipt}}: True{}
    case _: False{}

def rollout_needs_receipt(calls: RolloutCalls, id: String) -> Bool:
  match calls:
    case Calls{index, order}: has_script_sample(Map.get(RolloutCall, EmptyCall{}, index, id))

def rollout_timestamp(original: Point, envelope: Point) -> Point:
  match original:
    case Time{0, 0}: envelope
    case _: original

def rollout_session(+previous: String, observed: String) -> Bool:
  Bool.or(String.eq(previous, ""), String.eq(previous, observed))

def rollout_event(+kind: String) -> String:
  Bool.pick(String, Bool.or(String.eq(kind, "function_call"), String.eq(kind, "custom_tool_call")), "start",
    Bool.pick(String, tool_output(kind), "finish", ""))

type PrintedScript is Data:
  PrintedScript{statements: U32, last_kind: String, printer: String, print_args: U32,
    declaration_kind: String, bindings: U32, binding_kind: String, argument_kind: String,
    binding_name: String, argument_name: String, awaited_kind: String, callee: String, call_args: U32}

def printed_execution(script: PrintedScript) -> Bool:
  match script:
    case PrintedScript{+statements, last_kind, printer, print_args, declaration_kind, bindings, binding_kind, argument_kind,
                        binding_name, argument_name, awaited_kind, callee, call_args}:
      bound = Bool.and(U32.is_eq(statements, 2), Bool.and(String.eq(declaration_kind, "lexical_declaration"),
        Bool.and(U32.is_eq(bindings, 1), Bool.and(String.eq(binding_kind, "identifier"),
          Bool.and(String.eq(argument_kind, "identifier"), String.eq(binding_name, argument_name))))))
      Bool.and(String.eq(last_kind, "expression_statement"), Bool.and(String.eq(printer, "text"),
        Bool.and(U32.is_eq(print_args, 1), Bool.and(Bool.or(U32.is_eq(statements, 1), bound),
          Bool.and(String.eq(awaited_kind, "await_expression"),
            Bool.and(String.eq(callee, "tools.exec_command"), U32.is_eq(call_args, 1)))))))

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

def rollout_metadata(meta: RolloutMetadata, +envelope: String, +kind: String, +id: String,
  +observed_session: String, line: U32, observed: Point) -> MetadataStep:
  match meta envelope:
    case RolloutMetadata{+session, malformed, previous, markers} "session_meta":
      MetadataStep{RolloutMetadata{observed_session, malformed, "", markers},
        Bool.pick(String, rollout_session(session, observed_session), "", "conflict")}
    case RolloutMetadata{+session, malformed, +previous, markers} "response_item":
      +valid_id = valid_call_id(id)
      record_response(rollout_event(kind), Bool.not(String.eq(session, "")), valid_id, kind, line, observed, previous,
        RolloutMetadata{session, malformed, model_wait_input(previous, envelope, kind, Bool.pick(String, valid_id, id, "")), markers})
    case RolloutMetadata{session, malformed, previous, markers} _:
      MetadataStep{RolloutMetadata{session, malformed, model_wait_input(previous, envelope, kind, id), markers}, ""}
