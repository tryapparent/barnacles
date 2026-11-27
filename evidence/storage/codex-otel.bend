import Base

type NativeSpan is Data:
  NativeSpan{trace_id: String, span_id: String, parent_id: String, operation: String,
    start_ns: String, end_ns: String, conversation: String, turn: String, call: String, status: U32}

type NativeEvent is Data:
  NativeEvent{event: String, at_ns: String, conversation: String, turn: String, call: String,
    duration_ms: String, success: String}

type SpanAdmission is Data:
  UnrecognizedSpan{}
  InvalidSpan{}
  ObservedSpan{fact: NativeSpan}

type EventAdmission is Data:
  UnrecognizedEvent{}
  InvalidEvent{}
  ObservedEvent{fact: NativeEvent}

def all_digits(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: True{}
    case char <> rest: Bool.and(Char.is_digit(char), all_digits(rest))

def all_hex(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: True{}
    case +char <> rest:
      Bool.and(Bool.or(Char.is_digit(char), String.contains("abcdef", String.from_list([char]))), all_hex(rest))

def any_nonzero(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: False{}
    case char <> rest: Bool.or(Bool.not(Char.is_eq(char, '0')), any_nonzero(rest))

def hex_size(+value: String, size: Nat) -> Bool:
  Bool.and(Nat.is_eq(String.length(value), size), all_hex(String.to_list(value)))

def trace_identity(+value: String, size: Nat) -> Bool:
  Bool.and(hex_size(value, size), any_nonzero(String.to_list(value)))

def uuid_parts(parts: List<&2, String>) -> Bool:
  match parts:
    case a <> b <> c <> d <> e <> []:
      Bool.and(hex_size(a, 8n), Bool.and(hex_size(b, 4n), Bool.and(hex_size(c, 4n),
        Bool.and(hex_size(d, 4n), hex_size(e, 12n)))))
    case _: False{}

def keep_uuid(+value: String) -> String:
  Bool.pick(String, uuid_parts(String.split(value, '-')), value, "")

def call_chars(chars: List<&2, Char>) -> Bool:
  match chars:
    case []: True{}
    case +char <> rest:
      +allowed = Bool.or(Char.is_digit(char), String.contains(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-", String.from_list([char])))
      Bool.and(allowed, call_chars(rest))

def keep_call(+value: String) -> String:
  +length = String.length(value)
  +valid = Bool.and(Nat.is_ge(length, 6n), Bool.and(Nat.is_le(length, 101n),
    Bool.and(String.starts_with(value, "call_"), call_chars(String.to_list(value)))))
  Bool.pick(String, valid, value, "")

def small_decimal(+value: String, max_length: Nat) -> Bool:
  +length = String.length(value)
  Bool.and(Nat.is_gt(length, 0n),
    Bool.and(Nat.is_le(length, max_length), all_digits(String.to_list(value))))

def decimal_before_or_equal(+first: String, +second: String) -> Bool:
  +a = String.length(first)
  +b = String.length(second)
  Bool.or(Nat.is_lt(a, b), Bool.and(Nat.is_eq(a, b), Bool.not(String.is_lt(second, first))))

def clock(+value: String) -> Bool:
  Bool.and(small_decimal(value, 20n), Bool.and(Bool.not(String.starts_with(value, "0")),
    decimal_before_or_equal(value, "18446744073709551615")))

def known_operation(value: String) -> Bool:
  List.contains(~String, ~String.eq, ["session_loop", "session_task.turn", "run_turn", "codex.sampling",
    "codex.tool_blocking", "codex.process.spawn", "dispatch_tool_call_with_state", "exec_command",
    "write_stdin", "unified_exec.exec_command", "unified_exec.write_stdin", "codex.span"], value)

def known_event(value: String) -> Bool:
  List.contains(~String, ~String.eq, ["codex.api_request", "codex.tool_result", "codex.tool_call_received",
    "codex.tool_result_ready", "codex.turn_ttft"], value)

def observe_span(+trace_id: String, +span_id: String, +parent_id: String, +operation: String,
    +start_ns: String, +end_ns: String, conversation: String, turn: String, call: String, +status: U32) -> SpanAdmission:
  +parent_valid = Bool.or(String.eq(parent_id, ""), Bool.and(trace_identity(parent_id, 16n),
    Bool.not(String.eq(span_id, parent_id))))
  +id_valid = Bool.and(trace_identity(trace_id, 32n), Bool.and(trace_identity(span_id, 16n), parent_valid))
  +time_valid = Bool.and(clock(start_ns), Bool.and(clock(end_ns), decimal_before_or_equal(start_ns, end_ns)))
  Bool.pick(SpanAdmission, known_operation(operation),
    Bool.pick(SpanAdmission, Bool.and(id_valid, time_valid),
      ObservedSpan{NativeSpan{trace_id, span_id, parent_id, operation, start_ns, end_ns,
        keep_uuid(conversation), keep_uuid(turn), keep_call(call), Bool.pick(U32, U32.is_le(status, 2), status, 0)}}, InvalidSpan{}), UnrecognizedSpan{})

def observe_event(+event: String, +at_ns: String, conversation: String, turn: String, call: String,
    +duration_ms: String, +success: String) -> EventAdmission:
  Bool.pick(EventAdmission, known_event(event),
    Bool.pick(EventAdmission, clock(at_ns),
      ObservedEvent{NativeEvent{event, at_ns, keep_uuid(conversation), keep_uuid(turn), keep_call(call),
        Bool.pick(String, small_decimal(duration_ms, 10n), duration_ms, ""),
        Bool.pick(String, Bool.or(String.eq(success, "true"), String.eq(success, "false")), success, "")}},
      InvalidEvent{}), UnrecognizedEvent{})

def admit_replay(saved: String, received: String) -> Bool:
  String.eq(saved, received)
