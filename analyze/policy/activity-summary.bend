import Base

type Snapshot is Data:
  Snapshot{index: Nat, version: Nat, period: String, cutoff: Nat, published: Nat, watermark: Nat, revision: String}

type Choice is Data:
  Missing{}
  Latest{snapshot: Snapshot, conflict: Bool}

type Selection is Data:
  Selection{index: Nat, status: String, partial: Bool}

def eligible(item: Snapshot, period: String, to: Nat) -> Bool:
  match item:
    case Snapshot{_,version,range,+cutoff,published,watermark,revision}:
      Bool.and(Bool.and(Nat.is_eq(version,1n),String.eq(range,period)),
        Bool.and(Bool.and(Nat.is_gt(cutoff,0n),Nat.is_eq(Nat.mod(cutoff,60000n),0n)),
          Bool.and(Bool.and(Nat.is_le(cutoff,to),Nat.is_le(cutoff,published)),
            Bool.and(Nat.is_le(watermark,cutoff),Bool.not(String.is_empty(revision))))))

def newer(+item: Snapshot, previous: Choice) -> Choice:
  match item previous:
    case _ Missing{}: Latest{item,False{}}
    case Snapshot{_,_,_,+cutoff,+published,_,revision} Latest{+prior,conflict}:
      match prior:
        case Snapshot{_,_,_,+at,+written,_,digest}:
          +later = Bool.or(Nat.is_gt(cutoff,at),Bool.and(Nat.is_eq(cutoff,at),Nat.is_gt(published,written)))
          +tie = Bool.and(Nat.is_eq(cutoff,at),Nat.is_eq(published,written))
          Bool.pick(Choice,later,Latest{item,False{}},
            Latest{prior,Bool.or(conflict,Bool.and(tie,Bool.not(String.eq(revision,digest))))})

def selected(items: List<&2,Snapshot>, +period: String, +to: Nat, +best: Choice) -> Choice:
  match items:
    case []: best
    case +item <> rest:
      selected(rest,period,to,Bool.pick(Choice,eligible(item,period,to),newer(item,best),best))

def framed(choice: Choice, to: Nat, partial: Bool) -> Selection:
  match choice:
    case Missing{}: Selection{0n,"Snapshot missing",partial}
    case Latest{_,True{}}: Selection{0n,"Conflicting snapshots",True{}}
    case Latest{Snapshot{index,_,_,_,_,+watermark,_},False{}}:
      +status = Bool.pick(String,Nat.is_eq(watermark,0n),"Watermark unknown",
        Bool.pick(String,Nat.is_gt(Nat.sub(to,watermark),900000n),"Stale","Fresh"))
      Selection{index,status,partial}

def select(items: List<&2,Snapshot>, +period: String, +to: Nat, partial: Bool) -> Selection:
  framed(selected(items,period,to,Missing{}),to,partial)
