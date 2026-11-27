import Base
import ./codex-otel.bend as Otlp

type T3Span is Data:
  T3Span{trace_id: String, span_id: String, parent_id: String, operation: String,
    start_ns: String, end_ns: String, thread_id: String, command_id: String, command_type: String}

type Admission is Data:
  UnrecognizedSpan{}
  InvalidSpan{}
  ObservedSpan{fact: T3Span}

def source_service(service: String) -> Bool:
  String.eq(service, "t3code-server")

def source_instance(expected: String, received: String) -> Bool:
  String.eq(expected, received)

def known_operation(value: String) -> Bool:
  List.contains(~String, ~String.eq, ["orchestrationV2.dispatch.once", "orchestrationV2.dispatch.withReceipt",
    "orchestrationV2.dispatch.threadCreate", "server.startup", "server.shutdown"], value)

def keep_command_type(+value: String) -> String:
  Bool.pick(String, List.contains(~String, ~String.eq, ["thread.create", "thread.archive"], value), value, "")

def observe_span(+trace_id: String, +span_id: String, +parent_id: String, +operation: String,
    +start_ns: String, +end_ns: String, thread_id: String, command_id: String, command_type: String) -> Admission:
  +parent_valid = Bool.or(String.eq(parent_id, ""), Bool.and(Otlp.trace_identity(parent_id, 16n),
    Bool.not(String.eq(span_id, parent_id))))
  +id_valid = Bool.and(Otlp.trace_identity(trace_id, 32n), Bool.and(Otlp.trace_identity(span_id, 16n), parent_valid))
  +time_valid = Bool.and(Otlp.clock(start_ns), Bool.and(Otlp.clock(end_ns), Otlp.decimal_before_or_equal(start_ns, end_ns)))
  Bool.pick(Admission, known_operation(operation),
    Bool.pick(Admission, Bool.and(id_valid, time_valid),
      ObservedSpan{T3Span{trace_id, span_id, parent_id, operation, start_ns, end_ns,
        Otlp.keep_uuid(thread_id), Otlp.keep_uuid(command_id), keep_command_type(command_type)}}, InvalidSpan{}),
    UnrecognizedSpan{})

def admit_replay(saved: String, received: String) -> Bool:
  String.eq(saved, received)
