import Base
import ../project.bend as P
import 0x419ec39802735c4664960ab4b9d962e5/json.bend as J
import 0xec25e4adfb02e59e4b817801115988ee/bytes.bend as Bytes

type ReplaySpan is Data:
  ReplaySpan{id: String, parent: String, name: String, start: String, end: String, status: U32,
    conversation: String, turn: String, call: String, events: List<&2, ReplayEvent>}

type ReplayEvent is Data:
  ReplayEvent{name: String, at: String, conversation: String, turn: String, call: String, duration: String, success: String}

type ReplayExisting is Data:
  ReplayExisting{trace: String, id: String, parent: String, start: String, end: String,
    service: String, scope: String, source: String, coverage: String}

type Plan is Data:
  ReplaySkipped{reason: String}
  ReplayReady{body: String}

def trace_limit() -> U32:
  32

def span_limit() -> U32:
  512

def event_limit() -> U32:
  2048

def chars(input: String, +allowed: String) -> Bool:
  match input:
    case SNil{}: True{}
    case SCon{ch,tail}: Bool.and(String.contains(allowed,String.from_list([ch])),chars(tail,allowed))

def hex(+input: String,size: Nat) -> Bool:
  Bool.and(Nat.is_eq(String.length(input),size),chars(input,"0123456789abcdef"))

def native_id(+input: String,size: Nat) -> Bool:
  Bool.and(hex(input,size),Bool.not(chars(input,"0")))

def trace_ids(ids: List<&2,String>) -> Bool:
  match ids:
    case []: True{}
    case +id <> +rest:
      Bool.and(native_id(id,32n),Bool.and(Bool.not(List.contains(~String,~String.eq,rest,id)),trace_ids(rest)))

def decimal(+input: String,width: Nat) -> Bool:
  +length = String.length(input)
  Bool.and(Bool.and(Nat.is_gt(length,0n),Nat.is_le(length,width)),chars(input,"0123456789"))

def before(+a: String,+b: String) -> Bool:
  +x = String.length(a)
  +y = String.length(b)
  Bool.or(Nat.is_lt(x,y),Bool.and(Nat.is_eq(x,y),String.is_lt(a,b)))

def clock(+input: String) -> Bool:
  Bool.and(decimal(input,20n),Bool.and(Bool.not(String.starts_with(input,"0")),
    Bool.not(before("18446744073709551615",input))))

def seconds(+clock: String) -> Maybe<&2,Nat>:
  +prefix = Nat.sub(String.length(clock),9n)
  Nat.read(Bool.pick(String,Nat.is_eq(prefix,0n),"0",String.take(clock,prefix)))

def fraction(+clock: String) -> Maybe<&2,Nat>:
  Nat.read(String.drop(clock,Nat.sub(String.length(clock),9n)))

def short_window(first: Maybe<&2,Nat>,last: Maybe<&2,Nat>,first_fraction: Maybe<&2,Nat>,
    last_fraction: Maybe<&2,Nat>) -> Bool:
  match first last first_fraction last_fraction:
    case Some{a} Some{b} Some{x} Some{y}:
      +delta = Nat.sub(b,a)
      Bool.or(Nat.is_lt(delta,86400n),Bool.and(Nat.is_eq(delta,86400n),Nat.is_le(y,x)))
    case _ _ _ _: False{}

def manifest(+instance: String,+first: String,+last: String,+cutover: String,+ids: List<&2,String>) -> Bool:
  +count = List.length(&2,String,ids)
  +window = Bool.and(before(first,last),Bool.and(Bool.not(before(cutover,last)),short_window(seconds(first),seconds(last),fraction(first),fraction(last))))
  +bounds = Bool.and(clock(first),Bool.and(clock(last),clock(cutover)))
  Bool.and(P.token(instance),Bool.and(Bool.and(window,bounds),
    Bool.and(Nat.is_gt(count,0n),Bool.and(Nat.is_le(count,U32.to_nat(trace_limit)),trace_ids(ids)))))

def inside(+at: String,first: String,last: String) -> Bool:
  Bool.and(clock(at),Bool.and(Bool.not(before(at,first)),before(at,last)))

def uuid_parts(parts: List<&2,String>) -> Bool:
  match parts:
    case a <> b <> c <> d <> e <> []:
      Bool.and(hex(a,8n),Bool.and(hex(b,4n),Bool.and(hex(c,4n),Bool.and(hex(d,4n),hex(e,12n)))))
    case _: False{}

def call_id(+input: String) -> Bool:
  +length = String.length(input)
  Bool.and(Nat.is_ge(length,6n),Bool.and(Nat.is_le(length,101n),Bool.and(String.starts_with(input,"call_"),
    chars(input,"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-"))))

def field(key: String,value: J.Val) -> Bytes.Bytes & J.Val:
  (J.utf8(key),value)

def attribute(key: String,value: String) -> J.Val:
  J.Obj{[P.text_field("key",key),field("value",J.Obj{[P.text_field("stringValue",value)]})]}

def keep(allowed: Bool,key: String,value: String,tail: List<&1,J.Val>) -> List<&1,J.Val>:
  match allowed:
    case True{}: attribute(key,value) <> tail
    case False{}: tail

def attributes(+conversation: String,+turn: String,+call: String,tail: List<&1,J.Val>) -> J.Val:
  J.Arr{keep(uuid_parts(String.split(conversation,'-')),"conversation.id",conversation,
    keep(uuid_parts(String.split(turn,'-')),"turn.id",turn,
      keep(call_id(call),"call_id",call,tail)))}

def operation(+name: String) -> String:
  Bool.pick(String,List.contains(~String,~String.eq,["session_loop","session_task.turn","run_turn",
    "codex.sampling","codex.tool_blocking","codex.process.spawn","dispatch_tool_call_with_state","exec_command",
    "write_stdin","unified_exec.exec_command","unified_exec.write_stdin"],name),name,"codex.span")

def event_name(+name: String) -> String:
  Bool.pick(String,List.contains(~String,~String.eq,["codex.api_request","codex.tool_result","codex.tool_call_received",
    "codex.tool_result_ready","codex.turn_ttft"],name),name,"codex.event")

def event_wire(event: ReplayEvent) -> J.Val:
  match event:
    case ReplayEvent{name,at,conversation,turn,call,+duration,+success}:
      extra = keep(decimal(duration,10n),"duration_ms",duration,
        keep(Bool.or(String.eq(success,"true"),String.eq(success,"false")),"success",success,[]))
      J.Obj{[P.text_field("name",event_name(name)),P.text_field("timeUnixNano",at),
        field("attributes",attributes(conversation,turn,call,extra))]}

def events_wire(events: List<&2,ReplayEvent>) -> List<&1,J.Val>:
  match events:
    case []: []
    case event <> rest: event_wire(event) <> events_wire(rest)

def optional_text(empty: Bool,key: String,value: String,tail: List<&1,Bytes.Bytes & J.Val>) -> List<&1,Bytes.Bytes & J.Val>:
  match empty:
    case True{}: tail
    case False{}: P.text_field(key,value) <> tail

def status_wire(status: U32) -> List<&1,Bytes.Bytes & J.Val>:
  match status:
    case 0: []
    case _: [field("status",J.Obj{[P.clock_field("code",U32.to_nat(status))]})]

def span_wire(trace: String,span: ReplaySpan) -> J.Val:
  match span:
    case ReplaySpan{id,+parent,name,start,end,status,conversation,turn,call,events}:
      J.Obj{P.text_field("traceId",trace) <> P.text_field("spanId",id) <> P.text_field("name",operation(name))
        <> P.text_field("startTimeUnixNano",start) <> P.text_field("endTimeUnixNano",end)
        <> field("attributes",attributes(conversation,turn,call,[]))
        <> field("events",J.Arr{events_wire(events)})
        <> optional_text(String.is_empty(parent),"parentSpanId",parent,status_wire(status))}

def events_inside(events: List<&2,ReplayEvent>,+first: String,+last: String) -> Bool:
  match events:
    case []: True{}
    case ReplayEvent{_,at,_,_,_,_,_} <> rest: Bool.and(inside(at,first,last),events_inside(rest,first,last))

def valid_span(span: ReplaySpan,+first: String,+last: String) -> Bool:
  match span:
    case ReplaySpan{+id,+parent,_,+start,+end,status,_,_,_,events}:
      +parent_valid = Bool.or(String.is_empty(parent),Bool.and(native_id(parent,16n),Bool.not(String.eq(parent,id))))
      +times = Bool.and(inside(start,first,last),Bool.and(inside(end,first,last),Bool.not(before(end,start))))
      Bool.and(native_id(id,16n),Bool.and(parent_valid,Bool.and(U32.is_le(status,2),
        Bool.and(times,events_inside(events,first,last)))))

def spans_inside(spans: List<&2,ReplaySpan>,+first: String,+last: String) -> Bool:
  match spans:
    case []: True{}
    case span <> rest: Bool.and(valid_span(span,first,last),spans_inside(rest,first,last))

def spans_wire(+trace: String,spans: List<&2,ReplaySpan>) -> List<&1,J.Val>:
  match spans:
    case []: []
    case span <> rest: span_wire(trace,span) <> spans_wire(trace,rest)

def replay_payload(+trace: String,spans: List<&2,ReplaySpan>) -> String:
  resource : J.Val = J.Obj{[field("attributes",J.Arr{[attribute("service.name","plow.codex"),
    attribute("plow.replay.source","legacy-sqlite"),attribute("plow.replay.coverage","partial")]})]}
  scope : J.Val = J.Obj{[field("scope",J.Obj{[P.text_field("name","plow.codex")]}),
    field("spans",J.Arr{spans_wire(trace,spans)})]}
  P.render(J.Obj{[field("resourceSpans",J.Arr{[J.Obj{[field("resource",resource),
    field("scopeSpans",J.Arr{[scope]})]}]})]})

def admitted(+trace: String,+spans: List<&2,ReplaySpan>, bounded: Bool, inside_window: Bool) -> Plan:
  match spans bounded inside_window:
    case [] _ _: ReplaySkipped{"source-absent"}
    case _ False{} _: ReplaySkipped{"source-limit"}
    case _ True{} False{}: ReplaySkipped{"invalid-or-outside-window"}
    case _ True{} True{}: ReplayReady{replay_payload(trace,spans)}

def event_count(spans: List<&2,ReplaySpan>) -> Nat:
  match spans:
    case []: 0n
    case ReplaySpan{_,_,_,_,_,_,_,_,_,events} <> rest:
      Nat.add(List.length(&2,ReplayEvent,events),event_count(rest))

def plan(+trace: String,+spans: List<&2,ReplaySpan>,first: String,last: String,+events: U32) -> Plan:
  +count = List.length(&2,ReplaySpan,spans)
  +bounded = Bool.and(Nat.is_le(count,U32.to_nat(span_limit)),U32.is_le(events,event_limit))
  admitted(trace,spans,bounded,Bool.and(Nat.is_eq(event_count(spans),U32.to_nat(events)),spans_inside(spans,first,last)))

def is_replay(trace: String,span: ReplaySpan,existing: ReplayExisting) -> Bool:
  match span existing:
    case ReplaySpan{id,parent,_,start,end,_,_,_,_,_} ReplayExisting{other,other_id,other_parent,other_start,other_end,service,scope,source,coverage}:
      Bool.and(String.eq(trace,other),Bool.and(String.eq(id,other_id),Bool.and(String.eq(parent,other_parent),
        Bool.and(String.eq(start,other_start),Bool.and(String.eq(end,other_end),Bool.and(String.eq(service,"plow.codex"),
        Bool.and(String.eq(scope,"plow.codex"),Bool.and(String.eq(source,"legacy-sqlite"),String.eq(coverage,"partial")))))))))

def includes_span(+trace: String,+span: ReplaySpan,existing: List<&2,ReplayExisting>) -> Bool:
  match existing:
    case []: False{}
    case item <> rest: List.any.if(u => includes_span(trace,span,rest),is_replay(trace,span,item))

def includes_spans(+trace: String,spans: List<&2,ReplaySpan>,+existing: List<&2,ReplayExisting>) -> Bool:
  match spans:
    case []: True{}
    case span <> rest:
      Bool.and(includes_span(trace,span,existing),includes_spans(trace,rest,existing))

def confirmed(+trace: String,+spans: List<&2,ReplaySpan>,+existing: List<&2,ReplayExisting>) -> Bool:
  Bool.and(Nat.is_eq(List.length(&2,ReplaySpan,spans),List.length(&2,ReplayExisting,existing)),includes_spans(trace,spans,existing))

def skipped_action(reason: String,has_checkpoint: Bool) -> String:
  Bool.pick(String,has_checkpoint,"checkpoint-source-changed",reason)

def pending_action(+trace: String,spans: List<&2,ReplaySpan>,+existing: List<&2,ReplayExisting>,retry: Bool) -> String:
  match existing:
    case []: Bool.pick(String,retry,"write","pending-absent")
    case _: Bool.pick(String,confirmed(trace,spans,existing),"confirmed","checkpoint-conflict")

def next_action(+trace: String,spans: List<&2,ReplaySpan>,+existing: List<&2,ReplayExisting>,
    state: String,identical: Bool,retry: Bool) -> String:
  match state identical:
    case "" _: Bool.pick(String,Nat.is_eq(List.length(&2,ReplayExisting,existing),0n),"write","already-present")
    case _ False{}: "checkpoint-source-changed"
    case "done" True{}: "checkpointed"
    case "pending" True{}: pending_action(trace,spans,existing,retry)
    case _ _: "checkpoint-invalid"
