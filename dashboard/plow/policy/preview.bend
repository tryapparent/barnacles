import Base
import ./trend.bend as Trend
import ./spans.bend as Spans
import ./summary.bend as Summary

type Measurement is Data:
  Measurement{key: String, width: Nat}

type LabelWindow is Data:
  LabelWindow{a: Nat, b: Nat}

type Label is Data:
  Label{a: Nat, b: Nat, text: String, ink: String, background: String}

type Layout is Data:
  Layout{paint: List<&2, Spans.Entry>, labels: List<&2, Label>}

def phase_name(+kind: U32) -> String:
  Bool.pick(String,U32.is_eq(kind,2),"Agent work",Bool.pick(String,U32.is_eq(kind,1),"Workflows & waits","Activity unclear"))

def short_label(+kind: U32) -> String:
  Bool.pick(String,U32.is_eq(kind,2),"Work",Bool.pick(String,U32.is_eq(kind,1),"Wait","Unclear"))

def lookup(rows: List<&2, Measurement>, +name: String) -> Nat:
  match rows:
    case []: 0n
    case Measurement{+key,+width} <> rest:
      Bool.pick(Nat,String.eq(key,name),width,lookup(rest,name))

def fits(+width: Nat, limit: Nat) -> Bool:
  Bool.and(Nat.is_lt(0n,width),Nat.is_le(Nat.add(width,4n),limit))

def first_text(+measurements: List<&2, Measurement>, +full: String, +short: String, +limit: Nat) -> String:
  +full_width = lookup(measurements,full)
  +short_width = lookup(measurements,short)
  Bool.pick(String,fits(full_width,limit),full,Bool.pick(String,fits(short_width,limit),short,""))

def available_titles(parts: List<&2, Spans.Part>) -> List<&2, String>:
  match parts:
    case []: ["Agent work","Work","Workflows & waits","Wait","Activity unclear","Unclear"]
    case Spans.Part{_,_,_,name,_} <> rest: name <> available_titles(rest)

def bridge_labels(parts: List<&2, Spans.Entry>, +prior_kind: U32, +prior_paint: String, +scale: Nat, +width: Nat) -> List<&2, Spans.Entry>:
  match parts:
    case []: []
    case Spans.Entry{a,b,k,n,c} <> []: [Spans.Entry{a,b,k,n,c}]
    case Spans.Entry{+a,+b,+k,+n,+c} <> Spans.Entry{+x,+y,+j,+m,+d} <> rest:
      +short = Nat.is_lt(Nat.mul(Nat.sub(b,a),width),Nat.mul(64n,scale))
      +same = Bool.and(U32.is_eq(prior_kind,j),Bool.and(String.eq(prior_paint,c),String.eq(c,d)))
      +bridge = Bool.and(Bool.and(short,same),U32.is_eq(k,0))
      +kind = Bool.pick(U32,bridge,prior_kind,k)
      Spans.Entry{a,b,kind,Bool.pick(String,bridge,phase_name(kind),n),c} <>
        bridge_labels(Spans.Entry{x,y,j,m,d} <> rest,kind,c,scale,width)

def label_runs(tail: List<&2, Spans.Entry>, first: Spans.Entry) -> List<&2, Spans.Entry>:
  match tail first:
    case [] Spans.Entry{a,b,k,n,c}: [Spans.Entry{a,b,k,n,c}]
    case Spans.Entry{+x,+y,+j,+m,+d} <> rest Spans.Entry{+a,+b,+k,+n,+c}:
      +same = Bool.and(U32.is_eq(k,j),Bool.and(Nat.is_eq(b,x),Bool.not(Bool.or(Spans.is_special(n),Spans.is_special(m)))))
      +base_name = phase_name(k)
      +fill = Bool.pick(String,String.eq(c,d),c,"")
      +next = Bool.pick(Spans.Entry,same,Spans.Entry{a,y,k,base_name,fill},Spans.Entry{x,y,j,m,d})
      +combined = label_runs(rest,next)
      Bool.pick(List<&2,Spans.Entry>,same,combined,Spans.Entry{a,b,k,n,c} <> combined)

def label_regions(entries: List<&2, Spans.Entry>) -> List<&2, Spans.Entry>:
  match entries:
    case []: []
    case first <> rest: label_runs(rest,first)

def matches_color(+paint: String, dark: List<&2,String>) -> Bool:
  match dark:
    case []: False{}
    case shade <> rest: Bool.or(String.eq(paint,shade),matches_color(paint,rest))

def color_ink(paint: String) -> String:
  Bool.pick(String,matches_color(paint,["#392820",Spans.mix("#6a934f","#392820"),Spans.mix("#392820","#6a934f"),Spans.mix("#392820","#94b078"),Spans.mix("#392820","#ad9a85"),Spans.mix("#392820","#c6b7a5"),Spans.mix("#94b078","#392820"),Spans.mix("#ad9a85","#392820"),Spans.mix("#c6b7a5","#392820")]),"#fff4df","#1a130d")

def clamp(+n: Nat, +low: Nat, +high: Nat) -> Nat:
  Bool.pick(Nat,Nat.is_lt(n,low),low,Bool.pick(Nat,Nat.is_lt(high,n),high,n))

def larger(a: LabelWindow, b: LabelWindow) -> LabelWindow:
  match a b:
    case LabelWindow{+x,+y} LabelWindow{+u,+v}:
      Bool.pick(LabelWindow,Nat.is_lt(Nat.sub(y,x),Nat.sub(v,u)),LabelWindow{u,v},LabelWindow{x,y})

def free_window(times: List<&2,Nat>, +cursor: Nat, +a: Nat, +b: Nat, +pad: Nat, +best: LabelWindow) -> LabelWindow:
  match times:
    case []: larger(best,LabelWindow{cursor,b})
    case +at <> rest:
      +near = Bool.and(Nat.is_le(a,Nat.add(at,pad)),Nat.is_le(at,Nat.add(b,pad)))
      +stop = clamp(Nat.sub(at,pad),cursor,b)
      +next = clamp(Nat.add(at,pad),cursor,b)
      free_window(rest,Bool.pick(Nat,near,next,cursor),a,b,pad,
        Bool.pick(LabelWindow,near,larger(best,LabelWindow{cursor,stop}),best))

def region_label(window: LabelWindow, +kind: U32, +name: String, +fill: String, +scale: Nat, +width: Nat, +details: Bool,
  +measurements: List<&2,Measurement>, wide: Bool, +rest: List<&2,Label>) -> List<&2,Label>:
  match window:
    case LabelWindow{+a,+b}:
      +room = Nat.div(Nat.mul(Nat.sub(b,a),width),scale)
      +title = Bool.pick(String,details,name,phase_name(kind))
      +text = first_text(measurements,title,first_text(measurements,phase_name(kind),short_label(kind),room),room)
      +mixed = Bool.or(String.eq(fill,""),matches_color(fill,[Spans.mix("#392820","#b6cb9f"),Spans.mix("#392820","#c6b7a5"),Spans.mix("#b6cb9f","#392820"),Spans.mix("#c6b7a5","#392820")]))
      +background = Spans.base(kind)
      +ink = color_ink(Bool.pick(String,mixed,background,fill))
      +backing = Bool.pick(String,mixed,background,"transparent")
      +show = Bool.and(Bool.not(U32.is_eq(kind,0)),Bool.and(wide,Bool.not(String.eq(text,""))))
      Bool.pick(List<&2,Label>,show,Label{a,b,text,ink,backing} <> rest,rest)

def gather_labels(entries: List<&2, Spans.Entry>, +scale: Nat, +width: Nat, +details: Bool, +measurements: List<&2, Measurement>,
  +failures: List<&2,Nat>, +pad: Nat) -> List<&2, Label>:
  match entries:
    case []: []
    case Spans.Entry{+a,+b,kind,name,fill} <> tail:
      region_label(free_window(failures,a,a,b,pad,LabelWindow{a,a}),kind,name,fill,scale,width,details,measurements,
        Nat.is_le(Nat.mul(64n,scale),Nat.mul(Nat.sub(b,a),width)),
        gather_labels(tail,scale,width,details,measurements,failures,pad))

def layout(+truth: List<&2, Spans.Part>, +scale: Nat, +width: Nat, +details: Bool, measurements: List<&2, Measurement>, failures: List<&2,Nat>) -> Layout:
  +display = Spans.groups(truth,details)
  +colored = Spans.paint_gaps(Spans.colors(display,0,details),"#f2f5f6")
  +entries = Spans.collapse(List.length(&2,Spans.Entry,colored),colored,True{},scale,width)
  +margin = Nat.div(Nat.add(Nat.mul(5n,scale),width),width)
  Layout{entries,gather_labels(label_regions(bridge_labels(entries,0,"#f2f5f6",scale,width)),scale,width,details,measurements,
    Bool.pick(List<&2,Nat>,details,List.sort(~Nat,~Spans.n_before,failures),[]),margin)}

def shared_scale(durations: List<&2, Nat>, +longest: Nat) -> Nat:
  match durations:
    case []: longest
    case +duration <> rest:
      shared_scale(rest,Bool.pick(Nat,Nat.is_lt(longest,duration),duration,longest))

def valid_failures(times: List<&2,Nat>, +end: Nat) -> List<&2,Nat>:
  match times:
    case []: []
    case +at <> rest:
      +valid = Bool.and(Nat.is_lt(0n,at),Nat.is_lt(at,end))
      +tail = valid_failures(rest,end)
      Bool.pick(List<&2,Nat>,valid,at <> tail,tail)

def failure_points(details: Bool, +end: Nat, times: List<&2, Nat>) -> List<&2, Nat>:
  match details:
    case False{}: []
    case True{}: valid_failures(times,end)


type EvidenceTotals is Data:
  EvidenceTotals{work: Nat, workflow: Nat, unclear: Nat}

def add_time(+kind: U32, +duration: Nat, totals: EvidenceTotals) -> EvidenceTotals:
  match totals:
    case EvidenceTotals{work,workflow,unclear}:
      EvidenceTotals{
        Nat.add(work,Bool.pick(Nat,U32.is_eq(kind,2),duration,0n)),
        Nat.add(workflow,Bool.pick(Nat,U32.is_eq(kind,1),duration,0n)),
        Nat.add(unclear,Bool.pick(Nat,U32.is_eq(kind,0),duration,0n))}

def evidence_totals(parts: List<&2,Spans.Part>) -> EvidenceTotals:
  match parts:
    case []: EvidenceTotals{0n,0n,0n}
    case Spans.Part{a,b,kind,_,_} <> tail: add_time(kind,Nat.sub(b,a),evidence_totals(tail))

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

def rounded_utc(bounds: UtcSpan) -> UtcSpan:
  match bounds:
    case UtcSpan{a,b}:
      UtcSpan{Nat.mul(Nat.div(a,21600000n),21600000n),Nat.mul(Nat.div(Nat.add(b,21599999n),21600000n),21600000n)}

def utc_frame(input: List<&2,UtcSpan>) -> UtcSpan:
  match input:
    case []: UtcSpan{0n,21600000n}
    case first <> rest: rounded_utc(scan_utc(rest,first))

def utc_offset(bounds: UtcSpan, start: Nat) -> Nat:
  match bounds:
    case UtcSpan{a,_}: Nat.sub(start,a)

def utc_axis(bounds: UtcSpan) -> List<&2,Nat>:
  match bounds:
    case UtcSpan{+a,+b}:
      [a,Nat.add(a,Nat.mul(Nat.div(Nat.sub(b,a),43200000n),21600000n)),b]

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

def evidence(input: List<&2, Spans.Interval>, duration: Nat) -> List<&2, Spans.Part>:
  Spans.evidence(input,duration)

def time_summary(traces: List<&2, Summary.SummaryTrace>, from: Nat, to: Nat) -> Summary.TimeSummary:
  Summary.time_summary(traces,from,to)

def timeline_filter(traces: List<&2, Summary.SummaryTrace>, from: Nat, to: Nat, kind: U32, name: String) -> Summary.TimelineFilter:
  Summary.timeline_filter(traces,from,to,kind,name)

def initial_overview() -> Summary.OverviewSelection:
  Summary.initial_overview()

def select_overview(selection: Summary.OverviewSelection, action: Summary.OverviewAction) -> Summary.OverviewSelection:
  Summary.select_overview(selection,action)

def agent_work_trend(threads: List<&2,Trend.TrendThread>) -> List<&2,Trend.TrendBatch>:
  Trend.agent_work_trend(threads)

def recent_thread_positions(threads: List<&2,Trend.TrendThread>) -> List<&2,Nat>:
  Trend.recent_thread_positions(threads)
