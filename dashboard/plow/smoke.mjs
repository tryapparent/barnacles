import { deepEqual, equal, match, notEqual, ok } from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the Plow build output directory.')
const { default: worker } = await import(pathToFileURL(resolve(directory, 'worker.mjs')).href)
const app = 'https://plow.tryapparent.com/app'
const audience = 'fixture-audience'
const demo = [
  {startUtcMs: 1795726800000, work: [[12960, 16920, "Release verification"]], wait: [[0, 12960, "Publish artifacts"]], end: 16920},
  {startUtcMs: 1795719600000, work: [[0, 5040, "Code changes"]], wait: [[5040, 18360, "CI checks"]], end: 20700},
  {startUtcMs: 1795712400000, work: [[0, 3240, "Code changes"], [13680, 16920, "Local testing"]], wait: [[3240, 13680, "CI checks"]], end: 16920},
  {startUtcMs: 1795705200000, work: [], wait: [[0, 12240, "CI checks"]], end: 16200},
  {startUtcMs: 1795698000000, work: [[0, 8640, "Code changes"]], wait: [[8640, 15480, "CI checks"]], end: 15480},
  {startUtcMs: 1795694400000, work: [], wait: [[5940, 17280, "Publish artifacts"]], end: 17280},
  {startUtcMs: 1795687200000, work: [[0, 2880, "Code changes"]], wait: [[2880, 7380, "CI checks"]], end: 7380},
  {startUtcMs: 1795680000000, work: [[10440, 13320, "Local testing"]], wait: [[0, 10440, "CI checks"]], end: 13320},
  {startUtcMs: 1795676400000, work: [[0, 5400, "Local testing"]], wait: [[5400, 14760, "CI checks"]], end: 14760},
  {startUtcMs: 1795608000000, work: [[0, 4680, "Code changes"]], wait: [[4680, 14760, "CI checks"]], end: 17280},
]
const fixtureTimes = Array.from({ length: 30 }, (_, i) => ({
  work: i === 0 ? 10 : i >= 20 ? 40 : 0,
  workflow: i === 1 ? 10000 : i >= 20 ? 60 : 0,
}))
const feed = { observed: 1795730400000, traces: demo.map((trace, index) => ({ ...trace, errors: index ? [] : [600, 601] })),
  history: { first: 11, threads: fixtureTimes } }
let storedFeed = JSON.stringify(feed)
let reads = 0
const env = { PLOW_ACCESS_AUDIENCE: audience, PLOW_SESSION_FEED: { get: async key => {
  equal(key, 'session-timeline-v1')
  reads++
  return storedFeed
} } }
const history = 'https://preview.tail-fixture.ts.net:19531/sessions'
const linked = { ...env, PLOW_SESSION_HISTORY_URL: history }
const context = { access: { aud: audience } }
const request = new Request(app)
equal((await worker.fetch(request, env, {})).status, 403)
equal((await worker.fetch(request, {}, context)).status, 403)
equal((await worker.fetch(request, env, { access: { aud: 'another-app' } })).status, 403)
equal((await worker.fetch(new Request('https://preview.workers.dev/app'), env, context)).status, 404)
equal((await worker.fetch(new Request(app, { method: 'POST' }), env, context)).status, 405)
equal(reads, 0)
const allowed = await worker.fetch(request, env, context)
equal(allowed.status, 200)
equal(allowed.headers.get('Cache-Control'), 'private, no-store')
notEqual(await allowed.text(), await readFile(resolve(directory, 'index.html'), 'utf8'))

const denied = await worker.fetch(request, linked, {})
equal(denied.status, 403)
ok(!(await denied.text()).includes(history))
const invalid = await worker.fetch(request, { ...env, PLOW_SESSION_HISTORY_URL: 'https://preview.tail-fixture.ts.net/shipping' }, context)
match(await invalid.text(), /data-session-history=""/)
const head = await worker.fetch(new Request(app, { method: 'HEAD' }), linked, context)
equal(head.status, 200)
equal(await head.text(), '')


const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const width of [1024, 1120, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('503')) errors.push(message.text())
    })
    await page.route(app, async route => {
      const response = await worker.fetch(new Request(route.request().url()), linked, context)
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
    await page.goto(app)
    await page.evaluate(() => document.fonts.ready)
    const header = page.locator('.activity-header')
    equal((await header.boundingBox()).width, width)
    equal(await header.getByRole('heading', { level: 1 }).innerText(), 'Thread activity')
    match(await page.locator('#feed-cutoff').textContent(), /Observed through .* UTC/)
    await header.locator('img').evaluate(image => image.decode())
    const screenshot = async name => {
      if (process.env.PLOW_SCREENSHOTS) await page.screenshot({ path: resolve(directory, `${width}-${name}.png`), fullPage: true, animations: 'disabled' })
    }
    const link = page.getByRole('link', { name: 'Session history' })
    ok(await link.isVisible())
    await page.keyboard.press('Tab')
    equal(await link.evaluate(element => element.matches(':focus-visible')), true)
    const summary = page.locator('#summary-panel')
    const timeline = page.locator('#timeline-panel')
    const minimap = page.locator('#minimap')
    const range = () => minimap.getAttribute('aria-valuetext')
    const reset = () => minimap.press('Home')
    const total = page.locator('#summary-total')
    const initial = await range()
    const workflow = summary.locator('#tiles .workflow')
    const publish = summary.getByRole('button', { name: /Publish artifacts/ })
    const ci = summary.getByRole('button', { name: /CI checks/ })
    const titles = () => timeline.locator('.trace:visible .sample-title').allTextContents()
    const matchingThreads = ['Thread 1', 'Thread 6']
    const geometry = () => page.evaluate(() => {
      const bounds = element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return [x + scrollX, y + scrollY, width, height]
      }
      const selectors = ['.activity-header', '#summary-panel', '.summary-top', '#tiles', '#timeline-panel',
        '.timeline-heading-row', '.time-strip', '.navigator', '#minimap', '#timeline-viewport', '.inspector-slot']
      return {
        page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        regions: Object.fromEntries(selectors.map(selector => [selector, bounds(document.querySelector(selector))])),
      }
    })
    const rowSlots = () => page.locator('.trace:visible').evaluateAll(rows =>
      rows.map(row => [row.offsetTop, row.offsetHeight]))
    const originalSlots = await rowSlots()
    const assertPacked = async count => deepEqual(await rowSlots(), originalSlots.slice(0, count))
    const overview = await geometry()
    const assertStable = async state => deepEqual(await geometry(), overview, `${width}px · ${state}`)
    match(await total.innerText(), /43h 24m across 10 threads/)
    equal(await timeline.getByRole('button', { name: /Zoom in|Zoom out|Fit all/ }).count(), 0)
    const rangeStart = timeline.getByRole('slider', { name: 'Visible range start' })
    const rangeEnd = timeline.getByRole('slider', { name: 'Visible range end' })
    const dragHandle = async (handle, dx) => {
      await handle.scrollIntoViewIfNeeded()
      const box = await handle.locator('..').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 4 })
      await page.mouse.up()
    }
    const rightEdge = await rangeEnd.getAttribute('aria-valuetext')
    await dragHandle(rangeStart, 40)
    notEqual(await range(), initial)
    equal(await rangeEnd.getAttribute('aria-valuetext'), rightEdge)
    const leftEdge = await rangeStart.getAttribute('aria-valuetext')
    await dragHandle(rangeEnd, -45)
    equal(await rangeStart.getAttribute('aria-valuetext'), leftEdge)
    notEqual(await rangeEnd.getAttribute('aria-valuetext'), rightEdge)
    await rangeEnd.press('ArrowRight')
    equal(await rangeStart.getAttribute('aria-valuetext'), leftEdge)
    await reset()
    await assertStable('resize either edge and reset')
    const trend = page.getByRole('region', { name: 'Agent work share' })
    const batchData = trend.getByRole('button', { name: 'Batch data' })
    await batchData.focus()
    await page.keyboard.press('Enter')
    equal(await batchData.getAttribute('aria-expanded'), 'true')
    await assertStable('open batch data')
    const batchRows = trend.getByRole('row')
    match(await batchRows.nth(1).innerText(), /50\.0%\s+2 of 10/)
    match(await batchRows.nth(2).innerText(), /Unknown\s+0 of 10/)
    await page.keyboard.press('Space')
    equal(await batchData.getAttribute('aria-expanded'), 'false')
    const view = page.locator('#timeline-viewport')
    const window = () => view.evaluate(el => [+el.dataset.start, +el.dataset.end])
    const fit = timeline.getByRole('button', { name: /^Fit Thread 1\./ })
    await fit.press('Space')
    deepEqual(await window(), [demo[0].startUtcMs, demo[0].startUtcMs + demo[0].end * 1000])
    equal(await fit.evaluate(el => el === document.activeElement), true)
    const tick = await timeline.locator('.marker').first().boundingBox()
    await page.mouse.move(tick.x + tick.width / 2, tick.y + tick.height / 2)
    const tooltip = page.getByRole('tooltip')
    match(await tooltip.innerText(), /2 recorded failures\s+21:10:00 UTC\s+21:10:01 UTC/)
    await screenshot('failure-tooltip')
    const fitted = await window()
    await view.press('Control+ArrowUp')
    ok((await window())[1] - (await window())[0] < fitted[1] - fitted[0])
    await reset()
    const plot = await page.locator('.rail').first().boundingBox()
    await page.mouse.move(plot.x + plot.width * .2, plot.y + 20)
    await page.mouse.down()
    await page.mouse.move(plot.x + plot.width * .6, plot.y + 20, { steps: 5 })
    await page.mouse.up()
    notEqual(await range(), initial)
    await reset()

    await workflow.focus()
    await page.keyboard.press('Enter')
    equal(await summary.locator('#operation-heading').textContent(), 'Admission wait breakdown')
    equal((await titles()).length, 10)
    await assertStable('open operation breakdown')

    await publish.focus()
    await page.keyboard.press('Space')
    equal(await publish.getAttribute('aria-pressed'), 'true')
    deepEqual(await titles(), matchingThreads)
    equal(await timeline.locator('.match-span:visible').count(), 2)
    match(await page.locator('#timeline-selection').innerText(), /Publish artifacts · 2 threads shown/)
    equal(await range(), initial)
    await assertPacked(2)
    await assertStable('filter to Publish artifacts')

    await ci.click()
    equal((await titles()).length, 8)
    equal(await timeline.locator('.match-span:visible').count(), 8)
    await assertPacked(8)
    await page.keyboard.press('Escape')
    equal((await titles()).length, 10)
    await assertPacked(10)
    await assertStable('clear filter with Escape')
    const timelineRegion = timeline.getByRole('region', { name: 'UTC timelines' })
    ok(await timelineRegion.evaluate(element => element.scrollHeight <= element.clientHeight))
    equal(await timelineRegion.evaluate(element => getComputedStyle(element).overflowX), 'hidden')
    await publish.click()
    await publish.click()
    equal((await titles()).length, 10)
    await publish.click()

    const brush = async (from, to) => {
      await page.locator('#minimap').scrollIntoViewIfNeeded()
      const minimap = await page.locator('#minimap').boundingBox()
      const move = position => page.mouse.move(minimap.x + minimap.width * position, minimap.y + 12)
      await move(from)
      await page.mouse.down()
      await move(to)
      await page.mouse.up()
    }
    await brush(.065, .17)
    equal((await titles()).length, 0)
    await assertPacked(0)
    match(await timeline.innerText(), /No matching threads in this range/)
    await assertStable('empty filtered range')
    await minimap.focus()
    await page.keyboard.press('ArrowRight')

    await reset()
    equal(await range(), initial)
    deepEqual(await titles(), matchingThreads)
    await summary.getByRole('button', { name: 'Close breakdown' }).click()
    equal(await workflow.getAttribute('aria-expanded'), 'false')
    equal(await workflow.evaluate(element => element === document.activeElement), true)
    equal((await titles()).length, 10)
    await assertPacked(10)
    await assertStable('reset zoom and close operation breakdown')

    await summary.getByRole('button', { name: /^Provider run/ }).click()
    const testing = summary.getByRole('button', { name: /^Local testing/ })
    await testing.click()
    deepEqual(await titles(), ['Thread 3', 'Thread 8', 'Thread 9'])
    await assertPacked(3)
    await assertStable('filter to Local testing')

    await summary.getByRole('button', { name: 'Close breakdown' }).click()
    await workflow.click()
    await publish.click()
    await brush(.60, .72)
    deepEqual(await titles(), ['Thread 6'])
    const inspect = timeline.getByRole('button', { name: /^Inspect Thread 6/ })
    await inspect.click()
    equal(await inspect.getAttribute('aria-expanded'), 'true')
    const inspector = timeline.getByRole('region', { name: /Thread 6 · Recorded timeline/ })
    match(await inspector.innerText(), /Publish artifacts/)
    equal(await inspector.evaluate(element => element === document.activeElement), true)
    await assertStable('open thread inspector')
    await page.keyboard.press('Escape')
    equal(await inspect.getAttribute('aria-expanded'), 'false')
    equal(await inspect.evaluate(element => element === document.activeElement), true)
    await assertStable('close thread inspector with Escape')
    await page.keyboard.press('Enter')
    equal(await inspector.isVisible(), true)
    await brush(.065, .17)
    equal(await inspector.isVisible(), false)
    await assertStable('filter excludes inspected thread')

    const help = page.getByRole('button', { name: 'Timeline guide' })
    const instructions = page.locator('.timeline-guide')
    await help.focus()
    await page.keyboard.press('Enter')
    equal(await instructions.isVisible(), true)
    const guideBounds = await instructions.boundingBox()
    const helpBounds = await help.boundingBox()
    ok(Math.abs(guideBounds.x + guideBounds.width - helpBounds.x - helpBounds.width) < 2)
    ok(guideBounds.y >= helpBounds.y + helpBounds.height)
    await assertStable('open timeline guide')
    await screenshot('help')
    await page.keyboard.press('Escape')
    equal(await instructions.isVisible(), false)
    await assertStable('close timeline guide')
    storedFeed = JSON.stringify({ observed: 0, traces: [] })
    await page.reload()
    await page.getByText('No measured session time has been imported yet.').waitFor()
    equal(await timeline.isVisible(), false)
    storedFeed = null
    equal((await page.reload()).status(), 503)
    await page.getByText('Session data is temporarily unavailable.', { exact: false }).waitFor()
    equal(await timeline.isVisible(), false)
    storedFeed = JSON.stringify(feed)
    await page.reload()
    await timeline.waitFor()
    await page.route(history, route => route.fulfill({ contentType: 'text/html', body: '<h1>Plow session history</h1>' }))
    await link.press('Enter')
    await page.waitForURL(history)
    ok(await page.getByRole('heading', { name: 'Plow session history' }).isVisible())
    deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
}

console.log('Plow Worker access guard, timeline filtering, and stable layout passed at 1024, 1120, 1440 and 1920 pixels.')
