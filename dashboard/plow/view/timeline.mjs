const feed = JSON.parse(document.getElementById('trace-data').textContent)
const traces = feed.traces.map((trace, index) => ({
  ...trace,
  title: 'Thread ' + (index + 1),
  shortTitle: 'Thread ' + (index + 1),
}))
const feedStatus = document.getElementById('feed-status')
const feedContent = document.getElementById('feed-content')
if (!feed.unavailable && traces.length === 0) {
  feedStatus.textContent = 'No measured session time has been imported yet.'
}
feedStatus.hidden = traces.length > 0
feedContent.hidden = traces.length === 0
if (traces.length > 0) {
  const cutoff = document.getElementById('feed-cutoff')
  cutoff.textContent = 'Observed through ' + new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(feed.observed) + ' UTC'
  cutoff.hidden = false
}
const rows = document.getElementById('traces')
const probe = document.querySelector('.measure')
const ruler = document.getElementById('chart-ruler')
const viewport = document.getElementById('timeline-viewport')
const grid = document.getElementById('timeline-grid')
const inspector = document.getElementById('thread-inspector')
const minimap = document.getElementById('minimap')
const miniWindow = minimap.querySelector('.mini-window')
const miniBrush = minimap.querySelector('.mini-brush')
const zoomIn = document.getElementById('zoom-in')
const zoomOut = document.getElementById('zoom-out')
const fitAll = document.getElementById('zoom-fit')
const modeReadout = document.getElementById('zoom-mode')
const millis = seconds => Math.round(seconds * 1000)
const percent = (value, end) => (value / end * 100).toFixed(5) + '%'
const asList = entries => entries.reduceRight((tail, head) => ({ $: 'Con', head, tail }), { $: 'Nil' })
function* values(list) {
  for (let next = list; next.$ === 'Con'; next = next.tail) yield next.head
}
const evidenceRows = traces.map(trace => {
  const end = millis(trace.end)
  const intervals = [
    ...trace.work.map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 2, name })),
    ...trace.wait.map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 1, name })),
  ]
  const evidence = policy.evidence(asList(intervals), end)
  const failures = asList(trace.errors.map(millis))
  return { ...trace, end, evidence, failures, totals: policy.evidence_totals(evidence),
    recordedFailures: [...values(policy.failure_points(true,end,failures))] }
})
const frame = policy.utc_frame(asList(evidenceRows.map(trace => ({
  $: 'UtcSpan', start: trace.startUtcMs, end: trace.startUtcMs + trace.end,
}))))
const scale = frame.end - frame.start
const utcDay = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', month:'short', day:'numeric' })
const utcClock = new Intl.DateTimeFormat('en-GB', { timeZone:'UTC', hour:'2-digit',minute:'2-digit', hourCycle:'h23' })
const axis = document.getElementById('scale-caption')
function drawTicks(visibleMillis) {
  axis.replaceChildren()
  for (const time of values(policy.chart_ticks(frame,visibleMillis,baseWidth))) {
    const tick = makeElement('span','utc-tick')
    tick.style.left = percent(policy.utc_offset(frame,time),scale)
    tick.append(makeElement('span','',utcDay.format(time)), makeElement('strong','',utcClock.format(time)))
    axis.append(tick)
  }
}
for (const [index,trace] of evidenceRows.entries()) {
  const mark = makeElement('span')
  mark.style.left = percent(policy.utc_offset(frame,trace.startUtcMs),scale)
  mark.style.width = percent(trace.end,scale)
  mark.style.top = 3 + index * 2.6 + 'px'
  minimap.querySelector('.mini-threads').append(mark)
}
const titles = new Set(evidenceRows.flatMap(trace => [...values(policy.available_titles(trace.evidence))]))
let details = false
let measuredWidth = 0
let openTrace = -1
let zoom = 1
let baseWidth = 0
const maximumZoom = 128

function makeElement(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}
function measure() {
  return asList([...titles].map(key => {
    probe.textContent = key
    return { $: 'Measurement', key, width: Math.ceil(probe.getBoundingClientRect().width) }
  }))
}
function elapsed(ms) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2,'0') + ':' + String(seconds % 60).padStart(2,'0')
}
function showEvidence(trace) {
  const heading = makeElement('h3','', trace.shortTitle + ' · Recorded timeline')
  heading.id = 'inspector-heading'
  const list = makeElement('ol','evidence-list')
  list.setAttribute('aria-label', 'Recorded timeline, elapsed from first message')
  const phases = [...values(trace.evidence)].map(p=>({start:p.a,end:p.b,label:p.name}))
  const failures = trace.recordedFailures.map(at=>({start:at,label:'Recorded failure'}))
  for(const item of [...phases,...failures].sort((a,b)=>a.start-b.start)){
    const row = makeElement('li',item.end===undefined?'failed':'')
    row.append(makeElement('time','',elapsed(item.start)+(item.end===undefined?'':'–'+elapsed(item.end))),makeElement('span','',item.label))
    list.append(row)
  }
  const summary = makeElement('p','evidence-summary')
  if(failures.length){
    summary.append(makeElement('strong','',failures.length===1?'Failure at ':'Failures at '))
    summary.append(failures.map(item=>elapsed(item.start)).join(', '))
  } else summary.textContent='No recorded failure.'
  inspector.replaceChildren(heading,summary,list)
}

function closeInspector() {
  rows.querySelector('.inspectable[aria-expanded="true"]')?.setAttribute('aria-expanded','false')
  openTrace = -1
  inspector.hidden = true
}

inspector.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  const trigger = rows.querySelector('.inspectable[aria-expanded="true"]')
  closeInspector()
  trigger?.focus()
})

function render(trace, width, measurements, index) {
  const plan = policy.layout(trace.evidence, scale, width, details, measurements, trace.failures)
  const row = makeElement('li', 'trace')
  const header = makeElement('header')
  const link = makeElement('strong', 'sample-title', trace.shortTitle)
  link.title = trace.title
  link.dataset.focusPart = 'source'
  const subtitle = utcDay.format(trace.startUtcMs) + ' · ' + utcClock.format(trace.startUtcMs) + ' UTC'
  const meta = makeElement('small','meta')
  meta.append(makeElement('span','',subtitle))
  link.setAttribute('aria-label',trace.title+' · '+subtitle)
  header.append(link,meta)
  const rail = makeElement(details?'button':'div',details?'rail inspectable':'rail')
  if(details){
    rail.type='button'
    rail.dataset.focusPart='timeline'
    rail.setAttribute('aria-label','Inspect '+trace.title+' · '+subtitle+' · '+trace.recordedFailures.length+' recorded failures')
    rail.setAttribute('aria-expanded',String(index===openTrace))
    rail.setAttribute('aria-controls',inspector.id)
    rail.addEventListener('click',()=>{
      const opening = openTrace !== index
      closeInspector()
      if (!opening) return
      openTrace = index
      rail.setAttribute('aria-expanded','true')
      showEvidence(trace)
      inspector.hidden = false
      inspector.scrollTop = 0
      inspector.focus()
    })
  } else {
    rail.setAttribute('role','img')
    rail.setAttribute('aria-label','Elapsed '+elapsed(trace.end)+'. Provider run '+elapsed(trace.totals.work)+
      '. Admission wait '+elapsed(trace.totals.workflow)+'. Unobserved '+elapsed(trace.totals.unclear)+
      '. '+trace.recordedFailures.length+' recorded failures.')
  }
  const bar = makeElement('span','bar')
  bar.style.setProperty('--length', percent(trace.end, scale))
  bar.style.left = percent(policy.utc_offset(frame,trace.startUtcMs),scale)
  const stops = [...values(plan.paint)].map(slice => slice.paint + ' ' + percent(slice.a, trace.end) + ' ' + percent(slice.b, trace.end))
  bar.style.background = 'linear-gradient(to right,' + stops.join(',') + ')'
  for (const label of values(plan.labels)) {
    const box = makeElement('span', 'label')
    box.style.setProperty('--at', percent(label.a, trace.end))
    box.style.setProperty('--width', percent(label.b - label.a, trace.end))
    const text = makeElement('span', '', label.text)
    text.style.color = label.ink
    text.style.background = label.background
    box.append(text)
    bar.append(box)
  }
  for (const time of values(policy.failure_points(details, trace.end, trace.failures))) {
    const marker = makeElement('i', 'marker')
    marker.title = 'Recorded failure'
    marker.style.setProperty('--at', percent(time, trace.end))
    bar.append(marker)
  }
  rail.append(bar)
  row.dataset.traceIndex = index
  row.append(header, rail)
  paintThreadMatch(row, rail, index)
  return row
}
function draw() {
  measuredWidth = Math.floor(ruler.clientWidth)
  if (!measuredWidth) return
  const measurements = measure()
  document.getElementById('failure-key').hidden=!details || !evidenceRows.some(trace=>trace.recordedFailures.length)
  const active = document.activeElement
  const row = active?.closest('.trace')
  const part = active?.dataset.focusPart
  rows.replaceChildren(...evidenceRows.map((trace,index)=>render(trace,measuredWidth,measurements,index)))
  if (row && part) rows.querySelector('[data-trace-index="'+row.dataset.traceIndex+'"] [data-focus-part="'+part+'"]')?.focus({preventScroll:true})
}
function bounds(value, low, high) {
  return Math.min(high, Math.max(low, value))
}
function paintWindow() {
  const timelineWidth = baseWidth * zoom
  if (!settingZoom && viewport.scrollLeft !== appliedScroll) rangeCenter = (viewport.scrollLeft / timelineWidth) + .5 / zoom
  paintRange()
  const end = viewport.getBoundingClientRect().left + viewport.clientWidth
  const start = end - baseWidth
  const visible = [...axis.children,...rows.querySelectorAll('.label span')].map(element=>{
    const box = element.getBoundingClientRect()
    return [element,box.left >= start-1 && box.right <= end+1]
  })
  for (const [element,show] of visible) element.style.visibility=show?'visible':'hidden'
}
function applyZoom(nextZoom, center) {
  zoom = bounds(nextZoom,1,maximumZoom)
  rangeCenter = bounds(center ?? rangeCenter,.5/zoom,1-.5/zoom)
  const visible = Math.round(scale / zoom)
  details = policy.detail_zoom(visible)
  if (!details && openTrace !== -1) closeInspector()
  modeReadout.textContent = durationLabel(visible) + ' visible' + ' · ' + (details ? 'Details' : 'Overview')
  zoomOut.disabled = zoom === 1
  fitAll.disabled = zoom === 1
  zoomIn.disabled = zoom === maximumZoom
  const heading = viewport.querySelector('.table-head')
  const columns = getComputedStyle(heading)
  const frozen = parseFloat(columns.gridTemplateColumns) + parseFloat(columns.columnGap)
  const width = Math.floor(viewport.clientWidth - frozen)
  if (width <= 0) return
  viewportWidth = viewport.clientWidth
  baseWidth = width
  grid.style.setProperty('--timeline-width', (baseWidth * zoom) + 'px')
  viewport.scrollLeft = (rangeCenter - .5/zoom) * baseWidth * zoom
  appliedScroll = viewport.scrollLeft
  settingZoom = true
  drawTicks(visible)
  draw()
  paintWindow()
  settingZoom = false
}
zoomIn.addEventListener('click',()=>applyZoom(zoom * 2))
zoomOut.addEventListener('click',()=>applyZoom(zoom / 2))
fitAll.addEventListener('click',resetRange)
viewport.addEventListener('scroll',paintWindow,{passive:true})

function miniPosition(event) {
  const box = minimap.getBoundingClientRect()
  return bounds((event.clientX - box.left) / box.width,0,1)
}
let brushStart = null
minimap.addEventListener('pointerdown',event=>{
  if(event.button!==0)return
  brushStart = miniPosition(event)
  miniBrush.hidden = false
  miniBrush.style.left = brushStart*100 + '%'
  miniBrush.style.width = '0%'
  minimap.setPointerCapture(event.pointerId)
})
minimap.addEventListener('pointermove',event=>{
  if(brushStart===null)return
  const stop = miniPosition(event)
  miniBrush.style.left = Math.min(stop,brushStart)*100 + '%'
  miniBrush.style.width = Math.abs(stop-brushStart)*100 + '%'
})
minimap.addEventListener('pointerup',event=>{
  if(brushStart===null)return
  const stop = miniPosition(event)
  const distance = Math.abs(stop-brushStart)
  if(distance * minimap.clientWidth >= 5) applyZoom(1 / distance,(stop+brushStart)/2)
  else if(zoom>1) applyZoom(zoom,stop)
  brushStart=null
  miniBrush.hidden=true
})
minimap.addEventListener('pointercancel',()=>{brushStart=null;miniBrush.hidden=true})
let pan = null
ruler.addEventListener('pointerdown',event=>{
  if(event.button!==0||zoom===1)return
  pan={start:event.clientX,scroll:viewport.scrollLeft}
  ruler.classList.add('panning')
  ruler.setPointerCapture(event.pointerId)
})
ruler.addEventListener('pointermove',event=>{
  if(pan)viewport.scrollLeft=pan.scroll+pan.start-event.clientX
})
function stopPanning(){
  pan=null
  ruler.classList.remove('panning')
}
ruler.addEventListener('pointerup',stopPanning)
ruler.addEventListener('pointercancel',stopPanning)

let viewportWidth=0
new ResizeObserver(()=>{
  if(viewportWidth===viewport.clientWidth)return
  viewportWidth=viewport.clientWidth
  applyZoom(zoom)
}).observe(viewport)
