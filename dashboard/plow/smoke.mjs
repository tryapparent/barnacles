import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the Plow build output directory.')
const { default: worker } = await import(pathToFileURL(resolve(directory, 'worker.mjs')).href)
const app = 'https://plow.tryapparent.com/app'
const audience = 'fixture-audience'
const env = { PLOW_ACCESS_AUDIENCE: audience }
const history = 'https://preview.tail-fixture.ts.net:19531/sessions'
const linked = { ...env, PLOW_SESSION_HISTORY_URL: history }
const context = { access: { aud: audience } }
const request = new Request(app)
assert.equal((await worker.fetch(request, env, {})).status, 403)
assert.equal((await worker.fetch(request, {}, context)).status, 403)
assert.equal((await worker.fetch(request, env, { access: { aud: 'another-app' } })).status, 403)
assert.equal((await worker.fetch(new Request('https://preview.workers.dev/app'), env, context)).status, 404)
const allowed = await worker.fetch(request, env, context)
assert.equal(allowed.status, 200)
assert.equal(allowed.headers.get('Cache-Control'), 'private, no-store')
assert.equal(await allowed.text(), await readFile(resolve(directory, 'index.html'), 'utf8'))
const denied = await worker.fetch(request, linked, {})
assert.equal(denied.status, 403)
assert.ok(!(await denied.text()).includes(history))
const invalid = await worker.fetch(request, { ...env, PLOW_SESSION_HISTORY_URL: 'https://preview.tail-fixture.ts.net/shipping' }, context)
assert.match(await invalid.text(), /data-session-history=""/)
const head = await worker.fetch(new Request(app, { method: 'HEAD' }), linked, context)
assert.equal(head.status, 200)
assert.equal(await head.text(), '')


const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const width of [320, 390, 728, 1120, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.route(app, async route => {
      const response = await worker.fetch(new Request(route.request().url()), linked, context)
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
    assert.equal(await header.getByText('Sample data', { exact: true }).isVisible(), true)
    await header.locator('img').evaluate(image => image.decode())
    const screenshot = async name => {
      if (process.env.PLOW_SCREENSHOTS) await page.screenshot({ path: resolve(directory, `${width}-${name}.png`), fullPage: true })
    }
    const link = page.getByRole('link', { name: 'Session history' })
    assert.equal(await link.getAttribute('href'), history)
    assert.ok(await link.isVisible())
    await page.keyboard.press('Tab')
    assert.equal(await link.evaluate(element => element.matches(':focus-visible')), true)
    const summary = page.locator('#summary-panel')
    const timeline = page.locator('#timeline-panel')
    const range = page.locator('#utc-window')
    const fit = page.getByRole('button', { name: 'Fit all', exact: true })
    const total = page.locator('#summary-total')
    const initial = await range.innerText()
    assert.ok((await summary.boundingBox()).y < (await timeline.boundingBox()).y)
    const workflow = summary.getByRole('button', { name: /Workflows or waits/ })
    assert.equal(await workflow.getAttribute('data-slot'), 'button')
    const publish = summary.getByRole('button', { name: /Publish artifacts/ })
    const ci = summary.getByRole('button', { name: /CI checks/ })
    const titles = () => timeline.locator('.trace:visible .sample-title').allTextContents()
    const matchingThreads = ['Release packaging', 'Export retries']
    const geometry = () => page.evaluate(() => {
      const bounds = element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return [x + scrollX, y + scrollY, width, height]
      }
      const selectors = ['.activity-header', '#summary-panel', '.summary-top', '#summary-total',
        '#summary-note', '#tiles', '#operation-panel', '#timeline-panel', '.timeline-heading-row',
        '#timeline-selection', '.zoom-tools', '#zoom-mode', '.navigator', '#utc-window', '.chart-key',
        '#timeline-viewport', '.inspector-slot', '.reading-help']
      return {
        page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        regions: Object.fromEntries(selectors.map(selector => [selector, bounds(document.querySelector(selector))])),
        categories: [...document.querySelectorAll('.category-tile')].map(bounds),
        rows: [...document.querySelectorAll('.trace')].map(row => [row.offsetTop, row.offsetHeight]),
      }
    })
    const overview = await geometry()
    const assertStable = async state => assert.deepEqual(await geometry(), overview, `${width}px · ${state}`)
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
    await assertStable('open operation breakdown')
    await screenshot('category')

    await publish.focus()
    await page.keyboard.press('Space')
    assert.equal(await publish.getAttribute('aria-pressed'), 'true')
    assert.equal(await publish.evaluate(element => element.matches(':focus-visible')), true)
    assert.deepEqual(await titles(), matchingThreads)
    assert.equal(await timeline.locator('.match-span:visible').count(), 2)
    assert.match(await page.locator('#timeline-selection').innerText(), /Publish artifacts · 2 threads shown/)
    assert.equal(await range.innerText(), initial)
    await assertStable('filter to Publish artifacts')
    await screenshot('filtered')

    await ci.click()
    assert.equal((await titles()).length, 8)
    assert.equal(await timeline.locator('.match-span:visible').count(), 8)
    await assertStable('switch filter to CI checks')
    await page.keyboard.press('Escape')
    assert.equal((await titles()).length, 10)
    await assertStable('clear filter with Escape')
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
    await assertStable('empty filtered range')
    await screenshot('empty')
    await page.getByRole('slider').focus()
    await page.keyboard.press('ArrowRight')
    await assertStable('pan with keyboard')

    await fit.click()
    assert.equal(await range.innerText(), initial)
    assert.deepEqual(await titles(), matchingThreads)
    await workflow.click()
    assert.equal(await workflow.getAttribute('aria-expanded'), 'false')
    assert.equal((await titles()).length, 10)
    await assertStable('reset zoom and close operation breakdown')
    await screenshot('recovered')

    await summary.getByRole('button', { name: /^Agent work/ }).click()
    const operationButtons = summary.getByRole('group', { name: 'Operations' }).getByRole('button')
    assert.ok(await operationButtons.count() > 2)
    await operationButtons.last().focus()
    if (width === 320) {
      assert.ok(await summary.locator('#operation-panel').evaluate(element => element.scrollTop > 0))
    }
    await assertStable('focus the last operation in the breakdown')

    await workflow.click()
    await publish.click()
    await brush(.60, .72)
    assert.deepEqual(await titles(), ['Export retries'])
    const inspect = timeline.getByRole('button', { name: /^Inspect Export retries/ })
    await inspect.click()
    assert.equal(await inspect.getAttribute('aria-expanded'), 'true')
    const inspector = timeline.getByRole('region', { name: /Export retries · Recorded timeline/ })
    assert.match(await inspector.innerText(), /Publish artifacts/)
    assert.equal(await inspector.evaluate(element => element === document.activeElement), true)
    await assertStable('open thread inspector')
    await screenshot('details')
    await page.keyboard.press('Escape')
    assert.equal(await inspect.getAttribute('aria-expanded'), 'false')
    assert.equal(await inspect.evaluate(element => element === document.activeElement), true)
    await assertStable('close thread inspector with Escape')
    await page.keyboard.press('Enter')
    assert.equal(await inspector.isVisible(), true)
    await brush(.01, .12)
    assert.equal(await inspector.isVisible(), false)
    await assertStable('filter excludes inspected thread')

    const help = page.locator('.reading-help summary')
    const instructions = page.getByRole('region', { name: 'Chart instructions' })
    await help.focus()
    await page.keyboard.press('Enter')
    assert.equal(await instructions.isVisible(), true)
    if (width === 320) {
      await instructions.focus()
      await page.keyboard.press('End')
      await page.waitForFunction(() => document.querySelector('.help-copy').scrollTop > 0)
      await help.focus()
    }
    await assertStable('open chart help')
    await screenshot('help')
    await page.keyboard.press('Enter')
    assert.equal(await instructions.count(), 0)
    await assertStable('close chart help')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.route(history, route => route.fulfill({ contentType: 'text/html', body: '<h1>Plow session history</h1>' }))
    await link.press('Enter')
    await page.waitForURL(history)
    assert.ok(await page.getByRole('heading', { name: 'Plow session history' }).isVisible())
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
}

console.log('Plow Worker access guard, timeline filtering, and stable layout passed at 320, 390, 728, 1120, 1440 and 1920 pixels.')
