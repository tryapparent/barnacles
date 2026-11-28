import Base
import 0x419ec39802735c4664960ab4b9d962e5/json.bend as J
import 0xec25e4adfb02e59e4b817801115988ee/bytes.bend as Bytes

type Attempt is Data:
  Attempt{id: String, run: String, provider: String, session: String, node: String, turn: String}

type Turn is Data:
  Turn{id: String, attempt: String, provider: String, node: String, driver: String, strength: String, native: String, session: String}

def uuid_chars(text: String, +at: U32) -> Bool:
  match text:
    case SNil{}: U32.is_eq(at,36)
    case SCon{ch,rest}:
      +code = Char.to_u32(ch)
      +dash = Bool.or(Bool.or(U32.is_eq(at,8),U32.is_eq(at,13)),Bool.or(U32.is_eq(at,18),U32.is_eq(at,23)))
      +hex = Bool.or(Bool.and(U32.is_ge(code,48),U32.is_le(code,57)),Bool.and(U32.is_ge(code,97),U32.is_le(code,102)))
      Bool.and(Bool.pick(Bool,dash,U32.is_eq(code,45),hex),uuid_chars(rest,U32.add(at,1)))

def turn_id(+run: String,+provider: String,+session: String,+active: String,attempts: List<&2,Attempt>,turns: List<&2,Turn>) -> String:
  match attempts turns:
    case Attempt{+id,owner,thread,destination,+root,+declared} <> [] Turn{+turn,attempt,turn_thread,node,driver,strength,+native,+native_session} <> []:
      +attempt_ok = Bool.and(String.eq(id,active),Bool.and(String.eq(owner,run),String.eq(destination,session)))
      +turn_ok = Bool.and(String.eq(attempt,id),Bool.and(String.eq(node,root),Bool.or(String.is_empty(declared),String.eq(declared,turn))))
      +provider_ok = Bool.and(String.eq(provider,thread),Bool.and(String.eq(provider,turn_thread),String.eq(driver,"codex")))
      +session_ok = Bool.and(uuid_chars(session,0),Bool.or(String.is_empty(native_session),String.eq(native_session,session)))
      +valid = Bool.and(Bool.and(uuid_chars(native,0),Bool.and(Bool.not(String.is_empty(id)),Bool.and(Bool.not(String.is_empty(root)),Bool.not(String.is_empty(turn))))),
        Bool.and(String.eq(strength,"strong"),Bool.and(Bool.and(attempt_ok,turn_ok),Bool.and(provider_ok,session_ok))))
      Bool.pick(String,valid,native,"")
    case _ _: ""

type TraceData is Data:
  TraceData{attempts: Map<&2,List<&2,Attempt>>, turns: Map<&2,List<&2,Turn>>}

def fields(items: List<&1,Bytes.Bytes & J.Val>, +prefix: String, +index: Map<&2,String>) -> Map<&2,String>:
  match items:
    case []: index
    case (key,J.Obj{children}) <> rest:
      +name = Bytes.to_string(key)
      +path = String.concat([prefix,Nat.show(String.length(name)),":",name])
      fields(rest,prefix,fields(children,path,Map.set(&2,String,index,path,"!")))
    case (_,J.Null{}) <> rest: fields(rest,prefix,index)
    case (key,J.Str{bytes}) <> rest:
      +name = Bytes.to_string(key)
      +path = String.concat([prefix,Nat.show(String.length(name)),":",name])
      fields(rest,prefix,Map.set(&2,String,index,path,Bytes.to_string(bytes)))
    case (key,_) <> rest:
      +name = Bytes.to_string(key)
      +path = String.concat([prefix,Nat.show(String.length(name)),":",name])
      fields(rest,prefix,Map.set(&2,String,index,path,"!"))

def decode(value: J.Val) -> Map<&2,String>:
  match value:
    case J.Obj{items}: fields(items,"",Map.new(&2,String))
    case _: Map.new(&2,String)

def map_value(-A: Data, entry: Map<&2,A> & A) -> A:
  match entry:
    case (_,result): result

def field(row: Map<&2,String>, +name: String) -> String:
  map_value(String,Map.get(String,"",row,String.concat([Nat.show(String.length(name)),":",name])))

def attribute(row: Map<&2,String>, +ref: String, +name: String) -> String:
  map_value(String,Map.get(String,"",row,String.concat([Nat.show(String.length(ref)),":",ref,Nat.show(String.length(name)),":",name])))

def session_ref(+row: Map<&2,String>) -> String:
  +id = attribute(row,"nativeThreadRef","nativeId")
  +driver = attribute(row,"nativeThreadRef","driver")
  +strength = attribute(row,"nativeThreadRef","strength")
  +empty = String.is_empty(field(row,"nativeThreadRef"))
  +valid = Bool.and(String.eq(driver,"codex"),Bool.and(String.eq(strength,"strong"),uuid_chars(id,0)))
  Bool.pick(String,empty,"",Bool.pick(String,valid,id,"!"))

def prepend(-A: Data, entry: Map<&2,List<&2,A>> & List<&2,A>, key: String, row: A) -> Map<&2,List<&2,A>>:
  match entry:
    case (table,list): Map.set(&2,List<&2,A>,table,key,row <> list)

def put_attempts(rows: List<&1,J.Val>, +index: Map<&2,List<&2,Attempt>>, +left: Nat) -> Map<&2,List<&2,Attempt>>:
  match rows left:
    case [] _: index
    case _ 0n: Map.new(&2,List<&2,Attempt>)
    case raw <> rest _:
      +row = decode(raw)
      +key = field(row,"runId")
      +entry : Attempt = Attempt{field(row,"id"),key,field(row,"providerThreadId"),field(row,"nativeThreadId"),
        field(row,"rootNodeId"),field(row,"providerTurnId")}
      put_attempts(rest,prepend(Attempt,Map.get(List<&2,Attempt>,[],index,key),key,entry),Nat.sub(left,1n))

def put_turns(rows: List<&1,J.Val>, +index: Map<&2,List<&2,Turn>>, +left: Nat) -> Map<&2,List<&2,Turn>>:
  match rows left:
    case [] _: index
    case _ 0n: Map.new(&2,List<&2,Turn>)
    case raw <> rest _:
      +row = decode(raw)
      +key = field(row,"runAttemptId")
      +entry : Turn = Turn{field(row,"id"),key,field(row,"providerThreadId"),field(row,"nodeId"),attribute(row,"nativeTurnRef","driver"),
        attribute(row,"nativeTurnRef","strength"),attribute(row,"nativeTurnRef","nativeId"),session_ref(row)}
      put_turns(rest,prepend(Turn,Map.get(List<&2,Turn>,[],index,key),key,entry),Nat.sub(left,1n))

def rows(parsed: Maybe<&1,J.Val>) -> List<&1,J.Val>:
  match parsed:
    case Some{J.Arr{values}}: values
    case _: []

def trace_data(attempts: String, turns: String) -> TraceData:
  TraceData{put_attempts(rows(J.parse.strict.bytes(J.utf8(attempts),16)),Map.new(&2,List<&2,Attempt>),4096n),
    put_turns(rows(J.parse.strict.bytes(J.utf8(turns),16)),Map.new(&2,List<&2,Turn>),4096n)}

def lookup(+run: String,provider: String,session: String,+active: String,data: TraceData) -> String:
  match data:
    case TraceData{attempts,turns}:
      run_attempts = map_value(List<&2,Attempt>,Map.get(List<&2,Attempt>,[],attempts,run))
      attempt_turns = map_value(List<&2,Turn>,Map.get(List<&2,Turn>,[],turns,active))
      turn_id(run,provider,session,active,run_attempts,attempt_turns)
