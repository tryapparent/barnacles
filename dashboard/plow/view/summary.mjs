const tiles = document.getElementById('tiles')
const operationPanel = document.getElementById('operation-panel')
const operationTiles = document.getElementById('operation-tiles')
const collapse = document.getElementById('collapse')
const utcWindow = document.getElementById('utc-window')
const timelineSelection = document.getElementById('timeline-selection')
const timelineEmpty = document.getElementById('timeline-empty')
const categories = [
  { kind: 1, name: 'Workflows or waits', style: 'workflow' },
  { kind: 2, name: 'Agent work', style: 'agent' },
  { kind: 0, name: 'Unclear', style: 'unclear' },
]
const summaryTraces = asList(evidenceRows.map((trace, index) => ({
  $: 'SummaryTrace', index: index + 1, start: trace.startUtcMs, parts: trace.evidence,
})))

let rangeCenter = .5
let settingZoom = false
let appliedScroll = 0
let selection = policy.initial_overview()
let previousWindow = ''
let matches = new Map()

const utc = time => utcDay.format(time) + ' ' + utcClock.format(time)
const durationLabel = ms => {
  const minutes = Math.round(ms / 60000)
  if (minutes === 0) return '<1m'
  if (minutes < 60) return minutes + 'm'
  return Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm'
}
const threadCount = count => count === 1 ? '1 thread' : count + ' threads'
const operationLabel = name => selection.category === 0 ? 'Unclear interval' : name

function resetRange() {
  applyZoom(1, .5)
  zoomIn.focus()
}

minimap.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  applyZoom(zoom, rangeCenter + (event.key === 'ArrowLeft' ? -.25 : .25)/zoom)
})

function paintRange() {
  const first = Math.max(0, rangeCenter - .5/zoom)
  const start = Math.round(frame.start + first * scale)
  const end = Math.round(frame.start + (first + 1/zoom) * scale)
  miniWindow.style.left = (first * 100) + '%'
  miniWindow.style.width = (100/zoom) + '%'
  minimap.setAttribute('aria-valuenow', String(Math.round(rangeCenter*100)))
  const rangeLabel = utc(start) + ' – ' + utc(end) + ' UTC'
  minimap.setAttribute('aria-valuetext', rangeLabel)
  if (utcWindow.textContent !== rangeLabel) utcWindow.textContent = rangeLabel
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
  viewport.scrollTop = 0
  previousWindow = ''
  paintRange()
  const next = operationButton(name) ?? operationTiles.firstElementChild ?? collapse
  next.focus({ preventScroll:true })
}

collapse.addEventListener('click', () => selectCategory(categories.find(category => category.kind === selection.category)))
operationPanel.addEventListener('keydown', event => {
  if (event.key === 'Escape' && selection.operation) {
    event.preventDefault()
    selectOperation(selection.operation)
  }
})

function renderSummary(windowStart, windowEnd) {
  const focused = document.activeElement
  const result = policy.time_summary(summaryTraces, windowStart, windowEnd)
  const groups = new Map([...values(result.categories)].map(group => [group.kind, group]))
  const activeCategory = categories.find(category => category.kind === selection.category)
  const group = groups.get(selection.category)
  document.getElementById('summary-total').textContent = result.duration
    ? durationLabel(result.duration) + ' across ' + threadCount(result.threads)
    : ''
  document.getElementById('summary-note').textContent = result.duration
    ? 'Time is summed across threads in the visible UTC range.'
    : 'No recorded time in this range. Try zooming out.'
  tiles.replaceChildren(...categories.map(category => makeCategoryTile(category, groups.get(category.kind), result.duration)))

  operationPanel.hidden = !activeCategory
  const operations = group ? [...values(group.operations)] : []
  document.getElementById('operation-empty').hidden = operations.length > 0
  if (activeCategory) {
    document.getElementById('operation-heading').textContent = activeCategory.name + ' breakdown'
  }
  operationTiles.replaceChildren(...operations.map(operation => makeOperationTile(operation, group.duration)))
  if (selection.operation && !operationButton(selection.operation)) {
    const clear = makeElement('button', 'operation-tile', 'Clear ' + operationLabel(selection.operation))
    clear.type = 'button'
    clear.dataset.operation = selection.operation
    clear.addEventListener('click', () => selectOperation(selection.operation))
    operationTiles.append(clear)
  }

  if (focused.dataset.kind !== undefined) categoryButton(focused.dataset.kind)?.focus({ preventScroll:true })
  if (focused.dataset.operation !== undefined) {
    const next = operationButton(focused.dataset.operation) ?? operationTiles.firstElementChild ?? collapse
    if (!operationPanel.hidden) next.focus({ preventScroll:true })
  }
}

function makeCategoryTile(category, group, total) {
  const button = makeElement('button', 'category-tile ' + category.style)
  button.type = 'button'
  button.dataset.kind = category.kind
  const expanded = category.kind === selection.category
  button.setAttribute('aria-expanded', String(expanded))
  button.setAttribute('aria-controls', 'operation-panel')
  const metric = makeElement('span', 'category-metric', group ? durationLabel(group.duration) : '0m')
  const share = group ? Math.round(100 * group.duration / total) : 0
  metric.append(makeElement('span', 'category-share', share + '%'))
  const icon = makeElement('span', 'category-icon', expanded ? '−' : '+')
  icon.setAttribute('aria-hidden', 'true')
  button.append(makeElement('span', 'category-name', category.name), metric, icon)
  button.addEventListener('click', () => selectCategory(category))
  return button
}

function makeOperationTile(operation, total) {
  const button = makeElement('button', 'operation-tile')
  button.type = 'button'
  button.dataset.operation = operation.name
  button.setAttribute('aria-pressed', String(operation.name === selection.operation))
  const name = operationLabel(operation.name)
  const label = makeElement('span', 'operation-name', name)
  const check = makeElement('span', 'selected-indicator', '✓')
  check.setAttribute('aria-hidden', 'true')
  label.append(check)
  button.append(label, makeElement('span', 'operation-metric',
    durationLabel(operation.duration) + ' · ' + Math.round(100 * operation.duration / total) + '%'))
  button.addEventListener('click', () => selectOperation(operation.name))
  return button
}

function paintFilter(start, end) {
  const filter = selection.operation
    ? policy.timeline_filter(summaryTraces, start, end, selection.category, selection.operation)
    : null
  matches = new Map(filter ? [...values(filter.matches)].map(match => [match.index - 1, match.spans]) : [])
  const status = filter ? operationLabel(selection.operation) + ' · ' + threadCount(filter.threads) + ' shown' : ''
  if (timelineSelection.textContent !== status) timelineSelection.textContent = status
  timelineEmpty.hidden = !filter || filter.threads > 0
  document.getElementById('timeline-panel').dataset.category = selection.category
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
    mark.style.left = percent(span.start - frame.start, scale)
    mark.style.width = percent(span.end - span.start, scale)
    rail.append(mark)
  }
}

applyZoom(1,.5)
document.fonts.ready.then(()=>{draw();paintWindow()})
