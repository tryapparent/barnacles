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
const navigatorTrack = minimap.parentElement
const rangeControls = navigatorTrack.querySelector('.mini-handles')
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
const trendHistory = feed.history
const trendThreads = asList((trendHistory?.threads ?? []).map((thread, position) => ({
  $: 'TrendThread', position, start: position, work: thread.work, workflow: thread.workflow,
})))
PlowUI.renderAgentWorkTrend([...values(policy.agent_work_trend(trendThreads, trendHistory?.first ?? 1))])
const frame = policy.utc_frame(asList(evidenceRows.map(trace => ({
  $: 'UtcSpan', start: trace.startUtcMs, end: trace.startUtcMs + trace.end,
}))))
const scale = frame.end - frame.start
const utcDay = new Intl.DateTimeFormat('en-US', { timeZone:'UTC', month:'short', day:'numeric' })
const utcClock = new Intl.DateTimeFormat('en-GB', { timeZone:'UTC', hour:'2-digit',minute:'2-digit', hourCycle:'h23' })
const axis = document.getElementById('scale-caption')
function drawTicks() {
  axis.replaceChildren()
  for (const time of values(policy.chart_ticks(visibleWindow, duration(), baseWidth))) {
    const tick = makeElement('span','utc-tick')
    tick.style.left = percent(time - visibleWindow.start, duration())
    tick.append(makeElement('span','',utcDay.format(time)), makeElement('strong','', (duration() < 300000 ? exactClock : utcClock).format(time)))
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
let visibleWindow = frame
const minimumDuration = Math.max(1, Math.ceil(scale / 128))

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
  const close = makeElement('button', 'inspect-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close thread inspector')
  close.addEventListener('click', dismissInspector)
  inspector.replaceChildren(heading, close, summary, list)
}

function closeInspector() {
  rows.querySelector('.inspectable[aria-expanded="true"]')?.setAttribute('aria-expanded','false')
  openTrace = -1
  inspector.hidden = true
}

function dismissInspector() {
  const trigger = rows.querySelector('.inspectable[aria-expanded="true"]')
  closeInspector()
  trigger?.focus({ preventScroll:true })
}

inspector.addEventListener('keydown', event => {
  if (event.key === 'Escape') dismissInspector()
})

function render(trace, width, measurements, index) {
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
  const inspect = makeElement('button', 'inspectable', 'Inspect')
  inspect.type = 'button'
  inspect.dataset.focusPart = 'timeline'
  inspect.setAttribute('aria-label', 'Inspect ' + trace.title + ' · ' + subtitle + ' · ' + trace.recordedFailures.length + ' recorded failures')
  inspect.setAttribute('aria-expanded', String(index === openTrace))
  inspect.setAttribute('aria-controls', inspector.id)
  inspect.addEventListener('click', () => {
    const opening = openTrace !== index
    closeInspector()
    if (!opening) return
    openTrace = index
    inspect.setAttribute('aria-expanded', 'true')
    showEvidence(trace)
    inspector.hidden = false
    inspector.scrollTop = 0
    inspector.focus({ preventScroll:true })
  })
  header.append(inspect)
  const rail = makeElement('div', 'rail')
  rail.dataset.description = 'Elapsed ' + elapsed(trace.end) + '. Provider run ' + elapsed(trace.totals.work) +
    '. Admission wait ' + elapsed(trace.totals.workflow) + '. Unobserved ' + elapsed(trace.totals.unclear) +
    '. ' + trace.recordedFailures.length + ' recorded failures.'
  const action = makeElement('span', 'fit-target')
  const clipStart = Math.max(0, visibleWindow.start - trace.startUtcMs)
  const clipEnd = Math.min(trace.end, visibleWindow.end - trace.startUtcMs)
  if (clipEnd > clipStart) {
    const length = clipEnd - clipStart
    const left = percent(trace.startUtcMs + clipStart - visibleWindow.start, duration())
    const widthInView = percent(length, duration())
    const bar = makeElement('span', 'bar')
    bar.setAttribute('aria-hidden', 'true')
    bar.style.setProperty('--length', widthInView)
    bar.style.left = left
    const plan = policy.layout(trace.evidence, duration(), width, details, measurements, trace.failures)
    const clip = ({ a, b }) => ({ a: Math.max(a, clipStart) - clipStart, b: Math.min(b, clipEnd) - clipStart })
    const paint = [...values(plan.paint)].map(slice => ({ ...slice, ...clip(slice) })).filter(slice => slice.a < slice.b)
    const stops = paint.map(slice => slice.paint + ' ' + percent(slice.a, length) + ' ' + percent(slice.b, length))
    bar.style.background = 'linear-gradient(to right,' + stops.join(',') + ')'
    for (const label of values(plan.labels)) {
      const { a, b } = clip(label)
      if (a >= b) continue
      const box = makeElement('span', 'label')
      box.style.setProperty('--at', percent(a, length))
      box.style.setProperty('--width', percent(b - a, length))
      const text = makeElement('span', '', label.text)
      text.style.color = label.ink
      text.style.background = label.background
      box.append(text)
      bar.append(box)
    }
    for (const time of values(policy.failure_points(details, trace.end, trace.failures))) {
      if (time < clipStart || time > clipEnd) continue
      const marker = makeElement('i', 'marker')
      marker.style.setProperty('--at', percent(time - clipStart, length))
      bar.append(marker)
    }
    action.style.left = 'min(' + left + ',calc(100% - 8px))'
    action.style.width = widthInView
    rail.append(bar)
  }
  rail.append(action)
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
  PlowUI.renderTimelineControls(evidenceRows.map((trace, index) => ({
    host: rows.children[index].querySelector('.fit-target'),
    label: 'Fit ' + trace.title + '. ' + rows.children[index].querySelector('.rail').dataset.description,
    fit: () => applyWindow(policy.view_window(frame, trace.startUtcMs, trace.end, 1), true),
    visible: policy.window_overlap(visibleWindow, trace.startUtcMs, trace.startUtcMs + trace.end),
  })), {
    host: rangeControls, max: scale,
    value: [visibleWindow.start - frame.start, visibleWindow.end - frame.start],
    format: value => utc(frame.start + value) + ' UTC',
    resize: (index, value) => moveBoundary(index === 0, frame.start + value),
  })
  if (row && part) rows.querySelector('[data-trace-index="'+row.dataset.traceIndex+'"] [data-focus-part="'+part+'"]')?.focus({preventScroll:true})
}
function chartPlot() {
  return { left: ruler.getBoundingClientRect().left, width: baseWidth }
}
function paintWindow() {
  const { left, width } = chartPlot()
  for (const element of [...axis.children, ...rows.querySelectorAll('.label span')]) {
    const box = element.getBoundingClientRect()
    element.style.visibility = box.left >= left - 1 && box.right <= left + width + 1 ? 'visible' : 'hidden'
  }
}
function duration() {
  return visibleWindow.end - visibleWindow.start
}
let fitted = false
function applyWindow(next, focused = false) {
  if (!traces.length) return
  visibleWindow = next
  const heading = getComputedStyle(viewport.querySelector('.table-head'))
  const frozen = parseFloat(heading.gridTemplateColumns) + parseFloat(heading.columnGap)
  viewportWidth = viewport.clientWidth
  baseWidth = Math.floor(viewportWidth - frozen)
  if (baseWidth <= 0) return
  zoom = scale / duration()
  fitted = focused
  details = policy.trace_details(duration(), fitted)
  grid.style.setProperty('--timeline-width', baseWidth + 'px')
  clearTooltip()
  drawTicks()
  draw()
  paintRange()
  paintWindow()
}
function panWindow(fraction, start = visibleWindow.start) {
  applyWindow(policy.view_window(frame, Math.max(0, Math.round(start + fraction * duration())), duration(), 1))
}
function zoomWindow(factor, anchor) {
  const length = duration()
  const next = policy.view_window(frame, frame.start, Math.round(length * factor), Math.min(minimumDuration, length))
  const nextLength = next.end - next.start
  const start = Math.max(0, Math.round(visibleWindow.start + (length - nextLength) * anchor))
  applyWindow(policy.view_window(frame, start, nextLength, 1))
}
function selectWindow(first, last, distance, bounds) {
  if (!policy.brush_ready(Math.round(distance))) return
  const span = bounds.end - bounds.start
  const start = Math.round(bounds.start + span * first)
  applyWindow(policy.view_window(frame, start, Math.round(span * (last - first)), Math.min(minimumDuration, span)))
}
function moveBoundary(startEdge, position) {
  applyWindow(policy.move_edge(frame, visibleWindow, Math.max(0, Math.round(position)), minimumDuration, startEdge))
}

PlowUI.wireChartInput({
  viewport, ruler, rows, plot: chartPlot, start: () => visibleWindow.start,
  select: (first, last, distance) => selectWindow(first, last, distance, visibleWindow),
  pan: panWindow, zoom: zoomWindow, reset: () => applyWindow(frame),
  hover: hoverBar, dismissTip: clearTooltip,
})
let lastTip = ''
const exactClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
function clearTooltip() {
  lastTip = ''
  PlowUI.hideTimelineTooltip()
}
function hoverBar(target, event) {
  const trace = evidenceRows[Number(target.closest('.trace').dataset.traceIndex)]
  const { left } = chartPlot()
  const at = Math.max(0, Math.round(visibleWindow.start + (event.clientX - left) / baseWidth * duration() - trace.startUtcMs))
  const failures = details ? [...values(policy.hover_failures(asList(trace.recordedFailures), at, Math.ceil(4 * duration() / baseWidth)))] : []
  const label = failures.length ? failures.length + (failures.length === 1 ? ' recorded failure' : ' recorded failures')
    : policy.hover_phase(trace.evidence, at)
  if (!label) return clearTooltip()
  const times = failures.map(time => exactClock.format(trace.startUtcMs + time) + ' UTC')
  const key = [trace.startUtcMs, label, ...times].join('/')
  if (key === lastTip) return
  lastTip = key
  PlowUI.showTimelineTooltip(event.clientX, event.clientY, { label, times })
}

let viewportWidth = 0
new ResizeObserver(() => {
  if (viewportWidth !== viewport.clientWidth) applyWindow(visibleWindow, fitted)
}).observe(viewport)
