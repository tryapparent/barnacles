function elapsed(ms) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2,'0') + ':' + String(seconds % 60).padStart(2,'0')
}
function decodeEvidence(trace) {
  const end = millis(trace.end)
  const intervals = [
    ...trace.work.map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 2, name })),
    ...(trace.detail ?? []).map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 3, name })),
    ...trace.wait.map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 1, name })),
    ...(trace.between ?? []).map(([a, b, name]) => ({ $: 'Interval', a: millis(a), b: millis(b), kind: 0, name })),
  ]
  const evidence = policy.evidence(asList(intervals), end)
  const failures = asList(trace.errors.map(millis))
  const ci = (trace.ci ?? []).map(([start, end, label]) => ({ start: millis(start), end: millis(end), label }))
  return { ...trace, end, extent: millis(trace.extent ?? trace.end), ci, evidence, failures, totals: policy.evidence_totals(evidence),
    recordedFailures: [...values(policy.failure_points(true,end,failures))] }
}
const feedStatus = document.getElementById('feed-status')
const feedContent = document.getElementById('feed-content')
if (feed.observed > 0) {
  const cutoff = document.getElementById('feed-cutoff')
  cutoff.textContent = 'Observed through ' + new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }).format(feed.observed) + ' UTC'
  cutoff.hidden = false
}
const tiles = document.getElementById('tiles')
const operationPanel = document.getElementById('operation-panel')
const operationTiles = document.getElementById('operation-tiles')
const collapse = document.getElementById('collapse')
const summarySurface = document.querySelector('.summary-surface')
const summaryTop = document.querySelector('.summary-top')
const summaryMotion = matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active)')
const timelineSelection = document.getElementById('timeline-selection')
const categories = [
  { kind: 1, name: 'Admission wait', style: 'workflow' },
  { kind: 2, name: 'Provider run', style: 'agent' },
  { kind: 0, name: 'Outside runs', style: 'unclear' },
]
const summaryInput = rows => asList(rows.map((trace, index) => ({
  $: 'SummaryTrace', index: index + 1, start: trace.startUtcMs, parts: trace.evidence,
})))
const overviewEnd = feed.overview?.to ?? feed.observed
const feedStart = feed.overview?.from ?? policy.dashboard_frame('24h', overviewEnd).start
const overviewRows = (feed.overview?.traces ?? feed.traces).map(decodeEvidence)
const overviewTraces = summaryInput(overviewRows)
const spans = asList(overviewRows.map(trace => ({
  $: 'UtcSpan', start: trace.startUtcMs, end: trace.startUtcMs + trace.extent,
})))
let timelineTraces
let overview
let selection = policy.initial_overview()
let previousWindow = ''
let matches = new Map()

const shareLabel = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 })
const share = (part, total) => part && part / total < .001 ? '<0.1%' : shareLabel.format(part ? part / total : 0)
const utc = time => utcDay.format(time) + ' ' + utcClock.format(time)
const durationLabel = ms => {
  const minutes = Math.round(ms / 60000)
  if (minutes === 0) return '<1m'
  if (minutes < 60) return minutes + 'm'
  return Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm'
}
const threadCount = count => count === 1 ? '1 thread' : count + ' threads'
const operationLabel = name => name === 'Unobserved' ? 'Unobserved interval' : name

const navigatorTrack = minimap.parentElement
const miniWindow = minimap.querySelector('.mini-window')
const miniBrush = minimap.querySelector('.mini-brush')
function miniPosition(event) {
  const box = minimap.getBoundingClientRect()
  return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
}
let gesture = null
let previousTap = null
navigatorTrack.addEventListener('pointerdown', event => {
  if (event.button !== 0 || gesture || event.target.closest('.mini-handle')) return
  const start = miniPosition(event)
  const left = (visibleWindow.start - frame.start) / scale()
  const right = (visibleWindow.end - frame.start) / scale()
  event.preventDefault()
  minimap.focus({ preventScroll:true })
  const mode = zoom > 1 && start >= left && start <= right ? 'pan' : 'brush'
  gesture = { id: event.pointerId, start, mode, window: visibleWindow }
  navigatorTrack.setPointerCapture(event.pointerId)
})
navigatorTrack.addEventListener('pointermove', event => {
  if (gesture?.id !== event.pointerId) return
  const stop = miniPosition(event)
  const delta = stop - gesture.start
  if (gesture.mode === 'pan') {
    panWindow(delta * scale() / duration(), gesture.window.start)
  } else {
    miniBrush.hidden = false
    miniBrush.style.left = Math.min(stop, gesture.start) * 100 + '%'
    miniBrush.style.width = Math.abs(delta) * 100 + '%'
  }
})
navigatorTrack.addEventListener('pointerup', event => {
  if (gesture?.id !== event.pointerId) return
  const stop = miniPosition(event)
  const distance = Math.abs(stop - gesture.start) * minimap.clientWidth
  if (distance < 4) {
    const repeat = previousTap && event.timeStamp - previousTap.time < 450 && Math.abs(event.clientX - previousTap.x) < 8
    previousTap = repeat ? null : { time: event.timeStamp, x: event.clientX }
    if (repeat) applyWindow(frame)
    else if (gesture.mode === 'brush' && zoom > 1) panWindow(0, frame.start + scale() * stop - duration() / 2)
  } else {
    previousTap = null
    if (gesture.mode === 'brush') selectWindow(Math.min(stop, gesture.start), Math.max(stop, gesture.start), distance, frame)
  }
  gesture = null
  miniBrush.hidden = true
})
navigatorTrack.addEventListener('lostpointercapture', () => {
  gesture = null
  miniBrush.hidden = true
})
navigatorTrack.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Home') {
    applyWindow(frame)
    return
  }
  const direction = event.key === 'ArrowLeft' ? -1 : 1
  const delta = direction * Math.max(scale() * .005, duration() * .1)
  const thumb = event.target.closest('.mini-handle')?.dataset.index
  if (thumb === '0') moveBoundary(true, visibleWindow.start + delta)
  else if (thumb === '1') moveBoundary(false, visibleWindow.end + delta)
  else panWindow(delta / duration())
}, true)

function paintRange() {
  const { start, end } = visibleWindow
  const first = (start - frame.start) / scale()
  const last = (end - frame.start) / scale()
  miniWindow.style.left = (first * 100) + '%'
  miniWindow.style.width = (100 / zoom) + '%'
  navigatorTrack.classList.toggle('has-range', zoom > 1)
  viewport.dataset.start = start
  viewport.dataset.end = end
  minimap.setAttribute('aria-valuenow', String(Math.round((first + last) * 50)))
  const rangeLabel = utc(start) + ' – ' + utc(end) + ' UTC'
  minimap.setAttribute('aria-valuetext', rangeLabel)
  const key = start + '/' + end
  if (previousWindow === key) return
  previousWindow = key
  paintFilter(start, end, false)
}

function categoryButton(kind) {
  return tiles.querySelector('[data-kind="' + kind + '"]')
}

function operationButton(name) {
  return [...operationPanel.querySelectorAll('[data-operation]')].find(button => button.dataset.operation === name)
}

function animateCategory(tile, opening, previousPaint, interrupted) {
  const bounds = tile.getBoundingClientRect()
  const card = summarySurface.getBoundingClientRect()
  const paint = opening ? { background: getComputedStyle(summarySurface).background } : previousPaint
  const frameFor = rect => ({
    transform: `translate(${rect.x - card.x}px,${rect.y - card.y}px) scale(${rect.width / card.width},${rect.height / card.height})`,
    borderRadius: rect === card ? 'inherit' : '5px',
    ...paint,
    visibility: 'visible',
  })
  const duration = opening ? 330 : 235
  summarySurface.animate(opening ? [frameFor(bounds), frameFor(card)] : [frameFor(interrupted ?? card), frameFor(bounds)], {
    duration, easing: 'cubic-bezier(.2,.8,.2,1)',
  })
  for (const element of opening ? [summaryTop, operationPanel] : [summaryTop]) {
    element.animate([{ opacity: 0 }, { opacity: 0, offset: .28 }, { opacity: 1 }], { duration })
  }
}

function selectCategory(category) {
  const tile = categoryButton(category.kind)
  const opening = operationPanel.hidden
  const surfaceStyle = getComputedStyle(summarySurface)
  const previousPaint = {
    background: surfaceStyle.background,
  }
  const interrupted = !opening && summarySurface.getAnimations().length ? summarySurface.getBoundingClientRect() : null
  for (const element of [summarySurface, summaryTop, operationPanel]) {
    for (const animation of element.getAnimations()) animation.cancel()
  }
  selection = policy.select_overview(selection, { $:'SelectCategory', kind:category.kind })
  renderSummary()
  paintFilter(visibleWindow.start, visibleWindow.end)
  if (tile && !summaryMotion.matches) animateCategory(tile, opening, previousPaint, interrupted)
  const next = operationPanel.hidden ? categoryButton(category.kind) : collapse
  next?.focus({ preventScroll:true })
}

function selectOperation(name) {
  selection = policy.select_overview(selection, { $:'SelectOperation', name })
  renderSummary()
  paintFilter(visibleWindow.start, visibleWindow.end)
  const next = operationButton(name) ?? operationTiles.firstElementChild ?? collapse
  next.focus({ preventScroll:true })
}

function renderSummary() {
  const focused = document.activeElement
  const result = overview
  const groups = new Map([...values(result.categories)].map(group => [group.kind, group]))
  const activeCategory = categories.find(category => category.kind === selection.category)
  const group = groups.get(selection.category)
  const operations = group ? [...values(group.operations)].map(operation => ({
    key: operation.name,
    name: operationLabel(operation.name),
    metric: durationLabel(operation.duration),
    weight: operation.duration,
    share: share(operation.duration, group.duration),
    active: operation.name === selection.operation,
    select: () => selectOperation(operation.name),
  })) : []
  const selected = selection.operation
  const recovery = selected && !operations.some(operation => operation.key === selected)
    ? { key: selected, name: 'Clear ' + operationLabel(selected) }
    : undefined

  PlowUI.renderSummary({
    total: result.duration ? durationLabel(result.duration) + ' across ' + threadCount(result.threads) : 'No recorded time in this range',
    hasTime: result.duration > 0,
    categories: categories.map(category => {
      const group = groups.get(category.kind)
      return {
        ...category,
        duration: group ? durationLabel(group.duration) : '0m',
        weight: group?.duration ?? 0,
        share: share(group?.duration ?? 0, result.duration),
        expanded: category.kind === selection.category,
        select: () => selectCategory(category),
      }
    }),
    breakdown: activeCategory?.name,
    operations,
    recovery,
    emptyOperations: operations.length === 0,
    close: () => selectCategory(activeCategory),
    clearOperation: selected ? () => selectOperation(selected) : undefined,
  })

  if (focused.dataset.kind !== undefined) categoryButton(focused.dataset.kind)?.focus({ preventScroll:true })
  if (focused.dataset.operation !== undefined) {
    const next = operationButton(focused.dataset.operation) ?? operationTiles.firstElementChild ?? collapse
    if (!operationPanel.hidden) next.focus({ preventScroll:true })
  }
}

function paintFilter(start, end, repaint = true) {
  const filter = selection.operation
    ? policy.timeline_filter(timelineTraces, start, end, selection.category, selection.operation)
    : null
  matches = new Map(filter ? [...values(filter.matches)].map(match => [match.index - 1, match.spans]) : [])
  const status = !filter ? '' : filter.threads > 0
    ? operationLabel(selection.operation) + ' · ' + threadCount(filter.threads) + ' shown'
    : 'No matching threads in this range. Zoom out or deselect the operation.'
  if (timelineSelection.textContent !== status) timelineSelection.textContent = status
  timelineSelection.toggleAttribute('data-empty', !!filter && filter.threads === 0)
  document.getElementById('timeline-panel').dataset.category = selection.category
  if (openTrace !== -1 && selection.operation && !matches.has(openTrace)) closeInspector()
  if (!repaint) return
  for (const row of rows.children) paintThreadMatch(row, row.querySelector('.rail'), Number(row.dataset.traceIndex))
}

function paintThreadMatch(row, rail, index) {
  const spans = matches.get(index)
  row.hidden = !!selection.operation && !spans
  row.classList.toggle('has-match', !!spans)
  rail.querySelectorAll('.match-span').forEach(mark => mark.remove())
  const header = row.querySelector('header')
  header.querySelector('.thread-match')?.remove()
  if (!spans) return

  const check = makeElement('span', 'thread-match', '✓')
  check.setAttribute('aria-hidden', 'true')
  header.prepend(check)
  for (const span of values(spans)) {
    const mark = makeElement('span', 'match-span')
    mark.style.left = percent(span.start - visibleWindow.start, duration())
    mark.style.width = percent(span.end - span.start, duration())
    rail.append(mark)
  }
}

function showRange(range) {
  frame = policy.dashboard_frame(range, overviewEnd)
  const complete = policy.feed_covers(range, frame, feedStart)
  evidenceRows = complete ? [...values(policy.timeline_indices(spans, overviewRows.length, frame, 0))].map((index, row) => ({
    ...overviewRows[index], title: overviewRows[index].title || 'Thread ' + (row + 1),
  })) : []
  feedStatus.hidden = evidenceRows.length > 0
  feedContent.hidden = !feedStatus.hidden
  if (feed.unavailable) return
  feedStatus.textContent = !complete ? 'Seven-day activity is temporarily unavailable. Reload to try again.'
    : 'No measured session time in this range.'
  closeInspector()
  clearTooltip()
  if (!evidenceRows.length) return

  viewport.scrollTop = 0
  document.getElementById('timeline-count').textContent = threadCount(evidenceRows.length)
  selection = policy.initial_overview()
  previousWindow = ''
  timelineTraces = summaryInput(evidenceRows)
  overview = policy.time_summary(overviewTraces, frame.start, frame.end)
  PlowUI.renderAgentWorkTrend([...values(policy.agent_work_trend(overviewTraces, range, frame.start, frame.end))])
  renderSummary()
  minimap.querySelector('.mini-threads').replaceChildren(...evidenceRows.map((trace, index) => {
    const mark = makeElement('span')
    const start = Math.max(frame.start, trace.startUtcMs)
    const end = Math.min(frame.end, trace.startUtcMs + trace.extent)
    mark.style.left = percent(start - frame.start, scale())
    mark.style.width = percent(end - start, scale())
    mark.style.top = 3 + index % 7 * 2.6 + 'px'
    return mark
  }))
  measurementWidth = undefined
  applyWindow(frame)
}

document.addEventListener('plow-range-change', event => showRange(event.detail))
showRange('24h')
document.fonts.ready.then(() => {
  measurementWidth = undefined
  applyWindow(visibleWindow, fitted)
})
