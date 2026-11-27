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
const t3Environment = '00000000-0000-4000-8000-000000000001'
const t3Delegate = 'subagent:codex:' + 'a'.repeat(64)
const t3Path = t3Environment + '/' + encodeURIComponent(t3Delegate)
const demo = [
  {startUtcMs: 1795726800000, work: [[12960, 16920, "Release verification"]], wait: [[0, 12960, "Publish artifacts"]], end: 16920},
  {startUtcMs: 1795719600000, work: [[0, 5040, "Code changes"]], wait: [[5040, 18360, "CI checks"]], end: 20700},
  {startUtcMs: 1795712400000, work: [[0, 3240, "Code changes"], [13680, 16920, "Local testing"]], wait: [[3240, 13680, "CI checks"]], end: 16920},
  {startUtcMs: 1795705200000, work: [], wait: [[0, 12240, "CI checks"]], end: 16200},
  {startUtcMs: 1795698000000, work: [[0, 8640, "Code changes"]], wait: [[8640, 15480, "CI checks"]], end: 15480},
  {startUtcMs: 1795694400000, work: [], wait: [[5940, 17280, "Publish artifacts"]], end: 17280, t3Path},
  {startUtcMs: 1795687200000, work: [[0, 2880, "Code changes"]], wait: [[2880, 7380, "CI checks"]], end: 7380},
  {startUtcMs: 1795680000000, work: [[10440, 13320, "Local testing"]], wait: [[0, 10440, "CI checks"]], end: 13320},
  {startUtcMs: 1795676400000, work: [[0, 5400, "Local testing"]], wait: [[5400, 14760, "CI checks"]], end: 14760},
  {startUtcMs: 1795608000000, work: [[0, 4680, "Code changes"]], wait: [[4680, 14760, "CI checks"]], end: 17280},
]
const fixtureTimes = Array.from({ length: 30 }, (_, i) => ({
  work: i === 0 ? 10 : i >= 20 ? 40 : 0,
  workflow: i === 1 ? 10000 : i >= 20 ? 60 : 0,
}))
const feed = { observed: 1795730400000, traces: demo.map(trace => ({ ...trace, errors: [] })),
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
const deniedBody = await denied.text()
ok(!deniedBody.includes(history) && !deniedBody.includes(t3Path))
const invalid = await worker.fetch(request, { ...env, PLOW_SESSION_HISTORY_URL: 'https://preview.tail-fixture.ts.net/shipping' }, context)
match(await invalid.text(), /data-session-history=""/)
const head = await worker.fetch(new Request(app, { method: 'HEAD' }), linked, context)
equal(head.status, 200)
equal(await head.text(), '')


const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const width of [320, 390, 640, 728, 1120, 1440, 1920]) {
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
    const board = await page.locator('.board').boundingBox()
    equal(board.x, 0)
    equal(board.width, width)
    const header = page.locator('.activity-header')
    equal((await header.boundingBox()).width, width)
    equal(await header.getByRole('heading', { level: 1 }).innerText(), 'Thread activity')
    equal(await header.getByText('plow', { exact: true }).isVisible(), true)
    match(await header.locator('#feed-cutoff').innerText(), /Observed through .* UTC/)
    await header.locator('img').evaluate(image => image.decode())
    const screenshot = async name => {
      if (process.env.PLOW_SCREENSHOTS) await page.screenshot({ path: resolve(directory, `${width}-${name}.png`), fullPage: true })
    }
    const link = page.getByRole('link', { name: 'Session history' })
    equal(await link.getAttribute('href'), history)
    ok(await link.isVisible())
    await page.keyboard.press('Tab')
    equal(await link.evaluate(element => element.matches(':focus-visible')), true)
    const summary = page.locator('#summary-panel')
    const timeline = page.locator('#timeline-panel')
    const range = page.locator('#utc-window')
    const fit = page.getByRole('button', { name: 'Fit all', exact: true })
    const total = page.locator('#summary-total')
    const initial = await range.innerText()
    ok((await summary.boundingBox()).y < (await timeline.boundingBox()).y)
    const workflow = summary.getByRole('button', { name: /Admission wait/ })
    equal(await workflow.getAttribute('data-slot'), 'button')
    const publish = summary.getByRole('button', { name: /Publish artifacts/ })
    const ci = summary.getByRole('button', { name: /CI checks/ })
    const titles = () => timeline.locator('.trace:visible .sample-title').allTextContents()
    const matchingThreads = ['Thread 1', 'Thread 6']
    const geometry = () => page.evaluate(() => {
      const bounds = element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return [x + scrollX, y + scrollY, width, height]
      }
      const selectors = ['.activity-header', '#summary-panel', '.summary-top', '#summary-total',
        '#summary-note', '#tiles', '#operation-panel', '#timeline-panel', '.timeline-heading-row',
        '#timeline-selection', '.time-strip', '.zoom-tools', '#zoom-out', '#zoom-in', '#zoom-fit',
        '#zoom-mode', '.navigator', '#minimap', '.time-caption', '#utc-window', '.chart-key',
        '#timeline-viewport', '.inspector-slot', '.reading-help']
      return {
        page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        regions: Object.fromEntries(selectors.map(selector => [selector, bounds(document.querySelector(selector))])),
        categories: [...document.querySelectorAll('.category-tile')].map(bounds),
      }
    })
    const rowSlots = () => page.locator('.trace:visible').evaluateAll(rows =>
      rows.map(row => [row.offsetTop, row.offsetHeight]))
    const originalSlots = await rowSlots()
    const assertPacked = async count => deepEqual(await rowSlots(), originalSlots.slice(0, count))
    const overview = await geometry()
    const assertStable = async state => deepEqual(await geometry(), overview, `${width}px · ${state}`)
    equal(await summary.locator('.category-tile').count(), 3)
    ok(await summary.locator('.category-tile').evaluateAll(tiles => tiles.every(tile => {
      const bounds = tile.getBoundingClientRect()
      const share = tile.querySelector('.category-share').getBoundingClientRect()
      return share.bottom <= bounds.bottom && share.right <= bounds.right
    })))
    equal((await titles()).length, 10)
    match(await total.innerText(), /43h 24m across 10 threads/)
    ok(await timeline.getByRole('button', { name: 'Zoom in' }).isVisible())
    equal(await fit.isDisabled(), true)
    const trend = page.getByRole('region', { name: 'Agent work share' })
    equal(await trend.locator('svg').getByText('Threads 11–20').isVisible(), true)
    const batchData = trend.getByRole('button', { name: 'Batch data' })
    equal(await batchData.getAttribute('data-slot'), 'collapsible-trigger')
    equal(await batchData.getAttribute('data-variant'), 'outline')
    await batchData.focus()
    await page.keyboard.press('Enter')
    equal(await batchData.getAttribute('aria-expanded'), 'true')
    await assertStable('open batch data')
    equal(await batchData.evaluate(element => element.matches(':focus-visible')), true)
    const batchRows = trend.getByRole('row')
    match(await batchRows.nth(1).innerText(), /50\.0%\s+2 of 10/)
    match(await batchRows.nth(2).innerText(), /Unknown\s+0 of 10/)
    await page.keyboard.press('Space')
    equal(await batchData.getAttribute('aria-expanded'), 'false')
    await screenshot('overview')

    await workflow.focus()
    await page.keyboard.press('Enter')
    equal(await workflow.getAttribute('aria-expanded'), 'true')
    equal((await titles()).length, 10)
    equal(await workflow.evaluate(element => element === document.activeElement), true)
    await assertStable('open operation breakdown')
    await screenshot('category')

    await publish.focus()
    await page.keyboard.press('Space')
    equal(await publish.getAttribute('aria-pressed'), 'true')
    equal(await publish.evaluate(element => element.matches(':focus-visible')), true)
    deepEqual(await titles(), matchingThreads)
    equal(await timeline.locator('.match-span:visible').count(), 2)
    match(await page.locator('#timeline-selection').innerText(), /Publish artifacts · 2 threads shown/)
    equal(await range.innerText(), initial)
    await assertPacked(2)
    await assertStable('filter to Publish artifacts')
    await screenshot('filtered')

    await ci.click()
    equal((await titles()).length, 8)
    equal(await timeline.locator('.match-span:visible').count(), 8)
    await assertPacked(8)
    await assertStable('switch filter to CI checks')
    await page.keyboard.press('Escape')
    equal((await titles()).length, 10)
    await assertPacked(10)
    await assertStable('clear filter with Escape')
    const scrollport = timeline.getByRole('region', { name: 'Scrollable UTC timelines' })
    await scrollport.focus()
    await page.keyboard.press('End')
    await page.waitForFunction(() => document.getElementById('timeline-viewport').scrollTop > 0)
    await assertStable('scroll inside the timeline')
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
    await brush(.01, .12)
    equal((await titles()).length, 0)
    await assertPacked(0)
    match(await timeline.innerText(), /No matching threads in this range/)
    match(await page.locator('#zoom-mode').innerText(), /Details/)
    await assertStable('empty filtered range')
    await screenshot('empty')
    await page.getByRole('slider').focus()
    await page.keyboard.press('ArrowRight')
    await assertStable('pan with keyboard')

    await fit.click()
    equal(await range.innerText(), initial)
    deepEqual(await titles(), matchingThreads)
    await summary.getByRole('button', { name: 'Close breakdown' }).click()
    equal(await workflow.getAttribute('aria-expanded'), 'false')
    equal(await workflow.evaluate(element => element === document.activeElement), true)
    equal((await titles()).length, 10)
    await assertPacked(10)
    await assertStable('reset zoom and close operation breakdown')
    await screenshot('recovered')

    await summary.getByRole('button', { name: /^Provider run/ }).click()
    const operationButtons = summary.getByRole('group', { name: 'Operations' }).getByRole('button')
    ok(await operationButtons.count() > 2)
    await operationButtons.last().focus()
    if (width === 320) {
      ok(await summary.locator('#operation-panel').evaluate(element => element.scrollTop > 0))
    }
    await assertStable('focus the last operation in the breakdown')
    await summary.getByRole('button', { name: /^Local testing/ }).click()
    deepEqual(await titles(), ['Thread 3', 'Thread 8', 'Thread 9'])
    await assertPacked(3)
    await assertStable('filter to Local testing')
    await screenshot('local-testing')

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
    const t3Action = inspector.getByRole('link', { name: 'Open in T3' })
    equal(await t3Action.getAttribute('href'), 'https://app.t3.codes/threads/' + t3Path)
    equal(await t3Action.getAttribute('rel'), 'noreferrer')
    await page.keyboard.press('Tab')
    equal(await t3Action.evaluate(element => element === document.activeElement), true)
    await assertStable('open thread inspector')
    await screenshot('details')
    await t3Action.press('Escape')
    equal(await inspect.getAttribute('aria-expanded'), 'false')
    equal(await inspect.evaluate(element => element === document.activeElement), true)
    await assertStable('close thread inspector with Escape')
    await page.keyboard.press('Enter')
    equal(await inspector.isVisible(), true)
    await brush(.01, .12)
    equal(await inspector.isVisible(), false)
    await assertStable('filter excludes inspected thread')

    const help = page.locator('.reading-help summary')
    const instructions = page.getByRole('region', { name: 'Chart instructions' })
    await help.focus()
    await page.keyboard.press('Enter')
    equal(await instructions.isVisible(), true)
    if (width === 320) {
      await instructions.focus()
      await page.keyboard.press('End')
      await page.waitForFunction(() => document.querySelector('.help-copy').scrollTop > 0)
      await help.focus()
    }
    await assertStable('open chart help')
    await screenshot('help')
    await page.keyboard.press('Enter')
    equal(await instructions.count(), 0)
    await assertStable('close chart help')
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    storedFeed = JSON.stringify({ observed: 0, traces: [] })
    await page.reload()
    await page.getByText('No measured session time has been imported yet.').waitFor()
    equal(await timeline.isVisible(), false)
    await screenshot('no-evidence')
    storedFeed = null
    equal((await page.reload()).status(), 503)
    await page.getByText('Session data is temporarily unavailable.', { exact: false }).waitFor()
    equal(await timeline.isVisible(), false)
    await screenshot('unavailable')
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

console.log('Plow Worker access guard, timeline filtering, and stable layout passed at 320, 390, 640, 728, 1120, 1440 and 1920 pixels.')
