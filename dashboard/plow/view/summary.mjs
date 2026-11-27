const summaryHeading = document.getElementById('summary-heading')
const timelineSelection = document.getElementById('timeline-selection')
const allCategories = document.getElementById('all-categories')
const utcWindow = document.getElementById('utc-window')
const tiles = document.getElementById('tiles')
const occurrences = document.getElementById('occurrences')
const spanList = document.getElementById('span-list')
const categories = [
  { kind: 1, name: 'Admission wait', style: 'workflow' },
  { kind: 2, name: 'Provider run', style: 'agent' },
  { kind: 0, name: 'Unobserved', style: 'unclear' },
]
let rangeCenter = .5
let settingZoom = false
let appliedScroll = 0
let activeCategory = null
let activeOperation = null
let selectedSpan = null
let previousWindow = ''

const shareLabel = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 })
const utc = time => utcDay.format(time) + ' ' + utcClock.format(time)
const durationLabel = ms => {
  const minutes = Math.round(ms / 60000)
  if (minutes === 0) return '<1m'
  if (minutes < 60) return minutes + 'm'
  return Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm'
}
const summaryTraces = asList(evidenceRows.map((trace, index) => ({
  $: 'SummaryTrace', index: index + 1, start: trace.startUtcMs, parts: trace.evidence,
})))

function resetRange() {
  selectedSpan = null
  timelineSelection.hidden = true
  applyZoom(1, .5)
  zoomIn.focus()
}

allCategories.addEventListener('click', () => {
  const categoryToFocus = activeCategory
  activeCategory = activeOperation = null
  previousWindow = ''
  paintRange()
  tiles.querySelector('[data-kind="' + categoryToFocus + '"]')?.focus()
})

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
}

function renderSummary(windowStart, windowEnd) {
  const result = policy.time_summary(summaryTraces, windowStart, windowEnd)
  const groups = [...values(result.categories)].map(category => ({
    ...category, ...categories.find(item => item.kind === category.kind),
  }))
  const group = groups.find(category => category.kind === activeCategory)
  const total = activeCategory === null ? result.duration : group?.duration ?? 0
  const threadCount = activeCategory === null ? result.threads : group?.threads ?? 0
  const count = threadCount === 1 ? '1 thread' : threadCount + ' threads'
  summaryHeading.textContent = activeCategory === null ? 'Where time went' : categories.find(category => category.kind === activeCategory).name
  allCategories.hidden = activeCategory === null
  document.getElementById('summary-total').textContent = total ? durationLabel(total) + ' across ' + count : ''
  document.getElementById('summary-note').textContent = !total
    ? 'No matching time in this range. Zoom out or pick another range.'
    : group
      ? 'Choose a category to see its spans. Each span links to the timeline.'
      : 'Time is summed across threads and clipped to the visible UTC range.'
  tiles.replaceChildren()
  tiles.className = 'treemap'
  occurrences.hidden = !group
  if (!total) return
  if (!group) {
    if (groups.length === 3) {
      if (groups[0].duration / total <= .75 && groups[2].duration / (total - groups[0].duration) >= .24) packThree(groups)
      else tiles.classList.add('ranked')
    }
    else if (groups.length === 2) {
      tiles.classList.add('pair')
      tiles.style.setProperty('--first', ratio(groups[0].duration,total))
    }
    for (const category of groups) {
      const tile = makeTile(category, total, false)
      tile.dataset.kind = category.kind
      tile.addEventListener('click', () => {
        activeCategory = category.kind
        previousWindow = ''
        paintRange()
        summaryHeading.focus()
      })
      tiles.append(tile)
    }
    return
  }
  const operations = [...values(group.operations)].map(operation => ({
    ...operation, name: group.kind === 0 ? 'Unobserved interval' : operation.name, style: group.style,
  }))
  if (!operations.some(operation => operation.name === activeOperation)) activeOperation = operations[0].name
  if (operations.length > 1) tiles.classList.add('operations')
  if (operations.length === 2) {
    tiles.classList.add('pair')
    tiles.style.setProperty('--first', ratio(operations[0].duration,total))
  }
  for (const operation of operations) {
    const tile = makeTile(operation, total, true)
    tile.setAttribute('aria-pressed', String(operation.name === activeOperation))
    tile.addEventListener('click', () => {
      activeOperation = operation.name
      for (const button of tiles.children) button.setAttribute('aria-pressed', String(button === tile))
      renderSpans(operation)
    })
    tiles.append(tile)
  }
  renderSpans(operations.find(operation => operation.name === activeOperation))
}

function ratio(part, total) {
  return (100 * part / total) + '%'
}

function packThree(groups) {
  tiles.classList.add('split')
  const [largest, middle, smallest] = groups
  tiles.style.setProperty('--first', ratio(largest.duration, largest.duration + middle.duration + smallest.duration))
  tiles.style.setProperty('--second', ratio(middle.duration, middle.duration + smallest.duration))
}

function makeTile(group, total, subcategory) {
  const button = makeElement('button', 'tile ' + group.style + (subcategory ? ' subcategory' : ''))
  button.type = 'button'
  const name = makeElement('span', 'tile-name', group.name)
  const duration = makeElement('span', 'tile-duration', durationLabel(group.duration))
  duration.append(makeElement('span', 'tile-share', shareLabel.format(group.duration / total)))
  const icon = makeElement('span', 'tile-icon', subcategory ? '' : '↗')
  icon.setAttribute('aria-hidden', 'true')
  button.append(name, duration, icon)
  return button
}

function renderSpans(operation) {
  const spans = [...values(operation.spans)]
  document.getElementById('occurrence-heading').textContent = operation.name + ' · ' + spans.length + (spans.length === 1 ? ' span' : ' spans')
  spanList.replaceChildren(...spans.map(source => {
    const index = source.index - 1
    const span = { ...source, index, title: evidenceRows[index].shortTitle, name: operation.name }
    const item = makeElement('button', 'span-link')
    item.type = 'button'
    item.append(makeElement('span', '', span.title),
      makeElement('small', '', utc(span.start) + ' UTC · ' + durationLabel(span.duration)),
      makeElement('span', 'jump', 'Timeline ↗'))
    item.addEventListener('click', () => jumpToSpan(span))
    return item
  }))
}

function jumpToSpan(span) {
  selectedSpan = span
  timelineSelection.textContent = span.name + ' · ' + span.title + ' · ' + durationLabel(span.duration)
  timelineSelection.hidden = false
  timelineSelection.tabIndex = -1
  const visibleSize = bounds(span.duration * 1.35, 30 * 60000, 6 * 3600000)
  zoom = bounds(scale / visibleSize, 1, maximumZoom)
  rangeCenter = ((span.start + span.end)/2 - frame.start)/scale
  applyZoom(zoom,rangeCenter)
  const row = rows.querySelector('.selected-trace')
  viewport.scrollTop = Math.max(0, row.offsetTop - Math.floor(viewport.clientHeight / 3))
  timelineSelection.focus({preventScroll:true})
  document.getElementById('timeline-heading').scrollIntoView({block:'start'})
}


if (traces.length > 0) {
  applyZoom(1,.5)
  document.fonts.ready.then(()=>{draw();paintWindow()})
}
