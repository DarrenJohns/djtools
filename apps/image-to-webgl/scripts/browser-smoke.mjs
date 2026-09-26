import { access } from 'node:fs/promises'
import process from 'node:process'
import { chromium } from 'playwright-core'

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

let executablePath
for (const candidate of edgeCandidates) {
  try {
    await access(candidate)
    executablePath = candidate
    break
  } catch {
    // Try the next known Edge installation path.
  }
}

if (!executablePath) {
  throw new Error('Microsoft Edge was not found. Set EDGE_PATH to run the browser smoke test.')
}

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => ['success', 'error'].includes(document.querySelector('#status')?.dataset.kind ?? ''),
    undefined,
    { timeout: 60_000 },
  )

  const result = await page.locator('#status').evaluate((element) => ({
    kind: element.dataset.kind,
    message: element.textContent?.trim(),
  }))

  if (pageErrors.length > 0) {
    throw new Error(`Browser page errors: ${pageErrors.join('; ')}`)
  }
  if (result.kind !== 'success') {
    throw new Error(`Conversion failed in Edge: ${result.message}`)
  }
  if (!/\d+(?:\.\d+)? (?:B|KB|MB) GLB/.test(result.message ?? '')) {
    throw new Error(`Generated GLB size is missing from the status: ${result.message}`)
  }
  if (!await page.locator('#download-link').isVisible()) {
    throw new Error('The GLB download link did not become visible.')
  }
  const projectLink = page.locator('.project-credit a')
  if (await projectLink.getAttribute('href') !== 'https://github.com/DarrenJohns/djtools') {
    throw new Error('The DJ Tools repository credit link is missing or incorrect.')
  }
  if (await page.locator('.project-credit .version').textContent() !== 'v0.0.1') {
    throw new Error('The displayed application version is incorrect.')
  }

  await page.locator('#bevel-width').fill('0.03')
  if (await page.locator('#bevel-width-value').textContent() !== '0.030') {
    throw new Error('The edge-width output did not reflect the slider value.')
  }
  await page.locator('#edge-color-blend').fill('80')
  if (await page.locator('#edge-color-blend-value').textContent() !== '80%') {
    throw new Error('The edge-color-blend output did not reflect the slider value.')
  }
  await page.locator('#edge-curve').fill('90')
  if (await page.locator('#edge-curve-value').textContent() !== '90%') {
    throw new Error('The edge-curve output did not reflect the slider value.')
  }
  await page.locator('#convert-button').click()
  await page.waitForFunction(
    () => document.querySelector('#status')?.dataset.kind === 'success',
    undefined,
    { timeout: 60_000 },
  )
  await page.locator('#environment-toggle').click()
  if (await page.locator('#environment-toggle').getAttribute('aria-pressed') !== 'true') {
    throw new Error('The light environment toggle did not activate.')
  }
  if (await page.locator('.environment-label').textContent() !== 'Dark environment') {
    throw new Error('The environment toggle label did not update.')
  }

  const toggleBeforeScroll = await page.locator('#environment-toggle').boundingBox()
  const hintBeforeScroll = await page.locator('.viewer-hint').boundingBox()
  await page.evaluate(() => window.scrollTo(0, Math.min(300, document.body.scrollHeight)))
  await page.waitForTimeout(100)
  const toggleAfterScroll = await page.locator('#environment-toggle').boundingBox()
  const hintAfterScroll = await page.locator('.viewer-hint').boundingBox()
  if (
    !toggleBeforeScroll || !toggleAfterScroll ||
    Math.abs(toggleBeforeScroll.y - toggleAfterScroll.y) > 1
  ) {
    throw new Error('The environment toggle moved with the page.')
  }
  if (
    !hintBeforeScroll || !hintAfterScroll ||
    Math.abs(hintBeforeScroll.y - hintAfterScroll.y) > 1
  ) {
    throw new Error('The viewer interaction hint moved with the page.')
  }
  await page.evaluate(() => window.scrollTo(0, 0))

  if (process.env.SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  }

  const canvasSize = await page.locator('#viewer canvas').evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }))
  if (canvasSize.width === 0 || canvasSize.height === 0) {
    throw new Error('The WebGL canvas has invalid dimensions.')
  }

  console.log(`${result.message} WebGL canvas: ${canvasSize.width} x ${canvasSize.height}.`)
} finally {
  await browser.close()
}
