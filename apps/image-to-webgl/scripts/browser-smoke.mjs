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
  await page.addInitScript(() => {
    window.__startupStatusMessageSeen = false
    document.addEventListener('DOMContentLoaded', () => {
      const status = document.querySelector('#status')
      if (!status) return
      const dropZone = document.querySelector('#file-drop-zone')
      const downloadLink = document.querySelector('#download-link')
      window.__initialFileChrome = {
        dropBorderColor: dropZone ? getComputedStyle(dropZone).borderColor : '',
        downloadBounds: downloadLink?.getBoundingClientRect().toJSON(),
        statusBorderColor: getComputedStyle(status).borderLeftColor,
      }
      const checkStatus = () => {
        if (/(?:Loading the local sample|Tracing silhouette)/.test(status.textContent ?? '')) {
          window.__startupStatusMessageSeen = true
        }
      }
      checkStatus()
      window.__startupStatusObserver = new MutationObserver(checkStatus)
      window.__startupStatusObserver.observe(status, {
        childList: true,
        characterData: true,
        subtree: true,
      })
    })
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () => ['success', 'error'].includes(document.querySelector('#status')?.dataset.kind ?? ''),
    undefined,
    { timeout: 60_000 },
  )
  const pageMetrics = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }))
  if (pageMetrics.documentHeight > pageMetrics.viewportHeight + 1) {
    throw new Error(
      `Desktop layout requires scrolling: ${pageMetrics.documentHeight}px document in ${pageMetrics.viewportHeight}px viewport.`,
    )
  }

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
  const startupMessageSeen = await page.evaluate(() => {
    window.__startupStatusObserver?.disconnect()
    return window.__startupStatusMessageSeen
  })
  if (startupMessageSeen) {
    throw new Error('A transient loading or tracing message appeared during startup.')
  }
  const fileChrome = await page.evaluate(() => {
    const dropZone = document.querySelector('#file-drop-zone')
    const downloadLink = document.querySelector('#download-link')
    const status = document.querySelector('#status')
    return {
      initial: window.__initialFileChrome,
      current: {
        dropBorderColor: dropZone ? getComputedStyle(dropZone).borderColor : '',
        downloadBounds: downloadLink?.getBoundingClientRect().toJSON(),
        statusBorderColor: status ? getComputedStyle(status).borderLeftColor : '',
      },
    }
  })
  if (
    !fileChrome.initial?.downloadBounds ||
    fileChrome.initial.downloadBounds.width !== fileChrome.current.downloadBounds?.width ||
    fileChrome.initial.downloadBounds.height !== fileChrome.current.downloadBounds?.height ||
    fileChrome.initial.dropBorderColor !== fileChrome.current.dropBorderColor ||
    fileChrome.initial.statusBorderColor !== fileChrome.current.statusBorderColor
  ) {
    throw new Error(`The file controls changed appearance during startup: ${JSON.stringify(fileChrome)}`)
  }
  if (!/\d+(?:\.\d+)? (?:B|KB|MB) GLB/.test(result.message ?? '')) {
    throw new Error(`Generated GLB size is missing from the status: ${result.message}`)
  }
  if (!await page.locator('#download-link').isVisible()) {
    throw new Error('The GLB download link did not become visible.')
  }
  if (!await page.locator('#file-drop-zone').isVisible()) {
    throw new Error('The PNG file drop zone is not visible.')
  }
  if (await page.locator('.scope-note').count() !== 0) {
    throw new Error('The removed prototype boundary note is still present.')
  }
  if (
    await page.locator('.viewer-panel select').count() !== 0 ||
    await page.getByRole('button', { name: 'Reset view' }).count() !== 0
  ) {
    throw new Error('The removed view preset controls are still present.')
  }
  const introBounds = await page.locator('.intro').boundingBox()
  const dropZoneBounds = await page.locator('#file-drop-zone').boundingBox()
  if (!introBounds || !dropZoneBounds) {
    throw new Error('The source controls could not be measured.')
  }
  if (dropZoneBounds.height < 96) {
    throw new Error(`The PNG file drop zone is too short: ${dropZoneBounds.height}px.`)
  }
  if (
    dropZoneBounds.y < pageMetrics.viewportHeight * 0.65 ||
    dropZoneBounds.y - (introBounds.y + introBounds.height) < 96
  ) {
    throw new Error('The source controls are not anchored in the lower portion of the panel.')
  }
  await page.evaluate(async () => {
    const response = await fetch(new URL('sample/prism-ring.png', window.location.href))
    const blob = await response.blob()
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], 'dropped-prism.png', { type: 'image/png' }))
    document.querySelector('#file-drop-zone')?.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }))
  })
  await page.waitForFunction(() => (
    document.querySelector('#file-name')?.textContent === 'dropped-prism.png' &&
    document.querySelector('#file-drop-zone')?.dataset.state === 'success'
  ), undefined, { timeout: 60_000 })
  const projectLink = page.locator('.project-credit a')
  if (!await projectLink.isVisible()) {
    throw new Error('The DJ Tools repository credit is not visible.')
  }
  if (await projectLink.getAttribute('href') !== 'https://github.com/DarrenJohns/djtools') {
    throw new Error('The DJ Tools repository credit link is missing or incorrect.')
  }
  if (await page.locator('.project-credit .version').textContent() !== 'v0.0.1') {
    throw new Error('The displayed application version is incorrect.')
  }
  const creditBounds = await page.locator('.project-credit').boundingBox()
  if (
    !creditBounds ||
    creditBounds.y + creditBounds.height > pageMetrics.viewportHeight ||
    pageMetrics.viewportHeight - (creditBounds.y + creditBounds.height) > 32
  ) {
    throw new Error('The DJ Tools credit extends beyond the desktop viewport.')
  }

  const canvasBounds = await page.locator('#viewer canvas').boundingBox()
  if (!canvasBounds) {
    throw new Error('The WebGL canvas is not available for orbit testing.')
  }
  const orbitStart = {
    x: canvasBounds.x + canvasBounds.width * 0.62,
    y: canvasBounds.y + canvasBounds.height * 0.55,
  }
  await page.mouse.move(orbitStart.x, orbitStart.y)
  await page.mouse.down()
  await page.mouse.move(orbitStart.x + 180, orbitStart.y - 45, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)

  await page.evaluate(() => {
    const downloadLink = document.querySelector('#download-link')
    const status = document.querySelector('#status')
    if (!downloadLink) throw new Error('The download link is missing.')
    if (!status) throw new Error('The status is missing.')
    window.__downloadWasHidden = false
    window.__statusShowedTracing = false
    window.__downloadObserver = new MutationObserver(() => {
      if (downloadLink.hidden) window.__downloadWasHidden = true
    })
    window.__statusObserver = new MutationObserver(() => {
      if (status.textContent?.includes('Tracing')) window.__statusShowedTracing = true
    })
    window.__downloadObserver.observe(downloadLink, {
      attributes: true,
      attributeFilter: ['hidden'],
    })
    window.__statusObserver.observe(status, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
  const statusBeforeControls = await page.locator('#status').textContent()
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
  await page.waitForFunction(
    (previousStatus) => {
      const status = document.querySelector('#status')
      return status?.dataset.kind === 'success' &&
        status.textContent?.trim() !== previousStatus?.trim()
    },
    statusBeforeControls,
    { timeout: 60_000 },
  )
  const transientUiState = await page.evaluate(() => {
    window.__downloadObserver?.disconnect()
    window.__statusObserver?.disconnect()
    return {
      downloadWasHidden: window.__downloadWasHidden,
      statusShowedTracing: window.__statusShowedTracing,
    }
  })
  if (transientUiState.downloadWasHidden || !await page.locator('#download-link').isVisible()) {
    throw new Error('The download link disappeared while rebuilding the GLB.')
  }
  if (transientUiState.statusShowedTracing) {
    throw new Error('The file metrics were replaced by a transient tracing message.')
  }
  await page.locator('#environment-toggle').click()
  if (await page.locator('#environment-toggle').getAttribute('aria-pressed') !== null) {
    throw new Error('The environment action incorrectly exposes toggle-button semantics.')
  }
  if (await page.locator('.environment-label').textContent() !== 'Dark environment') {
    throw new Error('The environment toggle label did not update.')
  }
  if (await page.locator('.viewer-panel').getAttribute('data-environment') !== 'light') {
    throw new Error('The light environment was not applied to the viewer interface.')
  }
  await page.waitForFunction(() => (
    getComputedStyle(document.querySelector('.range-control')).backgroundColor
      .includes('219, 231, 243, 0.52') &&
    getComputedStyle(document.querySelector('.viewer-hint')).backgroundColor
      .includes('219, 231, 243, 0.52')
  ), undefined, { timeout: 2_000 })
  const lightSurfaces = await page.evaluate(() => ({
    controlColor: getComputedStyle(document.querySelector('.range-control')).backgroundColor,
    controlFilter: getComputedStyle(document.querySelector('.range-control')).backdropFilter,
    hintColor: getComputedStyle(document.querySelector('.viewer-hint')).backgroundColor,
    hintFilter: getComputedStyle(document.querySelector('.viewer-hint')).backdropFilter,
  }))
  if (
    !lightSurfaces.controlColor.includes('219, 231, 243, 0.52') ||
    !lightSurfaces.hintColor.includes('219, 231, 243, 0.52') ||
    !lightSurfaces.controlFilter.includes('blur(18px)') ||
    !lightSurfaces.hintFilter.includes('blur(18px)')
  ) {
    throw new Error(
      `The viewer controls did not switch to their frosted-glass surfaces: ${JSON.stringify(lightSurfaces)}`,
    )
  }

  const previewCanvas = page.locator('#viewer canvas')
  const previewSemantics = await previewCanvas.evaluate((canvas) => ({
    role: canvas.getAttribute('role'),
    label: canvas.getAttribute('aria-label'),
    describedBy: canvas.getAttribute('aria-describedby'),
    keyShortcuts: canvas.getAttribute('aria-keyshortcuts'),
  }))
  if (
    previewSemantics.role !== 'img' ||
    !previewSemantics.label?.includes('arrow keys to rotate') ||
    previewSemantics.describedBy !== 'viewer-hint' ||
    !previewSemantics.keyShortcuts?.includes('Home')
  ) {
    throw new Error(`The preview keyboard semantics are incomplete: ${JSON.stringify(previewSemantics)}`)
  }
  await previewCanvas.focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(100)
  const defaultViewImage = await previewCanvas.screenshot()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(100)
  const rotatedViewImage = await previewCanvas.screenshot()
  if (
    await previewCanvas.getAttribute('data-view') !== 'custom' ||
    rotatedViewImage.equals(defaultViewImage)
  ) {
    throw new Error('The focused preview did not respond to keyboard rotation.')
  }
  await page.keyboard.press('+')
  await page.waitForTimeout(100)
  const zoomedViewImage = await previewCanvas.screenshot()
  if (zoomedViewImage.equals(rotatedViewImage)) {
    throw new Error('The focused preview did not respond to keyboard zoom.')
  }
  await page.keyboard.press('Home')
  await page.waitForTimeout(100)
  const restoredViewImage = await previewCanvas.screenshot()
  if (
    await previewCanvas.getAttribute('data-view') !== 'isometric' ||
    restoredViewImage.equals(zoomedViewImage)
  ) {
    throw new Error('The Home key did not reset the preview.')
  }
  if (
    await page.locator('#edge-color-blend').getAttribute('aria-valuetext') !== '80 percent' ||
    !(await page.locator('#edge-curve').getAttribute('aria-valuetext'))?.includes('bevel segments')
  ) {
    throw new Error('Slider value text is missing accessible units.')
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
    throw new Error('The environment control moved outside its viewer overlay position.')
  }
  if (
    !hintBeforeScroll || !hintAfterScroll ||
    Math.abs(hintBeforeScroll.y - hintAfterScroll.y) > 1
  ) {
    throw new Error('The viewer interaction hint moved outside its viewer overlay position.')
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  const overlayPositions = await page.evaluate(() => ({
    toggle: getComputedStyle(document.querySelector('#environment-toggle')).position,
    hint: getComputedStyle(document.querySelector('.viewer-hint')).position,
    parameters: getComputedStyle(document.querySelector('.parameter-bar')).position,
  }))
  if (Object.values(overlayPositions).some((position) => position !== 'absolute')) {
    throw new Error(`Viewer overlays are not viewer-local: ${JSON.stringify(overlayPositions)}`)
  }

  if (process.env.SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true })
  }

  const canvasSize = await page.locator('#viewer canvas').evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }))
  const viewportHeight = await page.evaluate(() => window.innerHeight)
  if (
    canvasSize.width === 0 ||
    canvasSize.height < 0.8 * viewportHeight
  ) {
    throw new Error(`The WebGL canvas has invalid dimensions: ${canvasSize.width} x ${canvasSize.height}.`)
  }

  console.log(`${result.message} WebGL canvas: ${canvasSize.width} x ${canvasSize.height}.`)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForFunction(() => (
    document.querySelector('#viewer canvas')?.dataset.motion === 'reduced'
  ))
  const reducedMotionStyles = await page.evaluate(() => ({
    buttonTransition: getComputedStyle(document.querySelector('#environment-toggle')).transitionDuration,
    downloadTransform: getComputedStyle(document.querySelector('#download-link')).transform,
  }))
  if (
    !['0.01ms', '1e-05s'].includes(reducedMotionStyles.buttonTransition) ||
    reducedMotionStyles.downloadTransform !== 'none'
  ) {
    throw new Error(`Reduced-motion styles were not applied: ${JSON.stringify(reducedMotionStyles)}`)
  }

  for (const viewport of [
    { width: 800, height: 960 },
    { width: 375, height: 812 },
    { width: 320, height: 568 },
  ]) {
    const mobilePage = await browser.newPage({ viewport, hasTouch: true })
    try {
      await mobilePage.goto(baseUrl, { waitUntil: 'networkidle' })
      await mobilePage.waitForFunction(
        () => document.querySelector('#status')?.dataset.kind === 'success',
        undefined,
        { timeout: 60_000 },
      )
      const mobileLayout = await mobilePage.evaluate(() => {
        const viewer = document.querySelector('.viewer-panel')?.getBoundingClientRect()
        const overlays = ['#environment-toggle', '.viewer-hint', '.parameter-bar']
          .map((selector) => document.querySelector(selector)?.getBoundingClientRect())
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          touchEnabled: 'ontouchstart' in window,
          viewer: viewer?.toJSON(),
          overlays: overlays.map((rect) => rect?.toJSON()),
        }
      })
      if (mobileLayout.documentWidth > mobileLayout.viewportWidth + 1) {
        throw new Error(
          `${viewport.width}px layout overflows horizontally: ${mobileLayout.documentWidth}px.`,
        )
      }
      if (!mobileLayout.touchEnabled || !mobileLayout.viewer) {
        throw new Error(`${viewport.width}px layout is not touch-capable or has no viewer.`)
      }
      for (const overlay of mobileLayout.overlays) {
        if (
          !overlay ||
          overlay.x < mobileLayout.viewer.x - 1 ||
          overlay.y < mobileLayout.viewer.y - 1 ||
          overlay.x + overlay.width > mobileLayout.viewer.x + mobileLayout.viewer.width + 1 ||
          overlay.y + overlay.height > mobileLayout.viewer.y + mobileLayout.viewer.height + 1
        ) {
          throw new Error(`${viewport.width}px viewer overlay extends outside the viewer.`)
        }
      }
      const environmentBox = await mobilePage.locator('#environment-toggle').boundingBox()
      const parametersBox = await mobilePage.locator('.parameter-bar').boundingBox()
      const hintBox = await mobilePage.locator('.viewer-hint').boundingBox()
      const boxesOverlap = (first, second) => (
        first && second &&
        first.x < second.x + second.width &&
        first.x + first.width > second.x &&
        first.y < second.y + second.height &&
        first.y + first.height > second.y
      )
      if (
        boxesOverlap(environmentBox, parametersBox) ||
        boxesOverlap(environmentBox, hintBox) ||
        boxesOverlap(parametersBox, hintBox)
      ) {
        throw new Error(`${viewport.width}px viewer overlays collide.`)
      }
    } finally {
      await mobilePage.close()
    }
  }
} finally {
  await browser.close()
}
