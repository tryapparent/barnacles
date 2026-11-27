import Base
import ./session-history.bend as History
import ../projection/metrics.bend as Metrics

type Phase is Data:
  Phase{a: Nat, b: Nat, kind: U32, name: String}

type Failure is Data:
  Failure{at: Nat, label: String, state: String, index: Nat}

type Timeline is Data:
  Timeline{phases: List<&2, Phase>, failures: List<&2, Failure>}

type Boundary is Data:
  Boundary{at: Nat, id: Nat, kind: U32, opens: Bool}

type Observations is Data:
  Observations{boundaries: List<&2, Boundary>, labels: Map<&2, String>, failures: List<&2, Failure>}

type Active is Data:
  Active{work: Nat, work_id: Nat, wait: Nat, wait_id: Nat}

def timeline_entries(entries: List<&2, History.HistoryEntry>) -> List<&2, History.HistoryEntry>:
  List.take(&2, History.HistoryEntry, entries, 10n)

def observation_kind(+lane: Nat, +label: String) -> U32:
  +wait = Bool.or(Nat.is_eq(lane,0n),Bool.or(Nat.is_eq(lane,6n),Nat.is_eq(lane,7n)))
  +tool = Nat.is_eq(lane,3n)
  Bool.pick(U32,Bool.or(wait,Bool.and(tool,String.contains(String.to_lower(label),"waiting for github actions"))),1,
    Bool.pick(U32,tool,2,0))

def failed(+state: String) -> Bool:
  Bool.or(String.eq(state,"failure"),Bool.or(String.eq(state,"failed"),
    Bool.or(String.eq(state,"error"),Bool.or(String.eq(state,"timed_out"),String.eq(state,"timeout")))))

def failed_lane(+lane: Nat) -> Bool:
  Bool.or(Nat.is_le(lane,3n),Nat.is_eq(lane,7n))

def retain_event(+event: History.HistoryEvent, +stop: Nat, observations: Observations) -> Observations:
  match event observations:
    case History.HistoryEvent{+index,+lane,+a,Some{+b},+label,_,state,_,clipped} Observations{+boundaries,+labels,+failures}:
      +kind = observation_kind(lane,label)
      +id = Nat.add(index,1n)
      +is_span = Bool.and(U32.is_gt(kind,0),Bool.and(Nat.is_lt(a,b),Nat.is_le(b,stop)))
      +is_failure = Bool.and(Bool.not(clipped),Bool.and(Nat.is_le(b,stop),Bool.and(failed_lane(lane),failed(String.to_lower(state)))))
      Observations{
        Bool.pick(List<&2,Boundary>,is_span,Boundary{a,id,kind,True{}} <> Boundary{b,id,kind,False{}} <> boundaries,boundaries),
        Bool.pick(Map<&2,String>,is_span,Map.set(&2,String,labels,Nat.show(id),label),labels),
        Bool.pick(List<&2,Failure>,is_failure,Failure{b,label,state,index} <> failures,failures)}
    case _ _: observations

def gather_events(events: List<&2, History.HistoryEvent>, +stop: Nat, found: Observations) -> Observations:
  match events:
    case []: found
    case event <> rest: gather_events(rest,stop,retain_event(event,stop,found))

def boundary_before(a: Boundary, b: Boundary) -> Bool:
  match a b:
    case Boundary{x,_,_,_} Boundary{y,_,_,_}: Nat.is_le(x,y)

def failure_before(a: Failure, b: Failure) -> Bool:
  match a b:
    case Failure{+x,_,_,i} Failure{+y,_,_,j}: Bool.or(Nat.is_lt(x,y),Bool.and(Nat.is_eq(x,y),Nat.is_le(i,j)))

def delta(open: Bool, +value: Nat, +amount: Nat) -> Nat:
  Bool.pick(Nat,open,Nat.add(value,amount),Nat.sub(value,amount))

def update_active(boundary: Boundary, active: Active) -> Active:
  match boundary active:
    case Boundary{_,+id,kind,+opens} Active{+work,+work_id,+wait,+wait_id}:
      Bool.pick(Active,U32.is_eq(kind,2),Active{delta(opens,work,1n),delta(opens,work_id,id),wait,wait_id},
        Active{work,work_id,delta(opens,wait,1n),delta(opens,wait_id,id)})

def selected_name(count: Nat, fallback: String, value: Map<&2,String> & String) -> String:
  match value:
    case (_,found): Bool.pick(String,Nat.is_eq(count,1n),found,fallback)

def name_for(count: Nat, id: Nat, +fallback: String, labels: Map<&2,String>) -> String:
  selected_name(count,fallback,Map.get(String,fallback,labels,Nat.show(id)))

def evidence_phase(a: Nat, b: Nat, active: Active, +labels: Map<&2, String>) -> Phase:
  match active:
    case Active{+work,work_id,+wait,wait_id}:
      +kind = Bool.pick(U32,Nat.is_lt(0n,work),2,Bool.pick(U32,Nat.is_lt(0n,wait),1,0))
      Phase{a,b,kind,Bool.pick(String,U32.is_eq(kind,2),name_for(work,work_id,"Tool activity",labels),
        Bool.pick(String,U32.is_eq(kind,1),name_for(wait,wait_id,"Workflows & waits",labels),"Activity unclear"))}

def add_phase(output: List<&2, Phase>, phase: Phase) -> List<&2, Phase>:
  match output phase:
    case [] Phase{+a,+b,+kind,+name}:
      Bool.pick(List<&2,Phase>,Nat.is_lt(a,b),[Phase{a,b,kind,name}],[])
    case Phase{+x,+y,+prior,+label} <> +rest Phase{+a,+b,+kind,+name}:
      +previous : List<&2,Phase> = Phase{x,y,prior,label} <> rest
      +joined = Bool.and(U32.is_eq(kind,prior),String.eq(name,label))
      Bool.pick(List<&2,Phase>,Nat.is_lt(a,b),
        Bool.pick(List<&2,Phase>,joined,Phase{x,b,kind,name} <> rest,Phase{a,b,kind,name} <> previous),previous)

def sweep(events: List<&2, Boundary>, +active: Active, +labels: Map<&2, String>, +last: Nat, +stop: Nat,
          output: List<&2, Phase>) -> List<&2, Phase>:
  match events:
    case []: List.reverse(&2,Phase,add_phase(output,evidence_phase(last,stop,active,labels)))
    case Boundary{+at,+id,+kind,+opens} <> rest:
      sweep(rest,update_active(Boundary{at,id,kind,opens},active),labels,at,stop,add_phase(output,evidence_phase(last,at,active,labels)))

def summarize(observations: Observations, duration: Nat) -> Timeline:
  match observations:
    case Observations{boundaries,labels,failures}:
      Timeline{sweep(Metrics.sort_timing(~Boundary,~boundary_before,boundaries),Active{0n,0n,0n,0n},labels,0n,duration,[]),
        Metrics.sort_timing(~Failure,~failure_before,failures)}

def timeline(events: List<&2, History.HistoryEvent>, +duration: Nat) -> Timeline:
  summarize(gather_events(events,duration,Observations{[],Map.new(&2,String),[]}),duration)
