import Base
import ./spans.bend as Spans

type SummaryTrace is Data:
  SummaryTrace{index: Nat, start: Nat, parts: List<&2, Spans.Part>}

type SummarySpan is Data:
  SummarySpan{index: Nat, start: Nat, end: Nat, duration: Nat, kind: U32, name: String}

type SummaryOperation is Data:
  SummaryOperation{name: String, duration: Nat, spans: List<&2, SummarySpan>}

type SummaryCategory is Data:
  SummaryCategory{kind: U32, duration: Nat, threads: Nat, operations: List<&2, SummaryOperation>}

type TimeSummary is Data:
  TimeSummary{duration: Nat, threads: Nat, categories: List<&2, SummaryCategory>}

def clip_parts(parts: List<&2, Spans.Part>, +index: Nat, +origin: Nat, +from: Nat, +to: Nat, rest: List<&2, SummarySpan>) -> List<&2, SummarySpan>:
  match parts:
    case []: rest
    case Spans.Part{a,b,kind,name,_} <> tail:
      +start = Nat.max(from, Nat.add(origin,a))
      +end = Nat.min(to, Nat.add(origin,b))
      +remaining = clip_parts(tail,index,origin,from,to,rest)
      Bool.pick(List<&2, SummarySpan>, Nat.is_lt(start,end),
        SummarySpan{index,start,end,Nat.sub(end,start),kind,name} <> remaining, remaining)

def clip_traces(traces: List<&2, SummaryTrace>, +from: Nat, +to: Nat) -> List<&2, SummarySpan>:
  match traces:
    case []: []
    case SummaryTrace{index,start,parts} <> rest:
      clip_parts(parts,index,start,from,to,clip_traces(rest,from,to))

def span_time(spans: List<&2, SummarySpan>) -> Nat:
  match spans:
    case []: 0n
    case SummarySpan{_,_,_,duration,_,_} <> rest: Nat.add(duration,span_time(rest))

def count_threads(spans: List<&2, SummarySpan>, +last: Nat) -> Nat:
  match spans:
    case []: 0n
    case SummarySpan{+index,_,_,_,_,_} <> rest:
      Nat.add(Bool.pick(Nat,Nat.is_eq(last,index),0n,1n),count_threads(rest,index))

def category_spans(spans: List<&2, SummarySpan>, +kind: U32) -> List<&2, SummarySpan>:
  match spans:
    case []: []
    case SummarySpan{index,start,end,duration,+k,name} <> rest:
      +remaining = category_spans(rest,kind)
      Bool.pick(List<&2, SummarySpan>,U32.is_eq(kind,k),SummarySpan{index,start,end,duration,k,name} <> remaining,remaining)

type OperationPartition is Data:
  OperationPartition{same: List<&2, SummarySpan>, other: List<&2, SummarySpan>}

def partition_item(item: SummarySpan, +name: String, partition: OperationPartition) -> OperationPartition:
  match item partition:
    case SummarySpan{index,start,end,duration,kind,+n} OperationPartition{+same,+other}:
      +entry : SummarySpan = SummarySpan{index,start,end,duration,kind,n}
      Bool.pick(OperationPartition,String.eq(name,n),OperationPartition{entry <> same,other},OperationPartition{same,entry <> other})

def partition_operation(spans: List<&2, SummarySpan>, +name: String) -> OperationPartition:
  match spans:
    case []: OperationPartition{[],[]}
    case item <> rest: partition_item(item,name,partition_operation(rest,name))

def summary_span_before(a: SummarySpan, b: SummarySpan) -> Bool:
  match a b:
    case SummarySpan{_,_,_,x,_,_} SummarySpan{_,_,_,y,_,_}: Nat.is_lt(y,x)

def matching_spans(partition: OperationPartition) -> List<&2, SummarySpan>:
  match partition:
    case OperationPartition{same,_}: same

def remaining_spans(partition: OperationPartition) -> List<&2, SummarySpan>:
  match partition:
    case OperationPartition{_,other}: other

def operation_groups(fuel: Nat, spans: List<&2, SummarySpan>) -> List<&2, SummaryOperation>:
  match fuel:
    case 0n: []
    case 1n+left:
      match spans:
        case []: []
        case SummarySpan{index,start,end,+duration,kind,+name} <> rest:
          +partition = partition_operation(rest,name)
          +same = matching_spans(partition)
          SummaryOperation{name,Nat.add(duration,span_time(same)),
            List.sort(~SummarySpan,~summary_span_before,SummarySpan{index,start,end,duration,kind,name} <> same)} <>
            operation_groups(left,remaining_spans(partition))

def operation_before(a: SummaryOperation, b: SummaryOperation) -> Bool:
  match a b:
    case SummaryOperation{_,x,_} SummaryOperation{_,y,_}: Nat.is_lt(y,x)

def category_before(a: SummaryCategory, b: SummaryCategory) -> Bool:
  match a b:
    case SummaryCategory{_,x,_,_} SummaryCategory{_,y,_,_}: Nat.is_lt(y,x)

def summary_categories(kinds: List<&2, U32>, +spans: List<&2, SummarySpan>) -> List<&2, SummaryCategory>:
  match kinds:
    case []: []
    case +kind <> rest:
      +entries = category_spans(spans,kind)
      +duration = span_time(entries)
      +tail = summary_categories(rest,spans)
      Bool.pick(List<&2, SummaryCategory>,Nat.is_eq(duration,0n),tail,
        SummaryCategory{kind,duration,count_threads(entries,0n),List.sort(~SummaryOperation,~operation_before,operation_groups(List.length(&2, SummarySpan, entries),entries))} <> tail)

def time_summary(traces: List<&2, SummaryTrace>, from: Nat, to: Nat) -> TimeSummary:
  +spans = clip_traces(traces,from,to)
  TimeSummary{span_time(spans),count_threads(spans,0n),
    List.sort(~SummaryCategory,~category_before,summary_categories([1,2,0],spans))}
