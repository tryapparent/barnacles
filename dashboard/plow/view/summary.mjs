const tiles = document.getElementById('tiles')
const operationPanel = document.getElementById('operation-panel')
const operationTiles = document.getElementById('operation-tiles')
const collapse = document.getElementById('collapse')
const timelineSelection = document.getElementById('timeline-selection')
const categories = [
  { kind: 1, name: 'Admission wait', style: 'workflow' },
  { kind: 2, name: 'Provider run', style: 'agent' },
  { kind: 0, name: 'Unobserved', style: 'unclear' },
]
const summaryTraces = asList(evidenceRows.map((trace, index) => ({
  $: 'SummaryTrace', index: index + 1, start: trace.startUtcMs, parts: trace.evidence,
})))

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
  if (gesture.mode === 'brush') {
    const stop = miniPosition(event)
    const distance = Math.abs(stop - gesture.start)
    if (distance * minimap.clientWidth < 4 && zoom > 1) panWindow(0, frame.start + scale * stop - duration() / 2)
    else selectWindow(Math.min(stop, gesture.start), Math.max(stop, gesture.start), distance * minimap.clientWidth, frame)
  }
  gesture = null
  miniBrush.hidden = true
})
navigatorTrack.addEventListener('lostpointercapture', () => {
  gesture = null
  miniBrush.hidden = true
})
navigatorTrack.addEventListener('dblclick', () => applyWindow(frame))
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
  renderSummary(start, end)
  paintFilter(start, end)
}

function categoryButton(kind) {
  return tiles.querySelector('[data-kind="' + kind + '"]')
}

function operationButton(name) {
  return [...operationTiles.children].find(button => button.dataset.operation === name)
}

function selectCategory(category) {
  selection = policy.select_overview(selection, { $:'SelectCategory', kind:category.kind })
  previousWindow = ''
  paintRange()
  categoryButton(category.kind)?.focus({ preventScroll:true })
}

function selectOperation(name) {
  selection = policy.select_overview(selection, { $:'SelectOperation', name })
  previousWindow = ''
  paintRange()
  const next = operationButton(name) ?? operationTiles.firstElementChild ?? collapse
  next.focus({ preventScroll:true })
}

function renderSummary(windowStart, windowEnd) {
  const focused = document.activeElement
  const result = policy.time_summary(summaryTraces, windowStart, windowEnd)
  const groups = new Map([...values(result.categories)].map(group => [group.kind, group]))
  const activeCategory = categories.find(category => category.kind === selection.category)
  const group = groups.get(selection.category)
  const operations = group ? [...values(group.operations)].map(operation => ({
    key: operation.name,
    name: operationLabel(operation.name),
    metric: durationLabel(operation.duration) + ' · ' + shareLabel.format(operation.duration / group.duration),
    active: operation.name === selection.operation,
    select: () => selectOperation(operation.name),
  })) : []
  const emptyOperations = operations.length === 0
  const selected = selection.operation
  if (selected && !operations.some(operation => operation.key === selected)) {
    operations.push({ key: selected, name: 'Clear ' + operationLabel(selected), select: () => selectOperation(selected) })
  }

  PlowUI.renderSummary({
    total: result.duration ? durationLabel(result.duration) + ' across ' + threadCount(result.threads) : '',
    note: result.duration ? 'Time is summed across threads in the visible UTC range.' : 'No recorded time in this range. Try zooming out.',
    categories: categories.map(category => {
      const group = groups.get(category.kind)
      return {
        ...category,
        duration: group ? durationLabel(group.duration) : '0m',
        share: shareLabel.format(group ? group.duration / result.duration : 0),
        expanded: category.kind === selection.category,
        select: () => selectCategory(category),
      }
    }),
    breakdown: activeCategory && activeCategory.name + ' breakdown',
    operations,
    emptyOperations,
    close: () => selectCategory(activeCategory),
    clearOperation: selected ? () => selectOperation(selected) : undefined,
  })

  if (focused.dataset.kind !== undefined) categoryButton(focused.dataset.kind)?.focus({ preventScroll:true })
  if (focused.dataset.operation !== undefined) {
    const next = operationButton(focused.dataset.operation) ?? operationTiles.firstElementChild ?? collapse
    if (!operationPanel.hidden) next.focus({ preventScroll:true })
  }
}

function paintFilter(start, end) {
  const filter = selection.operation
    ? policy.timeline_filter(summaryTraces, start, end, selection.category, selection.operation)
    : null
  matches = new Map(filter ? [...values(filter.matches)].map(match => [match.index - 1, match.spans]) : [])
  const status = !filter ? '' : filter.threads > 0
    ? operationLabel(selection.operation) + ' · ' + threadCount(filter.threads) + ' shown'
    : 'No matching threads in this range. Zoom out or deselect the operation.'
  if (timelineSelection.textContent !== status) timelineSelection.textContent = status
  document.getElementById('timeline-panel').dataset.category = selection.category
  for (const row of rows.children) paintThreadMatch(row, row.querySelector('.rail'), Number(row.dataset.traceIndex))
  if (openTrace !== -1 && rows.children[openTrace].hidden) closeInspector()
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
  applyWindow(frame)
  document.fonts.ready.then(()=>{draw();paintWindow()})
}
