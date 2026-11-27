import { deepEqual, equal, match, notEqual, ok } from 'node:assert/strict'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateKeyPair, jwtVerify, SignJWT } from 'jose'
import { chromium } from 'playwright'

const directory = process.argv[2]
const { accessVerifier, createDashboardServer } = await import(pathToFileURL(resolve(directory, 'worker.mjs')).href)
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
const traces = demo.map((trace, index) => ({ ...trace, errors: index ? [] : [600, 601] }))
traces[0].detail = [[13000, 14200, 'Model sampling']]
traces[0].ci = [[2000, 2100, 'CI watcher observation']]
const to = 1795744800000
const feed = { observed: 1795730400000, traces, overview: { from: to - 604800000, to, traces } }
let storedFeed = JSON.stringify(feed)
let reads = 0
const issuer = 'https://fixture.cloudflareaccess.com'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const sign = (aud, iss = issuer, exp = '5m') => new SignJWT({})
  .setProtectedHeader({ alg: 'RS256' }).setAudience(aud).setIssuer(iss).setExpirationTime(exp).sign(privateKey)
const token = await sign(audience)
const origin = createDashboardServer({
  getFeed: async () => {
    reads++
    return storedFeed
  },
  verifyToken: accessVerifier(jwtVerify, publicKey, issuer, audience),
  revision: 'a'.repeat(40),
})
origin.listen(0, '127.0.0.1')
await once(origin, 'listening')
const base = `http://127.0.0.1:${origin.address().port}`
const app = base + '/app'
let browser
const request = (assertion, path = '/app', method = 'GET') => fetch(base + path, {
  method,
  headers: assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {},
})
try {
  equal((await request()).status, 403)
  equal((await request('invalid')).status, 403)
  equal((await request(await sign('another-app'))).status, 403)
  equal((await request(await sign(audience, 'https://other.cloudflareaccess.com'))).status, 403)
  equal((await request(await sign(audience, issuer, '-1m'))).status, 403)
  equal((await request(token, '/app/other')).status, 404)
  equal((await request(token, '/app', 'POST')).status, 405)
  equal(reads, 0)
  equal((await fetch(base + '/_health')).status, 204)
  const allowed = await request(token)
  equal(allowed.status, 200)
  equal(allowed.headers.get('Cache-Control'), 'private, no-store')
  equal(allowed.headers.get('X-Plow-Revision'), 'a'.repeat(40))
  match(await allowed.text(), /1795730400000/)
  equal(await (await request(token, '/app/', 'HEAD')).text(), '')
  browser = await chromium.launch({ channel: 'chrome' })
  for (const width of [1024, 1120, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('503')) errors.push(message.text())
    })
    await page.route(app, route => route.continue({
      headers: { ...route.request().headers(), 'Cf-Access-Jwt-Assertion': token },
    }))
    await page.goto(app)
    await page.evaluate(() => document.fonts.ready)
    await page.locator('.field-ready').waitFor()
    match(await page.locator('#feed-cutoff').textContent(), /Observed through .* UTC/)
    const screenshot = async name => {
      if (process.env.PLOW_SCREENSHOTS) await page.screenshot({ path: resolve(directory, `${width}-${name}.png`), fullPage: true, animations: 'disabled' })
    }
    const day = page.getByRole('button', { name: 'Last 24 hours' })
    const week = page.getByRole('button', { name: 'Last 7 days' })
    equal(await day.getAttribute('aria-pressed'), 'true')
    await screenshot('overview')
    const summary = page.locator('#summary-panel')
    const timeline = page.locator('#timeline-panel')
    const minimap = page.locator('#minimap')
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const range = async () => { await settle(); return minimap.getAttribute('aria-valuetext') }
    const reset = async () => { await minimap.press('Home'); await settle() }
    const initial = await range()
    const workflow = summary.locator('#tiles .workflow')
    const publish = summary.getByRole('button', { name: /Publish artifacts/ })
    const ci = summary.getByRole('button', { name: /CI checks/ })
    const titles = () => timeline.locator('.trace:visible .sample-title').allTextContents()
    const matchingThreads = ['Thread 1', 'Thread 6']
    const geometry = () => page.evaluate(() => {
      const bounds = selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect()
        return [x + scrollX, y + scrollY, width, height]
      }
      const selectors = ['.activity-header', '#summary-panel', '.summary-top', '#tiles', '#timeline-panel',
        '.timeline-heading-row', '.time-strip', '.navigator', '#minimap', '#timeline-viewport', '.inspector-slot']
      return {
        page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        regions: selectors.map(bounds),
      }
    })
    const rowSlots = () => page.locator('.trace:visible').evaluateAll(rows =>
      rows.map(row => [row.offsetTop, row.offsetHeight]))
    const slots = await rowSlots()
    const assertPacked = async count => deepEqual(await rowSlots(), slots.slice(0, count))
    const overview = await geometry()
    const assertStable = async state => deepEqual(await geometry(), overview, state)
    const total = () => page.locator('#summary-total').innerText()
    const initialTotal = await total()
    match(initialTotal, /across 9 threads/)
    const rangeStart = timeline.getByRole('slider', { name: 'Visible range start' })
    const rangeEnd = timeline.getByRole('slider', { name: 'Visible range end' })
    const dragHandle = async (handle, dx) => {
      await handle.scrollIntoViewIfNeeded()
      const box = await handle.locator('..').boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 4 })
      await page.mouse.up()
      await settle()
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
    const trend = page.getByRole('region', { name: 'Agent work share' })
    const trendLabel = () => trend.getByRole('img').getAttribute('aria-label')
    const initialTrend = await trendLabel()
    match(initialTrend, /UTC: [\d.]+%/)
    const view = page.locator('#timeline-viewport')
    const window = async () => { await settle(); return view.evaluate(el => [+el.dataset.start, +el.dataset.end]) }
    const fit = timeline.getByRole('button', { name: /^Fit Thread 1\./ })
    deepEqual(await window(), [to - 86400000, to])
    await week.press('Space')
    deepEqual(await window(), [to - 604800000, to])
    equal(await week.getAttribute('aria-pressed'), 'true')
    equal((await titles()).length, 10)
    match(await total(), /across 10 threads/)
    equal((await trendLabel()).split(' UTC: ').length - 1, 7)
    await screenshot('week')
    await day.press('Enter')
    deepEqual(await window(), [to - 86400000, to])
    equal(await total(), initialTotal)
    equal(await trendLabel(), initialTrend)
    await fit.press('Space')
    deepEqual(await window(), [demo[0].startUtcMs, demo[0].startUtcMs + demo[0].end * 1000])
    equal(await fit.evaluate(el => el === document.activeElement), true)
    const tick = await timeline.locator('.marker').first().boundingBox()
    await page.mouse.move(tick.x + tick.width / 2, tick.y + tick.height / 2)
    const tooltip = page.getByRole('tooltip')
    match(await tooltip.innerText(), /2 recorded failures\s+21:10:00 UTC\s+21:10:01 UTC/)
    await timeline.getByRole('button', { name: 'Inspect Thread 1', exact: true }).press('Enter')
    const detail = page.getByRole('region', { name: 'Thread 1 · Recorded timeline' })
    match(await detail.innerText(), /Model sampling/)
    match(await detail.innerText(), /CI watcher observation/)
    await detail.press('Escape')
    await settle()
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

    equal(await total(), initialTotal)
    equal(await trendLabel(), initialTrend)

    await workflow.focus()
    await page.keyboard.press('Enter')
    equal(await summary.getByRole('heading').textContent(), 'Admission wait')
    equal((await titles()).length, 9)
    await assertStable('open operation breakdown')
    await screenshot('breakdown')

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
    equal((await titles()).length, 7)
    equal(await timeline.locator('.match-span:visible').count(), 7)
    await assertPacked(7)
    await page.keyboard.press('Escape')
    equal((await titles()).length, 9)
    await assertPacked(9)
    await assertStable('clear filter with Escape')
    ok(await view.evaluate(el => el.scrollHeight <= el.clientHeight))
    await publish.click()

    const brush = async (from, to) => {
      await page.locator('#minimap').scrollIntoViewIfNeeded()
      const minimap = await page.locator('#minimap').boundingBox()
      const move = position => page.mouse.move(minimap.x + minimap.width * position, minimap.y + 12)
      await move(from)
      await page.mouse.down()
      await move(to)
      await page.mouse.up()
      await settle()
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
    equal((await titles()).length, 9)
    await assertPacked(9)
    await assertStable('reset zoom and close operation breakdown')

    await summary.getByRole('button', { name: /^Provider run/ }).click()
    const testing = summary.getByRole('button', { name: /^Local testing/ })
    await testing.click()
    deepEqual(await titles(), ['Thread 3', 'Thread 8', 'Thread 9'])
    await assertPacked(3)

    await summary.getByRole('button', { name: 'Close breakdown' }).click()
    await workflow.click()
    await publish.click()
    await brush(.43, .50)
    deepEqual(await titles(), ['Thread 6'])
    const inspect = timeline.getByRole('button', { name: /^Inspect Thread 6/ })
    await inspect.click()
    equal(await inspect.getAttribute('aria-expanded'), 'true')
    const inspector = timeline.getByRole('region', { name: /Thread 6 · Recorded timeline/ })
    match(await inspector.innerText(), /Publish artifacts/)
    equal(await inspector.evaluate(element => element === document.activeElement), true)
    await assertStable('open thread inspector')
    await screenshot('inspector')
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
    await screenshot('help')
    await page.keyboard.press('Escape')
    equal(await instructions.isVisible(), false)
    storedFeed = JSON.stringify({ observed: 0, traces: [] })
    await page.reload()
    await page.getByText('No measured session time in this range.').waitFor()
    equal(await timeline.isVisible(), false)
    storedFeed = null
    equal((await page.reload()).status(), 503)
    await page.getByText('Session data is temporarily unavailable.', { exact: false }).waitFor()
    equal(await timeline.isVisible(), false)
    storedFeed = JSON.stringify(feed)
    await page.reload()
    await timeline.waitFor()
    deepEqual(errors, [])
    await page.close()
  }
} finally {
  origin.close()
  await browser?.close()
}

console.log('Plow origin and Chromium smoke checks passed.')
