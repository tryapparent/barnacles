import Base

type TraceAttribute is Data:
  TextAttribute{key: String, value: String}
  IntAttribute{key: String, value: String}

type TraceEvent is Data:
  Event{name: String, time: String, attributes: List<&2, TraceAttribute>}

type TraceWireSpan is Data:
  WireSpan{id: List<&2, String>, parent: Maybe<&2, List<&2, String>>, name: String, kind: U32, start: String,
    end: String, attributes: List<&2, TraceAttribute>, events: Maybe<&2, List<&2, TraceEvent>>}

type TraceWire is Data:
  WireTrace{id: List<&2, String>, resource: List<&2, TraceAttribute>, scope: String, spans: List<&2, TraceWireSpan>}
