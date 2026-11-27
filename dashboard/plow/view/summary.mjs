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
  { kind: 0, name: 'Unobserved', style: 'unclear' },
]
const summaryInput = rows => asList(rows.map((trace, index) => ({
  $: 'SummaryTrace', index: index + 1, start: trace.startUtcMs, parts: trace.evidence,
})))
const timelineTraces = summaryInput(evidenceRows)
const overviewEnd = feed.overview?.to ?? feed.observed
const overviewStart = policy.overview_start(overviewEnd)
const overviewRows = feed.overview ? feed.overview.traces.map(decodeEvidence) : evidenceRows
const overviewTraces = summaryInput(overviewRows)
const overview = policy.time_summary(overviewTraces, overviewStart, overviewEnd)
PlowUI.renderAgentWorkTrend([...values(policy.agent_work_trend(overviewTraces, overviewStart))])
let selection = policy.initial_overview()
let previousWindow = ''
let matches = new Map()

const shareLabel = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 })
const utc = time => utcDay.format(time) + ' ' + utcClock.format(time)
const durationLabel = ms => {
  const minutes = Math.round(ms / 60000)
  if (minutes === 0) return '<1m'
  if (minutes < 60) return minutes + 'm'
  return Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm'
}
const threadCount = count => count === 1 ? '1 thread' : count + ' threads'
const operationLabel = name => selection.category === 0 ? 'Unobserved interval' : name

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
  const left = (visibleWindow.start - frame.start) / scale
  const right = (visibleWindow.end - frame.start) / scale
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
    panWindow(delta * scale / duration(), gesture.window.start)
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
    else if (gesture.mode === 'brush' && zoom > 1) panWindow(0, frame.start + scale * stop - duration() / 2)
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
  const delta = direction * Math.max(scale * .005, duration() * .1)
  const thumb = event.target.closest('.mini-handle')?.dataset.index
  if (thumb === '0') moveBoundary(true, visibleWindow.start + delta)
  else if (thumb === '1') moveBoundary(false, visibleWindow.end + delta)
  else panWindow(delta / duration())
}, true)

function paintRange() {
  const { start, end } = visibleWindow
  const first = (start - frame.start) / scale
  const last = (end - frame.start) / scale
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
    share: shareLabel.format(operation.duration / group.duration),
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
        share: shareLabel.format(group ? group.duration / result.duration : 0),
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

if (traces.length > 0) {
  renderSummary()
  applyWindow(frame)
  document.fonts.ready.then(() => {
    measurementWidth = undefined
    applyWindow(visibleWindow, fitted)
  })
}
