import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the Plow build output directory.')
const { default: worker } = await import(pathToFileURL(resolve(directory, 'worker.mjs')).href)
const app = 'https://plow.tryapparent.com/app'
const audience = 'fixture-audience'
const demo = [{"shortTitle": "Release packaging", "title": "Release packaging", "startUtcMs": 1795726800000, "work": [[12960, 16920, "Release verification"]], "wait": [[0, 12960, "Publish artifacts"]], "errors": [], "subtitle": "Nov 26 \u00b7 21:00 UTC \u00b7 Sample", "end": 16920}, {"shortTitle": "Webhook delivery", "title": "Webhook delivery", "startUtcMs": 1795719600000, "work": [[0, 5040, "Code changes"]], "wait": [[5040, 18360, "CI checks"]], "errors": [], "subtitle": "Nov 26 \u00b7 19:00 UTC \u00b7 Sample", "end": 20700}, {"shortTitle": "Settings cleanup", "title": "Settings cleanup", "startUtcMs": 1795712400000, "work": [[0, 3240, "Code changes"], [13680, 16920, "Local testing"]], "wait": [[3240, 13680, "CI checks"]], "errors": [], "subtitle": "Nov 26 \u00b7 17:00 UTC \u00b7 Sample", "end": 16920}, {"shortTitle": "Installer checks", "title": "Installer checks", "startUtcMs": 1795705200000, "work": [], "wait": [[0, 12240, "CI checks"]], "errors": [], "subtitle": "Nov 26 \u00b7 15:00 UTC \u00b7 Sample", "end": 16200}, {"shortTitle": "Search indexing", "title": "Search indexing", "startUtcMs": 1795698000000, "work": [[0, 8640, "Code changes"]], "wait": [[8640, 15480, "CI checks"]], "errors": [], "subtitle": "Nov 26 \u00b7 13:00 UTC \u00b7 Sample", "end": 15480}, {"shortTitle": "Export retries", "title": "Export retries", "startUtcMs": 1795694400000, "work": [], "wait": [[5940, 17280, "Publish artifacts"]], "errors": [], "subtitle": "Nov 26 \u00b7 12:00 UTC \u00b7 Sample", "end": 17280}, {"shortTitle": "Empty state copy", "title": "Empty state copy", "startUtcMs": 1795687200000, "work": [[0, 2880, "Code changes"]], "wait": [[2880, 7380, "CI checks"]], "errors": [], "subtitle": "Nov 26 \u00b7 10:00 UTC \u00b7 Sample", "end": 7380}, {"shortTitle": "Runner diagnostics", "title": "Runner diagnostics", "startUtcMs": 1795680000000, "work": [[10440, 13320, "Local testing"]], "wait": [[0, 10440, "CI checks"]], "errors": [], "subtitle": "Nov 26 \u00b7 08:00 UTC \u00b7 Sample", "end": 13320}, {"shortTitle": "Dependency update", "title": "Dependency update", "startUtcMs": 1795676400000, "work": [[0, 5400, "Local testing"]], "wait": [[5400, 14760, "CI checks"]], "errors": [], "subtitle": "Nov 26 \u00b7 07:00 UTC \u00b7 Sample", "end": 14760}, {"shortTitle": "Import validation", "title": "Import validation", "startUtcMs": 1795608000000, "work": [[0, 4680, "Code changes"]], "wait": [[4680, 14760, "CI checks"]], "errors": [], "subtitle": "Nov 25 \u00b7 12:00 UTC \u00b7 Sample", "end": 17280}]
const feed = { observed: 1795730400000, traces: demo }
let storedFeed = JSON.stringify(feed)
let reads = 0
const env = { PLOW_ACCESS_AUDIENCE: audience, PLOW_SESSION_FEED: { get: async key => {
  assert.equal(key, 'session-timeline-v1')
  reads++
  return storedFeed
} } }
const context = { access: { aud: audience } }
const request = new Request(app)
assert.equal((await worker.fetch(request, env, {})).status, 403)
assert.equal((await worker.fetch(request, {}, context)).status, 403)
assert.equal((await worker.fetch(request, env, { access: { aud: 'another-app' } })).status, 403)
assert.equal((await worker.fetch(new Request('https://preview.workers.dev/app'), env, context)).status, 404)
assert.equal((await worker.fetch(new Request(app, { method: 'POST' }), env, context)).status, 405)
assert.equal(reads, 0)
const allowed = await worker.fetch(request, env, context)
assert.equal(allowed.status, 200)
assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store')
assert.notEqual(await allowed.text(), await readFile(resolve(directory, 'index.html'), 'utf8'))

const dbPath = resolve(directory, 'projection-fixture.sqlite')
const projectedPath = resolve(directory, 'projection-fixture.json')
const db = new DatabaseSync(dbPath)
db.exec(`
  CREATE TABLE t3_threads(instance TEXT, thread_id TEXT, created_ms INTEGER, updated_ms INTEGER);
  CREATE TABLE t3_runs(instance TEXT, thread_id TEXT, run_id TEXT, requested_ms INTEGER, started_ms INTEGER,
    completed_ms INTEGER, status TEXT);
  INSERT INTO t3_threads VALUES ('t3','older',100,1200),('t3','latest',1500,3000),('t3','unknown',3200,3400);
  INSERT INTO t3_runs VALUES ('t3','older','a',110,300,900,'failed'),('t3','latest','b',2000,2400,NULL,'running'),
    ('t3','latest','c',2100,NULL,NULL,'queued'),('t3','latest','d',NULL,2300,3200,'completed'),
    ('another','latest','e',1600,1700,1800,'completed');
`)
db.close()
execFileSync(process.execPath, ['dashboard/plow/build.ts', '--project-feed', dbPath, projectedPath])
assert.deepEqual(JSON.parse(await readFile(projectedPath, 'utf8')), {
  observed: 3000,
  traces: [
    { startUtcMs: 1500, end: .9, work: [], wait: [[.5,.9,'T3 admission']], errors: [] },
    { startUtcMs: 100, end: .8, work: [[.2,.8,'Provider run']], wait: [[.01,.2,'T3 admission']], errors: [.8] },
  ],
})

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const width of [320, 390, 728, 1120, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('503')) errors.push(message.text())
    })
    await page.route(app, async route => {
      const response = await worker.fetch(new Request(route.request().url()), env, context)
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
    await page.goto(app)
    await page.evaluate(() => document.fonts.ready)
    const board = await page.locator('.board').boundingBox()
    assert.equal(board.x, 0)
    assert.equal(board.width, width)
    const header = page.locator('.activity-header')
    assert.equal((await header.boundingBox()).width, width)
    assert.equal(await header.getByRole('heading', { level: 1 }).innerText(), 'Thread activity')
    assert.equal(await header.getByText('plow', { exact: true }).isVisible(), true)
    assert.match(await header.locator('#feed-cutoff').innerText(), /Observed through .* UTC/)
    await header.locator('img').evaluate(image => image.decode())
    const screenshot = async name => {
      if (process.env.PLOW_SCREENSHOTS) await page.screenshot({ path: resolve(directory, `${width}-${name}.png`), fullPage: true })
    }
    const summary = page.locator('#summary-panel')
    const timeline = page.locator('#timeline-panel')
    const range = page.locator('#utc-window')
    const fit = page.getByRole('button', { name: 'Fit all', exact: true })
    const total = page.locator('#summary-total')
    const initial = await range.innerText()
    assert.ok((await summary.boundingBox()).y < (await timeline.boundingBox()).y)
    const workflow = summary.getByRole('button', { name: /Admission wait/ })
    const publish = summary.getByRole('button', { name: /Publish artifacts/ })
    const ci = summary.getByRole('button', { name: /CI checks/ })
    const titles = () => timeline.locator('.trace:visible .sample-title').allTextContents()
    const matchingThreads = ['Thread 1', 'Thread 6']
    assert.equal(await summary.locator('.category-tile').count(), 3)
    assert.equal((await titles()).length, 10)
    assert.match(await total.innerText(), /43h 24m across 10 threads/)
    assert.ok(await timeline.getByRole('button', { name: 'Zoom in' }).isVisible())
    assert.equal(await fit.isDisabled(), true)
    await screenshot('overview')

    await workflow.focus()
    await page.keyboard.press('Enter')
    assert.equal(await workflow.getAttribute('aria-expanded'), 'true')
    assert.equal((await titles()).length, 10)
    assert.equal(await workflow.evaluate(element => element === document.activeElement), true)
    await screenshot('category')

    await publish.focus()
    await page.keyboard.press('Space')
    assert.equal(await publish.getAttribute('aria-pressed'), 'true')
    assert.equal(await publish.evaluate(element => element.matches(':focus-visible')), true)
    assert.deepEqual(await titles(), matchingThreads)
    assert.equal(await timeline.locator('.match-span:visible').count(), 2)
    assert.match(await page.locator('#timeline-selection').innerText(), /Publish artifacts · 2 threads shown/)
    assert.equal(await range.innerText(), initial)
    await screenshot('filtered')

    await ci.click()
    assert.equal((await titles()).length, 8)
    assert.equal(await timeline.locator('.match-span:visible').count(), 8)
    await page.keyboard.press('Escape')
    assert.equal((await titles()).length, 10)
    await publish.click()
    await publish.click()
    assert.equal((await titles()).length, 10)
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
    assert.equal((await titles()).length, 0)
    assert.match(await timeline.innerText(), /No matching threads in this range/)
    assert.match(await page.locator('#zoom-mode').innerText(), /Details/)
    await screenshot('empty')

    await fit.click()
    assert.equal(await range.innerText(), initial)
    assert.deepEqual(await titles(), matchingThreads)
    await workflow.click()
    assert.equal(await workflow.getAttribute('aria-expanded'), 'false')
    assert.equal((await titles()).length, 10)
    await screenshot('recovered')

    await workflow.click()
    await publish.click()
    await brush(.60, .72)
    assert.deepEqual(await titles(), ['Thread 6'])
    const inspect = timeline.getByRole('button', { name: /^Inspect Thread 6/ })
    await inspect.click()
    assert.equal(await inspect.getAttribute('aria-expanded'), 'true')
    assert.match(await timeline.locator('.inspect-panel:visible').innerText(), /Publish artifacts/)
    await screenshot('details')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    storedFeed = JSON.stringify({ observed: 0, traces: [] })
    await page.reload()
    await page.getByText('No measured session time has been imported yet.').waitFor()
    assert.equal(await timeline.isVisible(), false)
    await screenshot('no-evidence')
    storedFeed = null
    assert.equal((await page.reload()).status(), 503)
    await page.getByText('Session data is temporarily unavailable.', { exact: false }).waitFor()
    assert.equal(await timeline.isVisible(), false)
    await screenshot('unavailable')
    storedFeed = JSON.stringify(feed)
    await page.reload()
    await timeline.waitFor()
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
}

console.log('Plow Worker access guard and timeline filtering passed at 320, 390, 728, 1120, 1440 and 1920 pixels.')
