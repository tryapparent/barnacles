import Base
import ../../../evidence/analysis/session-history.bend as History
import ../../../evidence/analysis/session-timeline.bend as Evidence

type UtcSpan is Data:
  UtcSpan{start: Nat, end: Nat}

def expand_utc(current: UtcSpan, next: UtcSpan) -> UtcSpan:
  match current next:
    case UtcSpan{+a,+b} UtcSpan{+x,+y}:
      UtcSpan{Bool.pick(Nat,Nat.is_lt(x,a),x,a),Bool.pick(Nat,Nat.is_lt(b,y),y,b)}

def scan_utc(rest: List<&2,UtcSpan>, bounds: UtcSpan) -> UtcSpan:
  match rest:
    case []: bounds
    case entry <> tail: scan_utc(tail,expand_utc(bounds,entry))

def detail_zoom(visible_millis: Nat) -> Bool:
  Nat.is_le(visible_millis,21600000n)

def chart_step(+visible_millis: Nat) -> Nat:
  Bool.pick(Nat,Nat.is_le(visible_millis,3600000n),300000n,
    Bool.pick(Nat,Nat.is_le(visible_millis,21600000n),1800000n,
      Bool.pick(Nat,Nat.is_le(visible_millis,43200000n),7200000n,21600000n)))

def chart_tick_list(fuel: Nat, +at: Nat, +stop: Nat, +step: Nat) -> List<&2,Nat>:
  match fuel:
    case 0n: []
    case 1n+rest:
      Bool.pick(List<&2,Nat>,Nat.is_le(at,stop),at <> chart_tick_list(rest,Nat.add(at,step),stop,step),[])

def chart_ticks(bounds: UtcSpan, +viewport: Nat, +width: Nat) -> List<&2,Nat>:
  match bounds:
    case UtcSpan{+a,b}:
      +base = chart_step(viewport)
      +available = Nat.mul(base,width)
      +target = Nat.mul(70n,viewport)
      +factor = Nat.div(Nat.add(target,Nat.sub(available,1n)),available)
      +step = Nat.mul(base,factor)
      chart_tick_list(520n,Nat.mul(Nat.div(Nat.add(a,Nat.sub(step,1n)),step),step),b,step)

def exact_utc_frame(input: List<&2,UtcSpan>, fallback: UtcSpan) -> UtcSpan:
  match input:
    case []: fallback
    case first <> rest: scan_utc(rest,first)

def window_duration(+requested: Nat, +full: Nat) -> Nat:
  +length = Bool.pick(Nat,Nat.is_lt(requested,30000n),30000n,requested)
  Bool.pick(Nat,Nat.is_lt(full,length),full,length)

def chart_window(bounds: UtcSpan, +requested_start: Nat, duration: Nat) -> UtcSpan:
  match bounds:
    case UtcSpan{+a,+b}:
      +length = window_duration(duration,Nat.sub(b,a))
      +last_start = Nat.sub(b,length)
      +start = Bool.pick(Nat,Nat.is_lt(requested_start,a),a,
        Bool.pick(Nat,Nat.is_lt(last_start,requested_start),last_start,requested_start))
      UtcSpan{start,Nat.add(start,length)}

def visible_row(top: Nat, bottom: Nat, clip_top: Nat, clip_bottom: Nat) -> Bool:
  Bool.and(Nat.is_lt(top,clip_bottom),Nat.is_lt(clip_top,bottom))

def chart_details(visible_millis: Nat, focused: Bool) -> Bool:
  Bool.or(focused,detail_zoom(visible_millis))

def ready_brush(pixels: Nat) -> Bool:
  Nat.is_le(20n,pixels)

def brush_window(bounds: UtcSpan, +left: Nat, +right: Nat, prior_duration: Nat) -> UtcSpan:
  +picked = Nat.sub(right,left)
  +minimum = Nat.div(prior_duration,4n)
  +length = Bool.pick(Nat,Nat.is_lt(picked,minimum),minimum,picked)
  chart_window(bounds,Nat.sub(left,Nat.div(Nat.sub(length,picked),2n)),length)

type Slice is Data:
  Slice{a: Nat, b: Nat, name: String, paint: String, ink: String, inline: String}

type TickGroup is Data:
  TickGroup{at: Nat, failures: List<&2,Evidence.Failure>}

def kind_name(+kind: U32) -> String:
  Bool.pick(String,U32.is_eq(kind,2),"Tool activity",Bool.pick(String,U32.is_eq(kind,1),"Workflows & waits","Activity unclear"))

def short_name(kind: U32) -> String:
  Bool.pick(String,U32.is_eq(kind,2),"Tools","Wait")

def display_phase(+phase: Evidence.Phase, details: Bool) -> Evidence.Phase:
  match phase:
    case Evidence.Phase{a,b,+kind,name}:
      Evidence.Phase{a,b,kind,Bool.pick(String,details,name,kind_name(kind))}

def combine_phase(output: List<&2,Evidence.Phase>, +phase: Evidence.Phase) -> List<&2,Evidence.Phase>:
  match output phase:
    case Evidence.Phase{+x,+y,+prior,+label} <> +rest Evidence.Phase{+a,+b,+kind,+name}:
      Bool.pick(List<&2,Evidence.Phase>,Bool.and(U32.is_eq(kind,prior),String.eq(name,label)),
        Evidence.Phase{x,b,kind,name} <> rest,phase <> Evidence.Phase{x,y,prior,label} <> rest)
    case [] _: [phase]

def display_groups(phases: List<&2,Evidence.Phase>, +details: Bool, +output: List<&2,Evidence.Phase>) -> List<&2,Evidence.Phase>:
  match phases:
    case []: List.reverse(&2,Evidence.Phase,output)
    case phase <> tail: display_groups(tail,details,combine_phase(output,display_phase(phase,details)))

def first_kind(phases: List<&2,Evidence.Phase>) -> U32:
  match phases:
    case []: 0
    case Evidence.Phase{_,_,kind,_} <> _: kind

def paint(+kind: U32, +detail: Bool, +alternate: Bool) -> String:
  Bool.pick(String,U32.is_eq(kind,2),Bool.pick(String,detail,Bool.pick(String,alternate,"#96ad81","#bacdad"),"#6a934f"),
    Bool.pick(String,U32.is_eq(kind,1),Bool.pick(String,detail,Bool.pick(String,alternate,"#b39e8a","#d7c7b7"),"#392820"),"#a49b91"))

def slice_paint(+kind: U32, +prior: U32, +next: U32, +details: Bool, +alt: Bool) -> String:
  +left = Bool.pick(U32,U32.is_eq(prior,0),next,prior)
  +right = Bool.pick(U32,U32.is_eq(next,0),prior,next)
  +p = paint(left,details,alt)
  +q = paint(right,details,alt)
  Bool.pick(String,U32.is_eq(kind,0),Bool.pick(String,String.eq(p,q),p,
    String.append("linear-gradient(90deg,",String.append(p,String.append(" 50%,",String.append(q," 50%)"))))),
    paint(kind,details,alt))

def output_slice(+a: Nat, +b: Nat, +kind: U32, +name: String, +background: String, +details: Bool, +width: Nat, +scale: Nat) -> Slice:
  +pixels = Nat.div(Nat.mul(Nat.sub(b,a),width),scale)
  +ink = Bool.pick(String,Bool.and(Bool.not(details),U32.is_eq(kind,1)),"#fff4df","#1a130d")
  +text = Bool.pick(String,Nat.is_le(Nat.mul(String.length(name),9n),Nat.sub(pixels,12n)),name,short_name(kind))
  Slice{a,b,name,background,ink,Bool.pick(String,Bool.and(U32.is_gt(kind,0),Nat.is_le(64n,pixels)),text,"")}

def keep_slice(previous: List<&2,Slice>, +next: Slice, +scale: Nat, +width: Nat) -> List<&2,Slice>:
  match previous next:
    case Slice{+x,+y,+old,+fill,+color,+label} <> +rest Slice{+a,+b,+name,+paint,+ink,+text}:
      +tiny = Nat.is_lt(Nat.mul(Nat.sub(b,a),width),Nat.mul(scale,12n))
      +prior_tiny = Nat.is_lt(Nat.mul(Nat.sub(y,x),width),Nat.mul(scale,12n))
      Bool.pick(List<&2,Slice>,prior_tiny,Slice{x,b,name,paint,ink,text} <> rest,
        Bool.pick(List<&2,Slice>,tiny,Slice{x,b,old,fill,color,label} <> rest,next <> Slice{x,y,old,fill,color,label} <> rest))
    case [] _: [next]

def slices(phases: List<&2,Evidence.Phase>, +from: Nat, +to: Nat, +width: Nat, +scale: Nat, +details: Bool, +prior: U32,
           +alt: Bool, +output: List<&2,Slice>) -> List<&2,Slice>:
  match phases:
    case []: List.reverse(&2,Slice,output)
    case Evidence.Phase{+a,+b,+kind,name} <> +tail:
      +left = Nat.max(a,from)
      +right = Nat.min(b,to)
      +fill = slice_paint(kind,prior,first_kind(tail),details,alt)
      slices(tail,from,to,width,scale,details,kind,Bool.not(alt),
        Bool.pick(List<&2,Slice>,Nat.is_lt(left,right),
          keep_slice(output,output_slice(left,right,kind,name,fill,details,width,scale),scale,width),output))

def draw_slices(phases: List<&2,Evidence.Phase>, from: Nat, to: Nat, width: Nat, +details: Bool, scale: Nat) -> List<&2,Slice>:
  slices(display_groups(phases,details,[]),from,to,width,scale,details,0,False{},[])

def group_failure(groups: List<&2,TickGroup>, +failure: Evidence.Failure, threshold: Nat) -> List<&2,TickGroup>:
  match groups failure:
    case TickGroup{+first,+events} <> +tail Evidence.Failure{+at,_,_,_}:
      Bool.pick(List<&2,TickGroup>,Nat.is_le(Nat.sub(at,first),threshold),
        TickGroup{first,failure <> events} <> tail,TickGroup{at,[failure]} <> TickGroup{first,events} <> tail)
    case [] Evidence.Failure{+at,_,_,_}: [TickGroup{at,[failure]}]

def gather_ticks(failures: List<&2,Evidence.Failure>, +from: Nat, +to: Nat, +threshold: Nat, +output: List<&2,TickGroup>) -> List<&2,TickGroup>:
  match failures:
    case []: List.reverse(&2,TickGroup,output)
    case Evidence.Failure{+at,+label,+state,+index} <> tail:
      gather_ticks(tail,from,to,threshold,Bool.pick(List<&2,TickGroup>,Bool.and(Nat.is_le(from,at),Nat.is_le(at,to)),
        group_failure(output,Evidence.Failure{at,label,state,index},threshold),output))

def draw_failures(failures: List<&2,Evidence.Failure>, from: Nat, to: Nat, width: Nat, scale: Nat, +details: Bool) -> List<&2,TickGroup>:
  Bool.pick(List<&2,TickGroup>,details,gather_ticks(failures,from,to,Nat.div(Nat.mul(scale,7n),width),[]),[])

def recent_sessions(entries: List<&2,History.HistoryEntry>) -> List<&2,History.HistoryEntry>:
  Evidence.timeline_entries(entries)

def timeline_projection(events: List<&2,History.HistoryEvent>, duration: Nat) -> Evidence.Timeline:
  Evidence.timeline(events,duration)
