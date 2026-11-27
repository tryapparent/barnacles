const eyeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>'
const feed = JSON.parse(document.getElementById('trace-data').textContent)
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
function decodeEvidence(trace) {
  const end = millis(trace.end)
  const intervals = [
    ...trace.work.map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 2, name })),
    ...(trace.detail ?? []).map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 3, name })),
    ...trace.wait.map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 1, name })),
  ]
  const evidence = policy.evidence(asList(intervals), end)
  const failures = asList(trace.errors.map(millis))
  return { ...trace, end, evidence, failures, totals: policy.evidence_totals(evidence),
    recordedFailures: [...values(policy.failure_points(true,end,failures))] }
}
let evidenceRows = []
let frame
const scale = () => frame.end - frame.start
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
let details = false
let measuredWidth = 0
let measurements
let measurementWidth
let openTrace = -1
let zoom = 1
let baseWidth = 0
let visibleWindow
const minimumDuration = () => Math.max(1, Math.ceil(scale() / 128))

function makeElement(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}
function measure() {
  const titles = new Set(evidenceRows.flatMap(trace => [...values(policy.available_titles(trace.evidence))]))
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
  const heading = makeElement('h3', '', trace.title + ' · Recorded timeline')
  heading.id = 'inspector-heading'
  const list = makeElement('ol','evidence-list')
  list.setAttribute('aria-label', 'Recorded timeline, elapsed from first message')
  const phases = [...values(trace.evidence)].map(p=>({start:p.a,end:p.b,label:p.name}))
  const ci = (trace.ci ?? []).map(([start, end, label]) => ({ start: millis(start), end: millis(end), label }))
  const failures = trace.recordedFailures.map(at=>({start:at,label:'Recorded failure'}))
  for(const item of [...phases,...ci,...failures].sort((a,b)=>a.start-b.start)){
    const row = makeElement('li',item.end===undefined?'failed':'')
    row.append(makeElement('time','',elapsed(item.start)+(item.end===undefined?'':'–'+elapsed(item.end))),makeElement('span','',item.label))
    list.append(row)
  }
  const close = makeElement('button', 'inspect-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', 'Close thread inspector')
  close.addEventListener('click', dismissInspector)
  const coverage = makeElement('p', 'evidence-summary',
    ci.length ? 'CI watcher observations can overlap provider runs.' :
      'No linked CI watcher observations for this thread. Unobserved time has no recorded thread activity.')
  inspector.replaceChildren(heading, close, list, coverage)
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
  const title = makeElement('strong', 'sample-title', trace.title)
  const subtitle = utcDay.format(trace.startUtcMs) + ' · ' + utcClock.format(trace.startUtcMs) + ' UTC'
  const meta = makeElement('small','meta')
  meta.append(makeElement('span','',subtitle))
  header.append(title,meta)
  const inspect = makeElement('button', 'inspectable')
  inspect.innerHTML = eyeIcon
  inspect.title = 'Inspect thread'
  inspect.type = 'button'
  inspect.dataset.focusPart = 'timeline'
  inspect.setAttribute('aria-label', 'Inspect ' + trace.title)
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
    for (const slice of paint) {
      const surface = makeElement('span', 'field-span')
      surface.dataset.kind = slice.kind
      surface.style.setProperty('--at', percent(slice.a, length))
      surface.style.setProperty('--width', percent(slice.b - slice.a, length))
      bar.append(surface)
    }
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
  if (measurementWidth !== measuredWidth) {
    measurements = measure()
    measurementWidth = measuredWidth
  }
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
    host: rangeControls, max: scale(),
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
  let previousRight = left - 4
  for (const tick of axis.children) {
    const box = tick.getBoundingClientRect()
    const fits = box.left >= previousRight + 4 && box.right <= left + width + 1
    tick.style.visibility = fits ? 'visible' : 'hidden'
    if (fits) previousRight = box.right
  }
  for (const label of rows.querySelectorAll('.label span')) {
    const box = label.getBoundingClientRect()
    label.style.visibility = box.left >= left - 1 && box.right <= left + width + 1 ? 'visible' : 'hidden'
  }
}
function duration() {
  return visibleWindow.end - visibleWindow.start
}
let fitted = false
let pendingDraw = 0
function applyWindow(next, focused = false) {
  if (!evidenceRows.length) return
  visibleWindow = next
  fitted = focused
  if (!pendingDraw) pendingDraw = requestAnimationFrame(drawWindow)
}
function drawWindow() {
  pendingDraw = 0
  const heading = getComputedStyle(viewport.querySelector('.table-head'))
  const frozen = parseFloat(heading.gridTemplateColumns) + parseFloat(heading.columnGap)
  viewportWidth = viewport.clientWidth
  baseWidth = Math.floor(viewportWidth - frozen)
  if (baseWidth <= 0) return
  zoom = scale() / duration()
  details = policy.trace_details(duration(), fitted)
  grid.style.setProperty('--timeline-width', baseWidth + 'px')
  clearTooltip()
  drawTicks()
  paintRange()
  draw()
  paintWindow()
}
function panWindow(fraction, start = visibleWindow.start) {
  applyWindow(policy.view_window(frame, Math.max(0, Math.round(start + fraction * duration())), duration(), 1))
}
function zoomWindow(factor, anchor) {
  const length = duration()
  const next = policy.view_window(frame, frame.start, Math.round(length * factor), Math.min(minimumDuration(), length))
  const nextLength = next.end - next.start
  const start = Math.max(0, Math.round(visibleWindow.start + (length - nextLength) * anchor))
  applyWindow(policy.view_window(frame, start, nextLength, 1))
}
function selectWindow(first, last, distance, bounds) {
  if (!policy.brush_ready(Math.round(distance))) return
  const span = bounds.end - bounds.start
  const start = Math.round(bounds.start + span * first)
  applyWindow(policy.view_window(frame, start, Math.round(span * (last - first)), Math.min(minimumDuration(), span)))
}
function moveBoundary(startEdge, position) {
  applyWindow(policy.move_edge(frame, visibleWindow, Math.max(0, Math.round(position)), minimumDuration(), startEdge))
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
