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

function collectDiagnostics(page) {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  return { pageErrors, consoleErrors }
}

function assertExpectedDiagnostics(
  label,
  { pageErrors, consoleErrors },
  expectedConsoleErrors,
) {
  if (pageErrors.length > 0) {
    throw new Error(`${label} page errors: ${pageErrors.join('; ')}`)
  }

  const unexpected = consoleErrors.filter(
    (message) => !expectedConsoleErrors.some((pattern) => pattern.test(message)),
  )
  if (unexpected.length > 0) {
    throw new Error(`${label} unexpected console errors: ${unexpected.join('; ')}`)
  }
  for (const pattern of expectedConsoleErrors) {
    if (!consoleErrors.some((message) => pattern.test(message))) {
      throw new Error(`${label} did not log expected renderer error ${pattern}.`)
    }
  }
}

async function waitForSuccessfulConversion(page) {
  await page.waitForFunction(
    () => document.querySelector('#status')?.dataset.kind === 'success',
    undefined,
    { timeout: 60_000 },
  )
}

async function assertDownloadUsable(page, label) {
  const downloadLink = page.locator('#download-link')
  const downloadState = await downloadLink.evaluate((link) => ({
    ariaDisabled: link.getAttribute('aria-disabled'),
    download: link.getAttribute('download'),
    href: link.getAttribute('href'),
  }))
  if (
    downloadState.ariaDisabled !== null ||
    !downloadState.download?.endsWith('.glb') ||
    !downloadState.href?.startsWith('blob:')
  ) {
    throw new Error(`${label} GLB download is not enabled: ${JSON.stringify(downloadState)}`)
  }

  const downloadPromise = page.waitForEvent('download')
  await downloadLink.click()
  const download = await downloadPromise
  const failure = await download.failure()
  if (failure || !download.suggestedFilename().endsWith('.glb')) {
    throw new Error(
      `${label} GLB download failed: ${failure ?? download.suggestedFilename()}`,
    )
  }
}

async function checkStartupRendererFailure() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  try {
    await context.addInitScript(() => {
      const nativeGetContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
        if (['webgl', 'webgl2', 'experimental-webgl'].includes(type)) return null
        return nativeGetContext.call(this, type, ...args)
      }
    })
    const page = await context.newPage()
    const diagnostics = collectDiagnostics(page)

    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await waitForSuccessfulConversion(page)

    const fallback = page.locator('#viewer .viewer-fallback')
    const fallbackState = await fallback.evaluate((element) => ({
      role: element.getAttribute('role'),
      live: element.getAttribute('aria-live'),
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    }))
    if (
      fallbackState.role !== 'status' ||
      fallbackState.live !== 'polite' ||
      !fallbackState.text?.includes('3D preview unavailable') ||
      !fallbackState.text.includes('can still be downloaded')
    ) {
      throw new Error(
        `Startup renderer failure has no accessible fallback: ${JSON.stringify(fallbackState)}`,
      )
    }
    if (await page.locator('#viewer canvas').count() !== 0) {
      throw new Error('Startup renderer failure left a preview canvas behind.')
    }
    await assertDownloadUsable(page, 'Startup renderer failure')
    assertExpectedDiagnostics('Startup renderer failure', diagnostics, [
      /THREE\.WebGLRenderer: Error creating WebGL context/,
      /Unable to initialize the 3D preview renderer\./,
    ])
  } finally {
    await context.close()
  }
}

async function checkRuntimeContextLoss() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  try {
    const page = await context.newPage()
    const diagnostics = collectDiagnostics(page)

    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await waitForSuccessfulConversion(page)
    const originalHref = await page.locator('#download-link').getAttribute('href')

    const contextLoss = await page.locator('#viewer canvas').evaluate((canvas) => {
      const event = new Event('webglcontextlost', { cancelable: true })
      const dispatchResult = canvas.dispatchEvent(event)
      return { defaultPrevented: event.defaultPrevented, dispatchResult }
    })
    if (!contextLoss.defaultPrevented || contextLoss.dispatchResult) {
      throw new Error(`Runtime context loss was not canceled: ${JSON.stringify(contextLoss)}`)
    }

    const fallback = page.locator('#viewer .viewer-fallback')
    const fallbackState = await fallback.evaluate((element) => ({
      role: element.getAttribute('role'),
      live: element.getAttribute('aria-live'),
      text: element.textContent?.replace(/\s+/g, ' ').trim(),
    }))
    if (
      fallbackState.role !== 'alert' ||
      fallbackState.live !== 'assertive' ||
      !fallbackState.text?.includes('3D preview unavailable') ||
      !fallbackState.text.includes('can still be converted')
    ) {
      throw new Error(
        `Runtime context loss has no accessible fallback: ${JSON.stringify(fallbackState)}`,
      )
    }
    if (await page.locator('#viewer canvas').count() !== 0) {
      throw new Error('Runtime context loss did not stop and remove the preview canvas.')
    }
    if (
      !await page.locator('#file-drop-zone').isVisible() ||
      !await page.locator('.parameter-bar').isVisible() ||
      !await page.locator('#environment-toggle').isEnabled()
    ) {
      throw new Error('Runtime context loss disabled behavior outside the preview.')
    }

    await page.locator('#depth').evaluate((input) => {
      input.value = '0.13'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(
      (previousHref) => {
        const link = document.querySelector('#download-link')
        const status = document.querySelector('#status')
        return status?.dataset.kind === 'success' &&
          link?.getAttribute('href') !== previousHref
      },
      originalHref,
      { timeout: 60_000 },
    )
    if (!await fallback.isVisible()) {
      throw new Error('A post-loss conversion removed the preview fallback.')
    }

    await assertDownloadUsable(page, 'Runtime context loss')
    assertExpectedDiagnostics('Runtime context loss', diagnostics, [
      /The WebGL context was lost; the 3D preview has been disabled\./,
    ])
  } finally {
    await context.close()
  }
}

async function readThemePill(page) {
  return page.locator('#environment-toggle').evaluate((toggle) => {
    const box = (element) => element?.getBoundingClientRect().toJSON()
    const style = getComputedStyle(toggle)
    const indicator = toggle.querySelector('.environment-indicator')
    const sun = toggle.querySelector('.environment-option-sun')
    const moon = toggle.querySelector('.environment-option-moon')
    return {
      tagName: toggle.tagName,
      type: toggle.getAttribute('type'),
      role: toggle.getAttribute('role'),
      label: toggle.getAttribute('aria-label'),
      checked: toggle.getAttribute('aria-checked'),
      pressed: toggle.getAttribute('aria-pressed'),
      environment: toggle.getAttribute('data-environment'),
      bounds: box(toggle),
      backgroundImage: style.backgroundImage,
      backdropFilter: style.backdropFilter,
      webkitBackdropFilter: style.webkitBackdropFilter,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      focusVisible: toggle.matches(':focus-visible'),
      indicator: {
        bounds: box(indicator),
        transform: indicator ? getComputedStyle(indicator).transform : '',
        transitionDuration: indicator ? getComputedStyle(indicator).transitionDuration : '',
      },
      sun: {
        count: toggle.querySelectorAll('.environment-option-sun').length,
        ariaHidden: sun?.getAttribute('aria-hidden'),
        bounds: box(sun),
      },
      moon: {
        count: toggle.querySelectorAll('.environment-option-moon').length,
        ariaHidden: moon?.getAttribute('aria-hidden'),
        bounds: box(moon),
      },
    }
  })
}

function assertThemePillState(state, expectedChecked, label) {
  const activeIcon = expectedChecked ? state.sun : state.moon
  const indicatorCenter = state.indicator.bounds &&
    state.indicator.bounds.x + state.indicator.bounds.width / 2
  const activeIconCenter = activeIcon.bounds &&
    activeIcon.bounds.x + activeIcon.bounds.width / 2
  if (
    state.tagName !== 'BUTTON' ||
    state.type !== 'button' ||
    state.role !== 'switch' ||
    state.label !== 'Light environment' ||
    state.checked !== String(expectedChecked) ||
    state.pressed !== null ||
    state.environment !== (expectedChecked ? 'light' : 'dark') ||
    state.sun.count !== 1 ||
    state.moon.count !== 1 ||
    state.sun.ariaHidden !== 'true' ||
    state.moon.ariaHidden !== 'true' ||
    !state.bounds ||
    state.bounds.width < 44 ||
    state.bounds.height < 44 ||
    !Number.isFinite(indicatorCenter) ||
    !Number.isFinite(activeIconCenter) ||
    Math.abs(indicatorCenter - activeIconCenter) > 2
  ) {
    throw new Error(`${label} theme pill state is invalid: ${JSON.stringify(state)}`)
  }

  const filter = `${state.backdropFilter} ${state.webkitBackdropFilter}`
  if (
    !state.backgroundImage.includes('linear-gradient') ||
    !filter.includes('blur(18px)') ||
    !filter.includes('saturate(1.45)') && !filter.includes('saturate(145%)')
  ) {
    throw new Error(`${label} theme pill is not frosted: ${JSON.stringify(state)}`)
  }
}

function boxesOverlap(first, second) {
  return (
    first && second &&
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  )
}

async function readViewerLayout(page) {
  return page.evaluate(() => {
    const box = (selector) =>
      document.querySelector(selector)?.getBoundingClientRect().toJSON()
    const panel = document.querySelector('.control-panel')
    const canvas = document.querySelector('#viewer canvas')
    const panelStyle = panel ? getComputedStyle(panel) : null
    const canvasStyle = canvas ? getComputedStyle(canvas) : null
    const panelBounds = panel?.getBoundingClientRect()
    const hit = panelBounds
      ? document.elementFromPoint(
          panelBounds.left + panelBounds.width / 2,
          panelBounds.top + panelBounds.height / 2,
        )
      : null

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      layout: box('.layout'),
      panel: box('.control-panel'),
      viewer: box('.viewer-panel'),
      canvas: box('#viewer canvas'),
      footer: box('.project-credit'),
      environment: box('#environment-toggle'),
      parameters: box('.parameter-bar'),
      hint: box('.viewer-hint'),
      panelStyle: panelStyle && {
        backgroundColor: panelStyle.backgroundColor,
        backdropFilter: panelStyle.backdropFilter,
        webkitBackdropFilter: panelStyle.webkitBackdropFilter,
        pointerEvents: panelStyle.pointerEvents,
        position: panelStyle.position,
        zIndex: panelStyle.zIndex,
      },
      canvasStyle: canvasStyle && {
        position: canvasStyle.position,
        zIndex: canvasStyle.zIndex,
      },
      panelOwnsHit: Boolean(hit && panel?.contains(hit)),
      projectedCenter: canvas && {
        x: Number(canvas.dataset.projectedCenterX),
        y: Number(canvas.dataset.projectedCenterY),
      },
      cameraPosition: canvas?.dataset.cameraPosition,
    }
  })
}

function assertFullViewportViewer(layout, label) {
  const { viewport, viewer, canvas } = layout
  for (const [name, bounds] of [['viewer', viewer], ['canvas', canvas]]) {
    if (
      !bounds ||
      Math.abs(bounds.x) > 1 ||
      Math.abs(bounds.y) > 1 ||
      Math.abs(bounds.width - viewport.width) > 1 ||
      Math.abs(bounds.height - viewport.height) > 1
    ) {
      throw new Error(
        `${label} ${name} does not span the viewport: ${JSON.stringify(bounds)}.`,
      )
    }
  }
}

function assertDesktopFraming(layout, label) {
  assertFullViewportViewer(layout, label)
  const { viewport, panel, projectedCenter, panelStyle, panelOwnsHit } = layout
  if (!panel || !projectedCenter || !panelStyle) {
    throw new Error(`${label} desktop framing could not be measured.`)
  }

  const expectedX = panel.x + panel.width + (
    viewport.width - panel.x - panel.width
  ) / 2
  const expectedY = viewport.height / 2
  const tolerance = Math.max(12, viewport.width * 0.015)
  if (
    !Number.isFinite(projectedCenter.x) ||
    !Number.isFinite(projectedCenter.y) ||
    Math.abs(projectedCenter.x - expectedX) > tolerance ||
    Math.abs(projectedCenter.y - expectedY) > tolerance
  ) {
    throw new Error(
      `${label} model is not centered in the unobstructed viewer: expected ` +
      `${expectedX.toFixed(1)},${expectedY.toFixed(1)}, got ` +
      `${projectedCenter.x},${projectedCenter.y}.`,
    )
  }

  const alpha = Number(panelStyle.backgroundColor.match(
    /rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([\d.]+))?\)/,
  )?.[1] ?? 1)
  const filter = `${panelStyle.backdropFilter} ${panelStyle.webkitBackdropFilter}`
  if (
    alpha >= 1 ||
    !filter.includes('blur(22px)') ||
    !filter.includes('saturate(1.45)') && !filter.includes('saturate(145%)') ||
    panelStyle.position !== 'absolute' ||
    panelStyle.pointerEvents === 'none' ||
    Number(panelStyle.zIndex) <= Number(layout.canvasStyle?.zIndex || 0) ||
    !panelOwnsHit
  ) {
    throw new Error(
      `${label} sidebar is not a translucent, interactive canvas overlay: ` +
      JSON.stringify({
        panelStyle,
        canvasStyle: layout.canvasStyle,
        panelOwnsHit,
      }),
    )
  }
}

async function checkDesktopOverlay(viewport, { checkSpacing = false } = {}) {
  const context = await browser.newContext({ viewport })
  try {
    const page = await context.newPage()
    const diagnostics = collectDiagnostics(page)
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await waitForSuccessfulConversion(page)
    await page.waitForFunction(() => (
      Number.isFinite(Number(document.querySelector('#viewer canvas')?.dataset.projectedCenterX))
    ))

    const label = `${viewport.width}x${viewport.height}`
    const layout = await readViewerLayout(page)
    assertDesktopFraming(layout, label)
    if (
      layout.document.width > viewport.width + 1 ||
      layout.document.height > viewport.height + 1
    ) {
      throw new Error(`${label} desktop overlay unexpectedly overflows.`)
    }
    if (
      boxesOverlap(layout.environment, layout.parameters) ||
      boxesOverlap(layout.environment, layout.hint) ||
      boxesOverlap(layout.parameters, layout.hint)
    ) {
      throw new Error(`${label} viewer overlays collide.`)
    }
    if (
      !layout.footer ||
      Math.abs(layout.footer.y + layout.footer.height - (viewport.height - 21.6)) > 2
    ) {
      throw new Error(`${label} footer is not anchored to the sidebar bottom.`)
    }

    const creditClicked = await page.locator('.project-credit a').evaluate((link) => (
      new Promise((resolve) => {
        link.addEventListener('click', (event) => {
          event.preventDefault()
          resolve(true)
        }, { once: true })
        link.click()
      })
    ))
    if (!creditClicked) {
      throw new Error(`${label} sidebar did not receive pointer interaction.`)
    }

    const canvas = page.locator('#viewer canvas')
    const beforeCamera = await canvas.getAttribute('data-camera-position')
    const unobstructedX = layout.panel.x + layout.panel.width +
      (viewport.width - layout.panel.x - layout.panel.width) * 0.62
    await page.mouse.move(unobstructedX, viewport.height * 0.56)
    await page.mouse.down()
    await page.mouse.move(unobstructedX + 110, viewport.height * 0.48, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction((before) => (
      document.querySelector('#viewer canvas')?.dataset.cameraPosition !== before
    ), beforeCamera)

    const afterInteraction = await readViewerLayout(page)
    assertFullViewportViewer(afterInteraction, `${label} after orbit`)
    if (afterInteraction.cameraPosition === beforeCamera) {
      throw new Error(`${label} object did not respond through the overlaid canvas.`)
    }

    if (checkSpacing) {
      const spacing = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect()
        const drop = rect('#file-drop-zone')
        const details = rect('.file-details')
        const footer = rect('.project-credit')
        return {
          dropHeight: drop.height,
          dropToDetails: details.top - drop.bottom,
          detailsToFooter: footer.top - details.bottom,
        }
      })
      if (
        Math.abs(spacing.dropHeight - 204) > 1 ||
        Math.abs(spacing.dropToDetails - 12) > 1 ||
        Math.abs(spacing.detailsToFooter - 12) > 1
      ) {
        throw new Error(
          `${label} approved sidebar dimensions changed: ${JSON.stringify(spacing)}.`,
        )
      }
    }

    assertExpectedDiagnostics(label, diagnostics, [])
  } finally {
    await context.close()
  }
}

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
        statusBackgroundColor: getComputedStyle(status).backgroundColor,
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
        statusBackgroundColor: status ? getComputedStyle(status).backgroundColor : '',
      },
    }
  })
  if (
    !fileChrome.initial?.downloadBounds ||
    fileChrome.initial.downloadBounds.width !== fileChrome.current.downloadBounds?.width ||
    fileChrome.initial.downloadBounds.height !== fileChrome.current.downloadBounds?.height ||
    fileChrome.initial.dropBorderColor !== fileChrome.current.dropBorderColor ||
    fileChrome.initial.statusBackgroundColor !== fileChrome.current.statusBackgroundColor
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
  if (Math.abs(dropZoneBounds.height - 204) > 1) {
    throw new Error(
      `The desktop PNG file drop zone did not reach its 12.75rem cap: ${dropZoneBounds.height}px.`,
    )
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
  const fileDetailsBounds = await page.locator('.file-details').boundingBox()
  if (!fileDetailsBounds) {
    throw new Error('The file details row could not be measured.')
  }
  const dropToDetailsGap = fileDetailsBounds.y - (
    dropZoneBounds.y + dropZoneBounds.height
  )
  const detailsToFooterGap = creditBounds.y - (
    fileDetailsBounds.y + fileDetailsBounds.height
  )
  if (
    Math.abs(dropToDetailsGap - 12) > 1 ||
    Math.abs(detailsToFooterGap - 12) > 1 ||
    Math.abs(dropToDetailsGap - detailsToFooterGap) > 1
  ) {
    throw new Error(
      `The desktop sidebar gaps are unbalanced: drop/details ${dropToDetailsGap}px, details/footer ${detailsToFooterGap}px.`,
    )
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
  const environmentToggle = page.locator('#environment-toggle')
  const darkThemePill = await readThemePill(page)
  assertThemePillState(darkThemePill, false, 'Initial dark')

  await environmentToggle.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  const focusedThemePill = await readThemePill(page)
  if (
    !focusedThemePill.focusVisible ||
    focusedThemePill.outlineStyle === 'none' ||
    Number.parseFloat(focusedThemePill.outlineWidth) < 3
  ) {
    throw new Error(
      `The theme pill has no visible keyboard focus: ${JSON.stringify(focusedThemePill)}`,
    )
  }

  await page.keyboard.press('Space')
  await page.waitForFunction(() => (
    document.querySelector('#environment-toggle')?.getAttribute('aria-checked') === 'true'
  ))
  await page.waitForTimeout(250)
  const lightThemePill = await readThemePill(page)
  assertThemePillState(lightThemePill, true, 'Space-activated light')
  if (
    !darkThemePill.indicator.bounds ||
    !lightThemePill.indicator.bounds ||
    darkThemePill.indicator.bounds.x - lightThemePill.indicator.bounds.x < 24 ||
    darkThemePill.indicator.transform === lightThemePill.indicator.transform
  ) {
    throw new Error('The theme pill indicator did not move to the sun.')
  }

  await page.keyboard.press('Enter')
  await page.waitForFunction(() => (
    document.querySelector('#environment-toggle')?.getAttribute('aria-checked') === 'false'
  ))
  await page.waitForTimeout(250)
  const restoredDarkThemePill = await readThemePill(page)
  assertThemePillState(restoredDarkThemePill, false, 'Enter-restored dark')
  if (
    !darkThemePill.indicator.bounds ||
    !restoredDarkThemePill.indicator.bounds ||
    Math.abs(
      darkThemePill.indicator.bounds.x - restoredDarkThemePill.indicator.bounds.x,
    ) > 2
  ) {
    throw new Error('The theme pill indicator did not return to the moon.')
  }

  await environmentToggle.click()
  await page.waitForTimeout(250)
  assertThemePillState(await readThemePill(page), true, 'Pointer-activated light')
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
    indicatorTransition: getComputedStyle(
      document.querySelector('.environment-indicator'),
    ).transitionDuration,
    downloadTransform: getComputedStyle(document.querySelector('#download-link')).transform,
  }))
  if (
    !['0.01ms', '1e-05s'].includes(reducedMotionStyles.buttonTransition) ||
    !['0.01ms', '1e-05s'].includes(reducedMotionStyles.indicatorTransition) ||
    reducedMotionStyles.downloadTransform !== 'none'
  ) {
    throw new Error(`Reduced-motion styles were not applied: ${JSON.stringify(reducedMotionStyles)}`)
  }

  await checkDesktopOverlay({ width: 1440, height: 960 }, { checkSpacing: true })
  await checkDesktopOverlay({ width: 1440, height: 700 })

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
        const panel = document.querySelector('.control-panel')
        const canvas = document.querySelector('#viewer canvas')
        const viewer = document.querySelector('.viewer-panel')?.getBoundingClientRect()
        const overlays = ['#environment-toggle', '.viewer-hint', '.parameter-bar']
          .map((selector) => document.querySelector(selector)?.getBoundingClientRect())
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          touchEnabled: 'ontouchstart' in window,
          panel: panel?.getBoundingClientRect().toJSON(),
          panelBackground: panel ? getComputedStyle(panel).backgroundColor : '',
          panelBackdrop: panel ? getComputedStyle(panel).backdropFilter : '',
          viewer: viewer?.toJSON(),
          overlays: overlays.map((rect) => rect?.toJSON()),
          projectedCenter: canvas && {
            x: Number(canvas.dataset.projectedCenterX),
            y: Number(canvas.dataset.projectedCenterY),
          },
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
      const mobileAlpha = Number(mobileLayout.panelBackground.match(
        /rgba?\([^,]+,[^,]+,[^,]+(?:,\s*([\d.]+))?\)/,
      )?.[1] ?? 1)
      if (
        !mobileLayout.panel ||
        mobileLayout.viewer.y < mobileLayout.panel.y + mobileLayout.panel.height - 1 ||
        mobileAlpha !== 1 ||
        mobileLayout.panelBackdrop !== 'none'
      ) {
        throw new Error(
          `${viewport.width}px control panel is not stacked and opaque: ` +
          JSON.stringify(mobileLayout),
        )
      }
      const projected = mobileLayout.projectedCenter
      if (
        !projected ||
        Math.abs(projected.x - mobileLayout.viewer.width / 2) > 12 ||
        Math.abs(projected.y - mobileLayout.viewer.height / 2) > 12
      ) {
        throw new Error(
          `${viewport.width}px camera retained an offset: ${JSON.stringify(projected)}.`,
        )
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
      if (
        !environmentBox ||
        environmentBox.width < 44 ||
        environmentBox.height < 44
      ) {
        throw new Error(`${viewport.width}px theme pill target is smaller than 44px.`)
      }
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

  await checkStartupRendererFailure()
  await checkRuntimeContextLoss()
} finally {
  await browser.close()
}
