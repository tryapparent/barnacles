import Base

type Interval is Data:
  Interval{a: Nat, b: Nat, kind: U32, name: String}

type Part is Data:
  Part{a: Nat, b: Nat, kind: U32, name: String, shade: Nat}

type Entry is Data:
  Entry{a: Nat, b: Nat, kind: U32, name: String, paint: String}

type Decision is Data:
  Decision{kind: U32, name: String}

type Pick is Data:
  Pick{at: Nat, span: Nat}

def n_before(a: Nat, b: Nat) -> Bool:
  Nat.is_lt(a, b)

def boundaries(input: List<&2, Interval>, stop: Nat) -> List<&2, Nat>:
  match input:
    case []: [0n, stop]
    case Interval{+a,+b,_,_} <> rest: a <> b <> boundaries(rest,stop)

def covered(input: List<&2, Interval>, +a: Nat, +b: Nat, best: Decision) -> Decision:
  match input best:
    case [] Decision{+k,+n}: Decision{k,n}
    case Interval{+x,+y,+kind,+name} <> rest Decision{+k,+n}:
      +active = Bool.and(Nat.is_le(x,a),Nat.is_le(b,y))
      +higher = U32.is_gt(kind,k)
      +same = U32.is_eq(kind,k)
      +update = Bool.and(active,Bool.or(higher,same))
      +generic = Bool.and(same,Bool.not(String.eq(name,n)))
      +label = Bool.pick(String,generic,Bool.pick(String,U32.is_eq(kind,2),"Agent work","Workflows & waits"),name)
      covered(rest,a,b,Bool.pick(Decision,update,Decision{kind,label},Decision{k,n}))

def add_part(skip: Bool, decision: Decision, a: Nat, b: Nat, index: Nat, rest: List<&2,Part>) -> List<&2,Part>:
  match skip decision:
    case True{} _: rest
    case False{} Decision{k,n}: Part{a,b,k,n,index} <> rest

def split(points: List<&2, Nat>, +input: List<&2, Interval>, +index: Nat) -> List<&2, Part>:
  match points:
    case +a <> +b <> tail:
      add_part(Nat.is_eq(a,b),covered(input,a,b,Decision{0,"Activity unclear"}),a,b,index,
        split(b <> tail,input,Nat.add(index,1n)))
    case _: []

def keep_parts(tail: List<&2, Part>, a: Part, +details: Bool) -> List<&2, Part>:
  match tail a:
    case [] Part{x,y,k,n,i}: [Part{x,y,k,n,i}]
    case Part{+u,+v,+j,+m,+l} <> rest Part{+x,+y,+k,+n,+i}:
      +same = Bool.and(U32.is_eq(k,j),Bool.or(Bool.not(details),String.eq(n,m)))
      +next = Bool.pick(Part,same,Part{x,v,k,n,i},Part{u,v,j,m,l})
      +merged = keep_parts(rest,next,details)
      Bool.pick(List<&2,Part>,same,merged,Part{x,y,k,n,i} <> merged)

def groups(parts: List<&2, Part>, details: Bool) -> List<&2, Part>:
  match parts:
    case []: []
    case first <> rest: keep_parts(rest,first,details)

def evidence(+input: List<&2, Interval>, duration: Nat) -> List<&2, Part>:
  groups(split(List.sort(~Nat,~n_before,boundaries(input,duration)),input,0n),True{})

def base(+kind: U32) -> String:
  Bool.pick(String,U32.is_eq(kind,2),"#6a934f",Bool.pick(String,U32.is_eq(kind,1),"#392820","#ffffff"))

def variant(kind: U32, index: Nat) -> String:
  +first = Nat.is_eq(Nat.mod(index,2n),0n)
  Bool.pick(String,U32.is_eq(kind,2),Bool.pick(String,first,"#b6cb9f","#94b078"),
    Bool.pick(String,first,"#ad9a85","#c6b7a5"))

def is_special(+name: String) -> Bool:
  Bool.or(String.eq(name,"Release run"),String.eq(name,"Incident wait"))

def first_kind(parts: List<&2, Part>) -> U32:
  match parts:
    case []: 0
    case Part{_,_,+k,_,_} <> _: k

def colors(parts: List<&2, Part>, +prior: U32, +details: Bool) -> List<&2, Entry>:
  match parts:
    case []: []
    case Part{+a,+b,+kind,+name,+index} <> +rest:
      +next = first_kind(rest)
      +adjacent = Bool.or(U32.is_eq(prior,kind),U32.is_eq(kind,next))
      +shade = Bool.and(details,Bool.and(adjacent,Bool.not(is_special(name))))
      +fill = Bool.pick(String,shade,variant(kind,index),base(kind))
      Entry{a,b,kind,name,fill} <> colors(rest,kind,details)

def real_color(parts: List<&2, Entry>) -> String:
  match parts:
    case []: base(0)
    case Entry{_,_,+kind,_,+paint} <> rest:
      Bool.pick(String,U32.is_eq(kind,0),real_color(rest),paint)

def mix(+left: String, +right: String) -> String:
  Bool.pick(String,String.eq(left,right),left,String.concat(["color-mix(in srgb,",left," 50%,",right,")"]))

def paint_gaps(parts: List<&2, Entry>, +left: String) -> List<&2, Entry>:
  match parts:
    case []: []
    case Entry{+a,+b,+kind,+name,+paint} <> +rest:
      +gap = U32.is_eq(kind,0)
      +fill = Bool.pick(String,gap,mix(left,real_color(rest)),paint)
      Entry{a,b,kind,name,fill} <> paint_gaps(rest,Bool.pick(String,gap,left,paint))

def smallest(parts: List<&2, Entry>, +index: Nat, best: Pick) -> Pick:
  match parts best:
    case [] Pick{+at,+span}: Pick{at,span}
    case Entry{+a,+b,_,_,_} <> rest Pick{+at,+span}:
      +width = Nat.sub(b,a)
      smallest(rest,Nat.add(index,1n),Bool.pick(Pick,Nat.is_lt(width,span),Pick{index,width},Pick{at,span}))

def choose_left(left: Entry, right: Entry, +kind: U32) -> Bool:
  match left right:
    case Entry{+a,+b,+k,_,_} Entry{+x,+y,+j,_,_}:
      +l = U32.is_eq(k,kind)
      +r = U32.is_eq(j,kind)
      Bool.pick(Bool,Bool.and(l,Bool.not(r)),True{},
        Bool.and(Bool.not(Bool.and(r,Bool.not(l))),Nat.is_le(Nat.sub(y,x),Nat.sub(b,a))))

def merge_at(parts: List<&2, Entry>, index: Nat) -> List<&2, Entry>:
  match parts index:
    case Entry{+a,_,_,_,_} <> Entry{_,+b,+k,+n,+c} <> rest 0n: Entry{a,b,k,n,c} <> rest
    case Entry{+a,+b,+k,+n,+c} <> Entry{+x,+y,+j,+m,+d} <> [] 1n: [Entry{a,y,k,n,c}]
    case Entry{+a,+b,+k,+n,+c} <> Entry{+x,+y,+j,+m,+d} <> Entry{+u,+v,+q,+z,+f} <> +rest 1n:
      Bool.pick(List<&2,Entry>,choose_left(Entry{a,b,k,n,c},Entry{u,v,q,z,f},j),
        Entry{a,y,k,n,c} <> Entry{u,v,q,z,f} <> rest,
        Entry{a,b,k,n,c} <> Entry{x,v,q,z,f} <> rest)
    case first <> rest 1n+later: first <> merge_at(rest,later)
    case other _: other

def needs_merge(pick: Pick, scale: Nat, width: Nat) -> Bool:
  match pick:
    case Pick{_,span}: Nat.is_lt(Nat.mul(span,width),Nat.mul(12n,scale))

def merge_index(pick: Pick) -> Nat:
  match pick:
    case Pick{at,_}: at

def collapse(fuel: Nat, +parts: List<&2, Entry>, go: Bool, +scale: Nat, +width: Nat) -> List<&2, Entry>:
  match fuel go:
    case 0n _: parts
    case 1n+remaining False{}: parts
    case 1n+remaining True{}:
      +pick = smallest(parts,0n,Pick{0n,scale})
      +narrow = needs_merge(pick,scale,width)
      collapse(remaining,Bool.pick(List<&2,Entry>,narrow,merge_at(parts,merge_index(pick)),parts),narrow,scale,width)
