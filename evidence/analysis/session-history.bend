import Base

type HistoryEvent is Data:
  HistoryEvent{index: Nat, lane: Nat, start: Nat, end: Maybe<&2, Nat>, label: String,
        source: String, state: String, relation: String, clipped: Bool}

type HistorySignal is Data:
  HistorySignal{rule: String, thread: String, id: String, seconds: Nat, median: Nat, peers: Nat, event: Maybe<&2, Nat>}

type HistoryThread is Data:
  HistoryThread{id: String, sample: Nat, title: String, source: String, start: Nat, cutoff: Nat, rollout_count: Nat}

type HistoryEntry is Data:
  HistoryEntry{thread: HistoryThread, end: Nat, count: Nat, signals: Nat}

type HistoryLane is Data:
  HistoryLane{index: Nat, name: String, events: List<&2, HistoryEvent>}

type History is Data:
  History{entry: HistoryEntry, lanes: List<&2, HistoryLane>, signals: List<&2, HistorySignal>}

type EventScan is Data:
  EventScan{end: Nat, count: Nat, groups: Map<&2, List<&2, HistoryEvent>>}

def event_endpoint(end: Maybe<&2, Nat>, start: Nat) -> Nat:
  match end:
    case None{}: start
    case Some{at}: at

def add_history_event(pair: Map<&2, List<&2, HistoryEvent>> & List<&2, HistoryEvent>,
                      key: String, event: HistoryEvent, end: Nat, count: Nat) -> EventScan:
  match pair:
    case (table, values):
      EventScan{end, Nat.add(count, 1n), Map.set(&2, List<&2, HistoryEvent>, table, key, event <> values)}

def note_event(+cutoff: Nat, +event: HistoryEvent, +state: EventScan) -> EventScan:
  match event state:
    case HistoryEvent{index, +lane, +start, end, label, source, status, relation, clipped} EventScan{latest, count, groups}:
      +finish = event_endpoint(end, start)
      +key = Nat.show(lane)
      Bool.pick(EventScan, Bool.and(Nat.is_lt(lane, 13n), Bool.and(Nat.is_le(start, finish), Nat.is_le(finish, cutoff))),
        add_history_event(Map.get(List<&2, HistoryEvent>, [], groups, key), key, event, Nat.max(latest, finish), count), state)

def scan_events(events: List<&2, HistoryEvent>, +cutoff: Nat, state: EventScan) -> EventScan:
  match events:
    case []: state
    case event <> tail: scan_events(tail, cutoff, note_event(cutoff, event, state))

def lane_name(index: Nat) -> String:
  match index:
    case 0n: "T3 admission"
    case 1n: "T3 active"
    case 2n: "T3 activity"
    case 3n: "Codex tool"
    case 4n: "Observed local process"
    case 5n: "Kernel process"
    case 6n: "CI job queue"
    case 7n: "CI job execution"
    case 8n: "CI step"
    case 9n: "Git reflog"
    case 10n: "Git commit"
    case 11n: "Pull request"
    case _: "PR review"

def event_before(a: HistoryEvent, b: HistoryEvent) -> Bool:
  match a b:
    case HistoryEvent{i, _, +x, _, _, _, _, _, _} HistoryEvent{j, _, +y, _, _, _, _, _, _}:
      Bool.or(Nat.is_lt(x, y), Bool.and(Nat.is_eq(x, y), Nat.is_le(i, j)))

def history_lanes(remaining: Nat, pair: Map<&2, List<&2, HistoryEvent>> & List<&2, HistoryEvent>,
                  output: List<&2, HistoryLane>) -> List<&2, HistoryLane>:
  match remaining:
    case 0n: output
    case 1n+index:
      match pair:
        case (table, values):
          +i = index
          history_lanes(i, Map.get(List<&2, HistoryEvent>, [], table, Nat.show(Nat.sub(i, 1n))),
            HistoryLane{i, lane_name(i), List.sort(~HistoryEvent, ~event_before, values)} <> output)

def signal_before(a: HistorySignal, b: HistorySignal) -> Bool:
  match a b:
    case HistorySignal{_, _, _, x, _, _, _} HistorySignal{_, _, _, y, _, _, _}: Nat.is_le(y, x)

def signal_clock(rule: String) -> Nat:
  Bool.pick(Nat, String.eq(rule, "ci-queue"), 6n, 7n)

def job_source(parts: List<&2, String>) -> String:
  match parts:
    case [run, attempt, job]: String.concat(["/actions/runs/", run, "/job/", job])
    case _: ""

def candidate_event(cutoff: Nat, clock: Nat, suffix: String, event: HistoryEvent) -> Maybe<&2, Nat>:
  match event:
    case HistoryEvent{index, lane, +start, end, _, source, _, _, _}:
      +finish = event_endpoint(end, start)
      Bool.pick(Maybe<&2, Nat>, Bool.and(Nat.is_eq(lane, clock), Bool.and(String.ends_with(source, suffix),
        Bool.and(Nat.is_le(start, finish), Nat.is_le(finish, cutoff)))), Some{index}, None{})

def match_signal_event(events: List<&2, HistoryEvent>, found: Maybe<&2, Nat>, +cutoff: Nat, +clock: Nat, +suffix: String) -> Maybe<&2, Nat>:
  match events found:
    case _ Some{index}: found
    case Nil{} None{}: found
    case Con{head, tail} None{}:
      match_signal_event(tail, candidate_event(cutoff, clock, suffix, head), cutoff, clock, suffix)

def bind_signal(event: Maybe<&2, Nat>, signal: HistorySignal, output: List<&2, HistorySignal>) -> List<&2, HistorySignal>:
  match event signal:
    case None{} otherwise: output
    case Some{index} HistorySignal{rule, sample, id, seconds, median, peers, _}:
      HistorySignal{rule, sample, id, seconds, median, peers, Some{index}} <> output

def select_signal_event(valid: Bool, events: List<&2, HistoryEvent>, cutoff: Nat, clock: Nat, suffix: String) -> Maybe<&2, Nat>:
  match valid:
    case False{}: None{}
    case True{}: match_signal_event(events, None{}, cutoff, clock, suffix)

def signal_event(signal: HistorySignal, key: String, cutoff: Nat, events: List<&2, HistoryEvent>) -> Maybe<&2, Nat>:
  match signal:
    case HistorySignal{+rule, sample, id, _, _, _, _}:
      +suffix = job_source(String.split(id, ':'))
      select_signal_event(Bool.and(String.eq(sample, key), Bool.and(Bool.not(String.eq(suffix, "")),
        Bool.or(String.eq(rule, "ci-queue"), String.eq(rule, "ci-execution")))),
        events, cutoff, signal_clock(rule), suffix)

def signals_for(+key: String, +cutoff: Nat, input: List<&2, HistorySignal>, +events: List<&2, HistoryEvent>, output: List<&2, HistorySignal>) ->
    List<&2, HistorySignal>:
  match input:
    case []: List.sort(~HistorySignal, ~signal_before, output)
    case +signal <> tail:
      signals_for(key, cutoff, tail, events, bind_signal(signal_event(signal, key, cutoff, events), signal, output))

def history_result(thread: HistoryThread, scan: EventScan, +signals: List<&2, HistorySignal>) -> History:
  match scan:
    case EventScan{end, count, groups}:
      History{HistoryEntry{thread, end, count, List.length(&2, HistorySignal, signals)}, history_lanes(13n, Map.get(List<&2, HistoryEvent>, [], groups, "12"), []), signals}

def project_session(+thread: HistoryThread, +events: List<&2, HistoryEvent>, signals: List<&2, HistorySignal>) -> History:
  match thread:
    case HistoryThread{_, sample, _, _, _, +cutoff, _}:
      history_result(thread, scan_events(events, cutoff, EventScan{0n, 0n, Map.new(&2, List<&2, HistoryEvent>)}),
        signals_for(String.append("sample-", Nat.show(sample)), cutoff, signals, events, []))

def entry_before(a: HistoryEntry, b: HistoryEntry) -> Bool:
  match a b:
    case HistoryEntry{HistoryThread{_, i, _, _, +x, _, _}, _, _, _} HistoryEntry{HistoryThread{_, j, _, _, +y, _, _}, _, _, _}:
      Bool.or(Nat.is_lt(y, x), Bool.and(Nat.is_eq(x, y), Nat.is_le(i, j)))

def order_sessions(input: List<&2, HistoryEntry>) -> List<&2, HistoryEntry>:
  List.sort(~HistoryEntry, ~entry_before, input)

def session_matches(entry: HistoryEntry, +query: String) -> Bool:
  match entry:
    case HistoryEntry{HistoryThread{_, _, title, _, _, _, _}, _, _, _}:
      String.contains(String.to_lower(title), String.to_lower(String.trim(query)))

type EventPage is Data:
  EventPage{total: Nat, rows: List<&2, HistoryEvent>}

def event_in_range(event: HistoryEvent, +from: Nat, +to: Nat) -> Bool:
  match event:
    case HistoryEvent{_, _, +start, end, _, _, _, _, _}:
      Bool.and(Nat.is_le(start, to), Nat.is_le(from, event_endpoint(end, start)))

def matching_events(events: List<&2, HistoryEvent>, +from: Nat, +to: Nat, +query: String, +output: List<&2, HistoryEvent>) -> List<&2, HistoryEvent>:
  match events:
    case []: List.reverse(&2, HistoryEvent, output)
    case +head <> tail:
      match head:
        case HistoryEvent{_, _, _, _, +label, _, _, _, _}:
          +match_label = String.contains(String.to_lower(label), query)
          matching_events(tail, from, to, query, Bool.pick(List<&2, HistoryEvent>,
            Bool.and(match_label, event_in_range(head, from, to)), head <> output, output))

def order_events(events: List<&2, HistoryEvent>) -> List<&2, HistoryEvent>:
  List.sort(~HistoryEvent, ~event_before, events)

def session_events(events: List<&2, HistoryEvent>, from: Nat, to: Nat, query: String, offset: Nat) -> EventPage:
  +matched = matching_events(events, from, to, String.to_lower(String.trim(query)), [])
  EventPage{List.length(&2, HistoryEvent, matched), List.take(&2, HistoryEvent, List.drop(&2, HistoryEvent, matched, offset), 20n)}

def trace_elapsed(+ms: Nat) -> String:
  +s = Nat.div(ms, 1000n)
  +hour = Nat.div(s, 3600n)
  +minute = Nat.mod(Nat.div(s, 60n), 60n)
  +sec = Nat.mod(s, 60n)
  Bool.pick(String, Nat.is_lt(s, 1n), String.append(Nat.show(ms), " ms"),
    String.concat([
      Bool.pick(String, Nat.is_eq(hour, 0n), "", String.append(Nat.show(hour), "h ")),
      Bool.pick(String, Nat.is_eq(minute, 0n), "", String.append(Nat.show(minute), "m ")),
      String.append(Nat.show(sec), "s")]))

def session_window_valid(start: Nat, cutoff: Nat, snapshot: Nat) -> Bool:
  Nat.is_eq(Nat.add(start, cutoff), snapshot)
