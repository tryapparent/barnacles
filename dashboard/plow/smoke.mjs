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
  for (const width of [320, 728, 1120, 1920]) {
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
    const summary = page.locator('#summary-panel')
    const timeline = page.locator('#timeline-panel')
    const range = page.locator('#utc-window')
    const fit = page.getByRole('button', { name: 'Fit all', exact: true })
    const total = page.locator('#summary-total')
    const initial = await range.innerText()
    assert.ok((await summary.boundingBox()).y < (await timeline.boundingBox()).y)
    assert.equal(await summary.locator('.tile').count(), 3)
    assert.equal(await timeline.locator('.trace').count(), 10)
    assert.match(await total.innerText(), /43h 24m across 10 threads/)
    assert.equal(await fit.isDisabled(), true)
    await screenshot('overview')
    await summary.getByRole('button', { name: /Workflows or waits/ }).focus()
    await page.keyboard.press('Enter')
    assert.match(await total.innerText(), /28h 12m across 10 threads/)
    assert.equal(await timeline.isVisible(), true)
    assert.equal(await page.locator('#summary-heading').evaluate(element => element === document.activeElement), true)
    await screenshot('category')
    await page.locator('.span-link').first().focus()
    await page.keyboard.press('Enter')
    assert.match(await page.locator('#zoom-mode').innerText(), /Details/)
    assert.notEqual(await range.innerText(), initial)
    assert.match(await page.locator('#timeline-selection').innerText(), /Webhook delivery/)
    assert.equal(await page.locator('#timeline-selection').evaluate(element => element === document.activeElement), true)
    await page.waitForFunction(() => {
      const viewport = document.querySelector('#timeline-viewport').getBoundingClientRect()
      const label = document.querySelector('.selected-trace header').getBoundingClientRect()
      const span = document.querySelector('.span-selection').getBoundingClientRect()
      return span.left > label.right && span.right < viewport.right && span.top >= viewport.top && span.bottom <= viewport.bottom
    }, null, { timeout: 2500 })
    await screenshot('details')
    await page.getByRole('button', { name: /All categories/ }).click()
    assert.doesNotMatch(await total.innerText(), /10 threads/)
    await fit.click()
    assert.equal(await range.innerText(), initial)
    const minimap = await page.locator('#minimap').boundingBox()
    const move = position => page.mouse.move(minimap.x + minimap.width * position, minimap.y + 15)
    await move(.3)
    await page.mouse.down()
    await move(.4)
    await page.mouse.up()
    assert.match(await summary.innerText(), /No matching time/)
    await screenshot('empty')
    await fit.click()
    assert.match(await total.innerText(), /10 threads/)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.deepEqual(errors, [])
    await page.close()
  }
} finally {
  await browser.close()
}

console.log('Plow Worker access guard and browser drilldown passed at 320, 728, 1120 and 1920 pixels.')
