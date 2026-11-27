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

const browser = await chromium.launch({ channel: 'chrome' })
try {
  for (const width of [320, 390, 728, 1120, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.route(app, async route => {
      const response = await worker.fetch(new Request(route.request().url()), env, context)
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
    })
    await page.goto(app)
    await page.evaluate(() => document.fonts.ready)
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
    const workflow = summary.getByRole('button', { name: /Workflows or waits/ })
    const publish = summary.getByRole('button', { name: /Publish artifacts/ })
    const ci = summary.getByRole('button', { name: /CI checks/ })
    const titles = () => timeline.locator('.trace:visible .sample-title').allTextContents()
    const matchingThreads = ['Release packaging', 'Export retries']
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
    assert.deepEqual(await titles(), ['Export retries'])
    const inspect = timeline.getByRole('button', { name: /^Inspect Export retries/ })
    await inspect.click()
    assert.equal(await inspect.getAttribute('aria-expanded'), 'true')
    assert.match(await timeline.locator('.inspect-panel:visible').innerText(), /Publish artifacts/)
    await screenshot('details')
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
}

console.log('Plow Worker access guard and timeline filtering passed at 320, 390, 728, 1120 and 1440 pixels.')
