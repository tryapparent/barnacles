import Base
import ./trace-wire.bend as Wire
import 0x419ec39802735c4664960ab4b9d962e5/json.bend as Json
import 0xec25e4adfb02e59e4b817801115988ee/bytes.bend as Bytes
import 0x29d6f1ff259add9ea6c8f213fda12377/sha256.bend as Sha

type TracePayload is Data:
  TracePayload{trace_id: String, payload_bytes: String}

def normalize_escapes(chars: List<&2, Char>, reverse: List<&2, Char>) -> List<&2, Char>:
  match chars:
    case []: List.reverse(&2, Char, reverse)
    case '\\' <> '\\' <> tail: normalize_escapes(tail, '\\' <> '\\' <> reverse)
    case '\\' <> 'u' <> '0' <> '0' <> '0' <> '8' <> tail: normalize_escapes(tail, 'b' <> '\\' <> reverse)
    case '\\' <> 'u' <> '0' <> '0' <> '0' <> 'c' <> tail: normalize_escapes(tail, 'f' <> '\\' <> reverse)
    case char <> tail: normalize_escapes(tail, char <> reverse)

def normalized(+value: String, escapes: Bool) -> String:
  match escapes:
    case False{}: value
    case True{}: String.from_list(normalize_escapes(String.to_list(value), []))

def canonical(+value: String) -> String:
  normalized(value, String.contains(value, "\\u000"))

def render_bytes(value: Json.Val) -> String:
  canonical(Bytes.to_string(Json.encode.bytes(value)))

def text(value: String) -> Json.Val:
  Json.Str{Json.utf8(value)}

def field(key: String, value: Json.Val) -> Bytes.Bytes & Json.Val:
  (Json.utf8(key), value)

def text_field(key: String, value: String) -> Bytes.Bytes & Json.Val:
  field(key, text(value))

def strings(parts: List<&2, String>, reverse: List<&1, Json.Val>) -> List<&1, Json.Val>:
  match parts:
    case []: List.reverse(&1, Json.Val, reverse)
    case value <> tail: strings(tail, text(value) <> reverse)

def encode_strings(parts: List<&2, String>) -> String:
  render_bytes(Json.Arr{strings(parts, [])})

def wire_key_bytes(instance: String, session: String) -> String:
  encode_strings([instance, session])

def unpack(count: Nat, +index: U32, current: Array<U32> & U32, reverse: List<&2, U32>) -> List<&2, U32>:
  match count:
    case 0n: List.reverse(&2, U32, reverse)
    case 1n+rest:
      (array, byte) = current
      unpack(rest, U32.inc(index), Bytes.peek(array, U32.inc(index)), byte <> reverse)

def hash_bytes(input: Bytes.Bytes, length: Nat) -> String:
  match input:
    case Bytes.Bytes{size, data}:
      String.take(Sha.hex(Sha.digest(unpack(U32.to_nat(size), 0, Bytes.peek(data, 0), []))), length)

def stable_id(parts: List<&2, String>, length: Nat) -> String:
  hash_bytes(Bytes.from_string(encode_strings(parts)), length)

def attribute(attr: Wire.TraceAttribute) -> Json.Val:
  match attr:
    case Wire.TextAttribute{key, value}: Json.Obj{[text_field("key", key), field("value", Json.Obj{[text_field("stringValue", value)]})]}
    case Wire.IntAttribute{key, value}: Json.Obj{[text_field("key", key), field("value", Json.Obj{[text_field("intValue", value)]})]}

def attributes(attrs: List<&2, Wire.TraceAttribute>, reverse: List<&1, Json.Val>) -> Json.Val:
  match attrs:
    case []: Json.Arr{List.reverse(&1, Json.Val, reverse)}
    case row <> tail: attributes(tail, attribute(row) <> reverse)

def event(value: Wire.TraceEvent) -> Json.Val:
  match value:
    case Wire.Event{name, time, attrs}:
      Json.Obj{[text_field("name", name), text_field("timeUnixNano", time), field("attributes", attributes(attrs, []))]}

def events(values: List<&2, Wire.TraceEvent>, reverse: List<&1, Json.Val>) -> Json.Val:
  match values:
    case []: Json.Arr{List.reverse(&1, Json.Val, reverse)}
    case row <> tail: events(tail, event(row) <> reverse)

def event_fields(values: Maybe<&2, List<&2, Wire.TraceEvent>>) -> List<&1, Bytes.Bytes & Json.Val>:
  match values:
    case None{}: []
    case Some{items}: [field("events", events(items, []))]

def parent_field(parent: Maybe<&2, List<&2, String>>, rest: List<&1, Bytes.Bytes & Json.Val>) ->
    List<&1, Bytes.Bytes & Json.Val>:
  match parent:
    case None{}: rest
    case Some{parts}: text_field("parentSpanId", stable_id(parts, 16n)) <> rest

def span(trace: String, value: Wire.TraceWireSpan) -> Json.Val:
  match value:
    case Wire.WireSpan{id, parent, name, kind, start, end, attrs, recorded}:
      Json.Obj{text_field("traceId", trace) <> text_field("spanId", stable_id(id, 16n)) <>
        parent_field(parent, text_field("name", name) <> field("kind", Json.Num{Json.utf8(Nat.show(U32.to_nat(kind)))}) <>
          text_field("startTimeUnixNano", start) <> text_field("endTimeUnixNano", end) <>
          field("attributes", attributes(attrs, [])) <> event_fields(recorded))}

def spans(+id: String, values: List<&2, Wire.TraceWireSpan>, reverse: List<&1, Json.Val>) -> Json.Val:
  match values:
    case []: Json.Arr{List.reverse(&1, Json.Val, reverse)}
    case row <> tail: spans(id, tail, span(id, row) <> reverse)

def resource_spans(id: String, resource: List<&2, Wire.TraceAttribute>, scope: String, values: List<&2, Wire.TraceWireSpan>) -> Json.Val:
  scope_span : Json.Val = Json.Obj{[field("scope", Json.Obj{[text_field("name", scope)]}), field("spans", spans(id, values, []))]}
  entry : Json.Val = Json.Obj{[field("resource", Json.Obj{[field("attributes", attributes(resource, []))]}),
    field("scopeSpans", Json.Arr{[scope_span]})]}
  Json.Obj{[field("resourceSpans", Json.Arr{[entry]})]}

def encode(value: Wire.TraceWire) -> TracePayload:
  match value:
    case Wire.WireTrace{parts, resource, scope, rows}:
      +id = stable_id(parts, 32n)
      TracePayload{id, render_bytes(resource_spans(id, resource, scope, rows))}
