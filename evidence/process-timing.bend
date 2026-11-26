import Base

type KernelEvent is Data:
  ProcessRoot{at: Nat, pid: Nat}
  ProcessFork{at: Nat, parent: Nat, pid: Nat}
  ProcessExec{at: Nat, pid: Nat, image: String}
  ProcessExit{at: Nat, pid: Nat}

type KernelTask is Data:
  Absent{}
  KernelTask{parent: Nat, depth: Nat, id: Nat, image: String, start: Nat}

type KernelSpan is Data:
  KernelSpan{id: Nat, parent: Nat, depth: Nat, name: String, start: Nat, end: Nat, elapsed: Nat}

type KernelState is Data:
  KernelState{root: Nat, start: Nat, end: Nat, next: Nat, tasks: Map<&2, KernelTask>, spans: List<&2, KernelSpan>, faults: Nat, pending: Nat}

type KernelTrace is Data:
  KernelTrace{duration: Nat, extent: Nat, closed: Bool, spans: List<&2, KernelSpan>, faults: Nat, pending: Nat}

def time(event: KernelEvent) -> Nat:
  match event:
    case ProcessRoot{at, pid}: at
    case ProcessFork{at, parent, pid}: at
    case ProcessExec{at, pid, image}: at
    case ProcessExit{at, pid}: at

def event_before(left: KernelEvent, right: KernelEvent) -> Bool:
  Nat.is_le(time(left), time(right))

def empty_state() -> KernelState:
  KernelState{0n, 0n, 0n, 2n, Map.new(&2, KernelTask), [], 0n, 0n}

def close_span(+id: Nat, parent: Nat, depth: Nat, image: String, +start: Nat, +end: Nat, +spans: List<&2, KernelSpan>) -> List<&2, KernelSpan>:
  Bool.pick(List<&2, KernelSpan>, Bool.and(Nat.is_lt(0n, id), Nat.is_le(start, end)),
    KernelSpan{id, parent, depth, image, start, end, Nat.sub(end, start)} <> spans, spans)

def register_task(found: Map<&2, KernelTask> & KernelTask, root: Nat, start: Nat, end: Nat, next: Nat,
                  key: String, slot: KernelTask, spans: List<&2, KernelSpan>, faults: Nat, pending: Nat) -> KernelState:
  match found:
    case (tasks, Absent{}):
      KernelState{root, start, end, next, Map.set(&2, KernelTask, tasks, key, slot), spans, faults, pending}
    case (tasks, KernelTask{parent, depth, id, image, since}):
      KernelState{root, start, end, next, tasks, spans, Nat.add(faults, 1n), pending}

def fork_found(found: Map<&2, KernelTask> & KernelTask, root: Nat, start: Nat, end: Nat, next: Nat, pid: Nat,
               spans: List<&2, KernelSpan>, faults: Nat, pending: Nat) -> KernelState:
  match found:
    case (tasks, Absent{}):
      KernelState{root, start, end, next, tasks, spans, Nat.add(faults, 1n), pending}
    case (tasks, KernelTask{ancestor, +depth, +id, image, since}):
      parent = Bool.pick(Nat, Nat.is_lt(0n, id), id, ancestor)
      level = Bool.pick(Nat, Nat.is_lt(0n, id), Nat.add(depth, 1n), depth)
      +key = Nat.show(pid)
      register_task(Map.get(KernelTask, Absent{}, tasks, key), root, start, end, next, key,
        KernelTask{parent, level, 0n, "", 0n}, spans, faults, pending)

def on_fork(state: KernelState, parent_pid: Nat, pid: Nat) -> KernelState:
  match state:
    case KernelState{root, start, end, next, tasks, spans, faults, pending}:
      fork_found(Map.get(KernelTask, Absent{}, tasks, Nat.show(parent_pid)), root, start, end, next, pid, spans, faults, pending)

def exec_found(found: Map<&2, KernelTask> & KernelTask, root: Nat, +start: Nat, end: Nat, +next: Nat, key: String,
               +at: Nat, name: String, spans: List<&2, KernelSpan>, faults: Nat, pending: Nat) -> KernelState:
  match found:
    case (tasks, Absent{}):
      KernelState{root, start, end, next, tasks, spans, Nat.add(faults, 1n), pending}
    case (tasks, KernelTask{+parent, +depth, +id, image, since}):
      KernelState{root, start, end, Nat.add(next, 1n),
        Map.set(&2, KernelTask, tasks, key, KernelTask{parent, depth, next, name, Nat.sub(at, start)}),
        close_span(id, parent, depth, image, since, Nat.sub(at, start), spans), faults,
        Nat.add(pending, Bool.pick(Nat, Nat.is_eq(id, 0n), 1n, 0n))}

def on_exec(state: KernelState, at: Nat, pid: Nat, name: String) -> KernelState:
  match state:
    case KernelState{root, start, end, next, tasks, spans, faults, pending}:
      +key = Nat.show(pid)
      exec_found(Map.get(KernelTask, Absent{}, tasks, key), root, start, end, next, key, at, name, spans, faults, pending)

def exit_found(found: Map<&2, KernelTask> & KernelTask, +root: Nat, +start: Nat, +end: Nat, next: Nat, +pid: Nat,
               +at: Nat, spans: List<&2, KernelSpan>, faults: Nat, pending: Nat) -> KernelState:
  match found:
    case (tasks, Absent{}):
      KernelState{root, start, end, next, tasks, spans, Nat.add(faults, 1n), pending}
    case (tasks, KernelTask{parent, depth, +id, image, since}):
      KernelState{root, start, Bool.pick(Nat, Bool.and(Nat.is_eq(end, 0n), Nat.is_eq(root, pid)), at, end), next,
        Map.set(&2, KernelTask, tasks, Nat.show(pid), Absent{}),
        close_span(id, parent, depth, image, since, Nat.sub(at, start), spans), faults,
        Nat.sub(pending, Bool.pick(Nat, Nat.is_eq(id, 0n), 0n, 1n))}

def on_exit(state: KernelState, at: Nat, +pid: Nat) -> KernelState:
  match state:
    case KernelState{root, start, end, next, tasks, spans, faults, pending}:
      exit_found(Map.get(KernelTask, Absent{}, tasks, Nat.show(pid)), root, start, end, next, pid, at, spans, faults, pending)

def operation(+image: String) -> String:
  match image:
    case "bash": "Bash"
    case "cargo": "Cargo"
    case "rustc": "Rust compiler (rustc)"
    case "cc": "C linker driver"
    case "collect2": "Linker wrapper"
    case "rust-lld": "Rust linker"
    case "ld": "Linker"
    case "sh": "Shell"
    case "zsh": "Zsh"
    case "rustup": "Rustup"
    case "git": "Git"
    case _: "Unidentified executable"

def on_root(state: KernelState, +at: Nat, +pid: Nat) -> KernelState:
  match state:
    case KernelState{+root, start, end, next, +tasks, +spans, +faults, +pending}:
      Bool.pick(KernelState, Nat.is_eq(root, 0n),
        KernelState{pid, at, 0n, 2n, Map.set(&2, KernelTask, tasks, Nat.show(pid), KernelTask{1n, 1n, 0n, "", 0n}), spans, faults, pending},
        KernelState{root, start, end, next, tasks, spans, Nat.add(faults, 1n), pending})

def step(state: KernelState, event: KernelEvent) -> KernelState:
  match event:
    case ProcessRoot{at, pid}: on_root(state, at, pid)
    case ProcessFork{at, parent, pid}: on_fork(state, parent, pid)
    case ProcessExec{at, pid, image}: on_exec(state, at, pid, operation(image))
    case ProcessExit{at, pid}: on_exit(state, at, pid)

def span_before(left: KernelSpan, right: KernelSpan) -> Bool:
  match left right:
    case KernelSpan{id, parent, depth, name, a, end, elapsed} KernelSpan{other, ancestor, level, label, b, finish, duration}: Nat.is_le(a, b)

def latest_event(at: Nat, event: KernelEvent) -> Nat:
  Nat.max(at, time(event))

def finish(state: KernelState, last: Nat) -> KernelTrace:
  match state:
    case KernelState{root, +start, +end, next, tasks, spans, faults, pending}:
      KernelTrace{Nat.sub(end, start), Nat.sub(last, start), Nat.is_lt(0n, end),
        List.sort(~KernelSpan, ~span_before, spans),
        Nat.add(faults, Bool.pick(Nat, Bool.and(Nat.is_lt(0n, root), Nat.is_lt(2n, next)), 0n, 1n)), pending}

def trace(+events: List<&2, KernelEvent>) -> KernelTrace:
  ordered = List.sort(~KernelEvent, ~event_before, events)
  finish(List.foldl(~&2, ~KernelEvent, ~KernelState, ~step, ordered, empty_state()),
    List.foldl(~&2, ~KernelEvent, ~Nat, ~latest_event, events, 0n))

def binding(+expected_line: Nat, +expected_start: Nat, line: Nat, start: Nat, ambiguous: Bool) -> Bool:
  Bool.and(Bool.not(ambiguous), Bool.and(Nat.is_lt(0n, expected_line), Bool.and(Nat.is_lt(0n, expected_start),
    Bool.and(Nat.is_eq(expected_line, line), Nat.is_eq(expected_start, start)))))

def admission(faults: Nat, +events: Nat, elapsed: Nat, quiet: Bool) -> Bool:
  Bool.and(quiet, Bool.and(Nat.is_eq(faults, 0n), Bool.and(Nat.is_lt(1n, events),
    Bool.and(Nat.is_le(events, 4096n), Nat.is_le(elapsed, 120000000n)))))

type CaptureRef is Data:
  CaptureRef{key: String, at: Nat}

def capture_before(left: CaptureRef, right: CaptureRef) -> Bool:
  match left right:
    case CaptureRef{key, a} CaptureRef{other, b}: Nat.is_le(b, a)

def capture_visible(at: Nat, cutoff: Nat) -> Bool:
  Nat.is_le(at, cutoff)

def visible_captures(captures: List<&2, CaptureRef>) -> List<&2, CaptureRef>:
  List.take(&2, CaptureRef, List.sort(~CaptureRef, ~capture_before, captures), 8n)

def probe(parent: Nat, owner: Nat, major: Nat, minor: Nat, inode: Nat) -> String:
  String.concat([
    "BEGIN { printf(\"ready\\n\"); }\n",
    "tracepoint:sched:sched_process_exec /uid == ", Nat.show(owner), "/ {\n",
    "  $task = (struct task_struct *)curtask;\n",
    "  $inode = $task->fs->pwd.dentry->d_inode;\n",
    "  $dev = $inode->i_sb->s_dev;\n",
    "  if (@root == 0 && $task->real_parent->tgid == ", Nat.show(parent),
    " && $inode->i_ino == ", Nat.show(inode),
    " && ($dev >> 20) == ", Nat.show(major), " && ($dev & 1048575) == ", Nat.show(minor),
    " && (comm == \"bash\" || comm == \"sh\" || comm == \"zsh\")) {\n",
    "    @root = tid; @seen[tid] = 1; printf(\"root %llu %d\\n\", nsecs, tid);\n",
    "  }\n",
    "  if (@seen[tid]) {\n",
    "    if (comm == \"bash\" || comm == \"sh\" || comm == \"zsh\" || comm == \"cargo\" || comm == \"rustc\" || comm == \"rustup\" || ",
    "comm == \"git\" || comm == \"cc\" || comm == \"ld\" || comm == \"rust-lld\" || comm == \"collect2\") {\n",
    "      printf(\"exec %llu %d %s\\n\", nsecs, tid, comm);\n",
    "    } else { printf(\"exec %llu %d other\\n\", nsecs, tid); }\n",
    "  }\n}\n",
    "tracepoint:sched:sched_process_fork /@seen[tid]/ {\n",
    "  @seen[args->child_pid] = 1; printf(\"fork %llu %d %d\\n\", nsecs, args->parent_pid, args->child_pid);\n",
    "}\n",
    "tracepoint:sched:sched_process_exit /@seen[tid]/ {\n",
    "  printf(\"exit %llu %d\\n\", nsecs, tid); delete(@seen[tid]); if (tid == @root) { exit(); }\n",
    "}\n",
    "END { clear(@seen); clear(@root); printf(\"done\\n\"); }\n"
  ])
