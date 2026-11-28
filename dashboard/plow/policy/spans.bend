import Base

type Interval is Data:
  Interval{a: Nat, b: Nat, kind: U32, name: String}

type Part is Data:
  Part{a: Nat, b: Nat, kind: U32, name: String, shade: Nat}

type Entry is Data:
  Entry{a: Nat, b: Nat, kind: U32, name: String, paint: String}

type Decision is Data:
  Decision{kind: U32, name: String}


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
      +generic = Bool.and(U32.is_ne(kind,0),Bool.and(same,Bool.not(String.eq(name,n))))
      +label = Bool.pick(String,generic,Bool.pick(String,U32.is_ge(kind,2),"Provider run","Admission wait"),name)
      covered(rest,a,b,Bool.pick(Decision,update,Decision{kind,label},Decision{k,n}))

def add_part(skip: Bool, decision: Decision, a: Nat, b: Nat, index: Nat, rest: List<&2,Part>) -> List<&2,Part>:
  match skip decision:
    case True{} _: rest
    case False{} Decision{k,n}: Part{a,b,U32.min(k,2),n,index} <> rest

def split(points: List<&2, Nat>, +input: List<&2, Interval>, +index: Nat) -> List<&2, Part>:
  match points:
    case +a <> +b <> tail:
      add_part(Nat.is_eq(a,b),covered(input,a,b,Decision{0,"Unobserved"}),a,b,index,
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
  Bool.pick(String,U32.is_eq(kind,2),"#6a934f",Bool.pick(String,U32.is_eq(kind,1),"#392820","#a19a92"))

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

def mix(+left: String, +right: String) -> String:
  Bool.pick(String,String.eq(left,right),left,String.concat(["color-mix(in srgb,",left," 50%,",right,")"]))
