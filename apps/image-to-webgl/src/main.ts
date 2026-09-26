import './style.css'
import {
  convertImageToGlb,
  formatFileSize,
  type ConversionResult,
} from './imageMesh.ts'
import { ModelViewer } from './viewer.ts'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Application root #app was not found.')

app.innerHTML = `
  <main class="layout">
    <section class="control-panel">
      <div>
        <p class="eyebrow">Local WebGL object lab</p>
        <h1>Transform PNG to WebGL object.</h1>
        <p class="intro">
          Trace the image silhouette, add real depth, preserve the artwork as a texture,
          and export a self-contained GLB. Everything runs locally in your browser.
        </p>
      </div>

      <div class="source-actions">
        <label id="file-drop-zone" class="file-drop-zone">
          <input id="source-file" type="file" accept="image/png,.png">
          <span class="drop-copy">
            <strong>Open or drop PNG here</strong>
            <small id="file-name">prism-ring.png</small>
          </span>
        </label>
      </div>

      <div class="file-details">
        <a id="download-link" class="download-link" aria-disabled="true">Download GLB</a>
        <div id="status" class="status" role="status" aria-live="polite"></div>
      </div>

      <footer class="project-credit">
        <span>Brought to you by</span>
        <a href="https://github.com/DarrenJohns/djtools" target="_blank" rel="noreferrer">
          DJ Tools
        </a>
        <span class="version">v0.0.2</span>
      </footer>
    </section>

    <section class="viewer-panel" data-environment="dark" aria-label="Interactive 3D preview">
      <div id="viewer"></div>
      <div class="parameter-bar" aria-label="Object settings">
        <label class="range-control" for="depth">
          <span>Extrusion depth</span>
          <output id="depth-value" for="depth">0.12</output>
          <input id="depth" type="range" min="0.03" max="0.3" step="0.01" value="0.12">
        </label>

        <label class="range-control" for="bevel-width">
          <span>Edge width</span>
          <output id="bevel-width-value" for="bevel-width">0.012</output>
          <input id="bevel-width" type="range" min="0" max="0.06" step="0.002" value="0.012">
        </label>

        <label class="range-control" for="edge-curve">
          <span>Edge curve</span>
          <output id="edge-curve-value" for="edge-curve">55%</output>
          <input id="edge-curve" type="range" min="0" max="100" step="5" value="55">
        </label>

        <label class="range-control" for="edge-color-blend">
          <span>Color blend</span>
          <output id="edge-color-blend-value" for="edge-color-blend">60%</output>
          <input id="edge-color-blend" type="range" min="0" max="100" step="5" value="60">
        </label>
      </div>
      <button
        id="environment-toggle"
        class="environment-toggle"
        type="button"
        role="switch"
        aria-checked="false"
        aria-label="Light environment"
        data-environment="dark"
      >
        <span class="environment-indicator" aria-hidden="true"></span>
        <span class="environment-option environment-option-sun" aria-hidden="true">☀</span>
        <span class="environment-option environment-option-moon" aria-hidden="true">☾</span>
      </button>
      <div id="viewer-hint" class="viewer-hint">
        Drag to orbit · Scroll to zoom · Right-drag to pan · Focus preview for keyboard controls
      </div>
    </section>
  </main>
`

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Required interface element ${selector} is missing.`)
  }
  return element
}

const fileInput = requiredElement<HTMLInputElement>('#source-file')
const fileName = requiredElement<HTMLElement>('#file-name')
const fileDropZone = requiredElement<HTMLElement>('#file-drop-zone')
const depthInput = requiredElement<HTMLInputElement>('#depth')
const depthValue = requiredElement<HTMLOutputElement>('#depth-value')
const bevelWidthInput = requiredElement<HTMLInputElement>('#bevel-width')
const bevelWidthValue = requiredElement<HTMLOutputElement>('#bevel-width-value')
const edgeColorBlendInput = requiredElement<HTMLInputElement>('#edge-color-blend')
const edgeColorBlendValue = requiredElement<HTMLOutputElement>('#edge-color-blend-value')
const edgeCurveInput = requiredElement<HTMLInputElement>('#edge-curve')
const edgeCurveValue = requiredElement<HTMLOutputElement>('#edge-curve-value')
const status = requiredElement<HTMLElement>('#status')
const downloadLink = requiredElement<HTMLAnchorElement>('#download-link')
const viewerContainer = requiredElement<HTMLElement>('#viewer')
const viewerPanel = requiredElement<HTMLElement>('.viewer-panel')
const environmentToggle = requiredElement<HTMLButtonElement>('#environment-toggle')

const viewer = new ModelViewer(viewerContainer)
let environment: 'dark' | 'light' = 'dark'
let sourceFile: File | null = null
let result: ConversionResult | null = null
let conversionRequest = 0
let conversionTimer: number | undefined

function setStatus(message: string, kind: 'working' | 'success' | 'error' = 'working'): void {
  status.textContent = message
  status.dataset.kind = kind
}

function setSourceFile(file: File): void {
  sourceFile = file
  fileName.textContent = file.name
  downloadLink.removeAttribute('href')
  downloadLink.removeAttribute('download')
  downloadLink.setAttribute('aria-disabled', 'true')
  delete fileDropZone.dataset.state
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}sample/prism-ring.png`)
    if (!response.ok) {
      throw new Error(`Sample request failed with HTTP ${response.status}.`)
    }
    const blob = await response.blob()
    setSourceFile(new File([blob], 'prism-ring.png', { type: 'image/png' }))
    conversionRequest += 1
    await convert(conversionRequest, false)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown sample loading error.'
    setStatus(`Could not load the sample: ${message}`, 'error')
  }
}

async function convert(request: number, preserveView: boolean): Promise<void> {
  if (!sourceFile) {
    setStatus('Choose a transparent PNG before building the asset.', 'error')
    return
  }

  status.setAttribute('aria-busy', 'true')

  try {
    const converted = await convertImageToGlb(sourceFile, {
      depth: Number(depthInput.value),
      bevelWidth: Number(bevelWidthInput.value),
      edgeColorBlend: Number(edgeColorBlendInput.value) / 100,
      edgeCurve: Number(edgeCurveInput.value) / 100,
    })
    if (request !== conversionRequest) {
      URL.revokeObjectURL(converted.previewUrl)
      return
    }

    await viewer.loadGlb(converted.glb, { preserveView })
    const previousResult = result
    result = converted
    downloadLink.href = result.previewUrl
    downloadLink.download = `${sourceFile.name.replace(/\.png$/i, '')}.glb`
    downloadLink.removeAttribute('aria-disabled')
    if (previousResult) URL.revokeObjectURL(previousResult.previewUrl)
    fileDropZone.dataset.state = 'success'
    setStatus(
      `${result.contourCount} contours · ${Math.round(result.triangleCount).toLocaleString()} tris · ${formatFileSize(result.glb.byteLength)} GLB`,
      'success',
    )
  } catch (error) {
    if (request !== conversionRequest) return
    const message = error instanceof Error ? error.message : 'Unknown conversion error.'
    fileDropZone.dataset.state = 'error'
    setStatus(message, 'error')
  } finally {
    if (request === conversionRequest) {
      status.removeAttribute('aria-busy')
    }
  }
}

function scheduleConversion(preserveView: boolean): void {
  conversionRequest += 1
  const request = conversionRequest
  window.clearTimeout(conversionTimer)
  conversionTimer = window.setTimeout(() => void convert(request, preserveView), 150)
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) {
    setSourceFile(file)
    scheduleConversion(false)
  }
})

const preventFileDragDefaults = (event: DragEvent): void => {
  event.preventDefault()
  event.stopPropagation()
}

fileDropZone.addEventListener('dragenter', (event) => {
  preventFileDragDefaults(event)
  fileDropZone.dataset.dragging = 'true'
})

fileDropZone.addEventListener('dragover', (event) => {
  preventFileDragDefaults(event)
  fileDropZone.dataset.dragging = 'true'
})

fileDropZone.addEventListener('dragleave', (event) => {
  preventFileDragDefaults(event)
  if (event.relatedTarget instanceof Node && fileDropZone.contains(event.relatedTarget)) return
  delete fileDropZone.dataset.dragging
})

fileDropZone.addEventListener('drop', (event) => {
  preventFileDragDefaults(event)
  delete fileDropZone.dataset.dragging
  const file = event.dataTransfer?.files[0]
  if (!file) {
    setStatus('Drop one transparent PNG file here.', 'error')
    return
  }
  setSourceFile(file)
  scheduleConversion(false)
})

depthInput.addEventListener('input', () => {
  depthValue.value = Number(depthInput.value).toFixed(2)
  depthInput.setAttribute('aria-valuetext', `${depthInput.value} model units`)
})

bevelWidthInput.addEventListener('input', () => {
  bevelWidthValue.value = Number(bevelWidthInput.value).toFixed(3)
  bevelWidthInput.setAttribute('aria-valuetext', `${bevelWidthInput.value} model units`)
})

edgeColorBlendInput.addEventListener('input', () => {
  edgeColorBlendValue.value = `${edgeColorBlendInput.value}%`
  edgeColorBlendInput.setAttribute('aria-valuetext', `${edgeColorBlendInput.value} percent`)
})

edgeCurveInput.addEventListener('input', () => {
  edgeCurveValue.value = `${edgeCurveInput.value}%`
  const segments = 1 + Math.round(Number(edgeCurveInput.value) / 100 * 11)
  edgeCurveInput.setAttribute(
    'aria-valuetext',
    `${edgeCurveInput.value} percent, ${segments} bevel segments`,
  )
})

const conversionInputs = [depthInput, bevelWidthInput, edgeColorBlendInput, edgeCurveInput]
conversionInputs.forEach((input) => {
  input.addEventListener('change', () => scheduleConversion(true))
})

downloadLink.addEventListener('click', (event) => {
  if (downloadLink.getAttribute('aria-disabled') === 'true') {
    event.preventDefault()
  }
})

environmentToggle.addEventListener('click', () => {
  environment = environment === 'dark' ? 'light' : 'dark'
  viewer.setEnvironment(environment)
  const isLight = environment === 'light'
  viewerPanel.dataset.environment = environment
  environmentToggle.dataset.environment = environment
  environmentToggle.setAttribute('aria-checked', String(isLight))
})

depthInput.setAttribute('aria-valuetext', `${depthInput.value} model units`)
bevelWidthInput.setAttribute('aria-valuetext', `${bevelWidthInput.value} model units`)
edgeColorBlendInput.setAttribute('aria-valuetext', `${edgeColorBlendInput.value} percent`)
edgeCurveInput.setAttribute('aria-valuetext', '55 percent, 7 bevel segments')

window.addEventListener('beforeunload', () => {
  if (result) URL.revokeObjectURL(result.previewUrl)
  viewer.dispose()
})

void loadSample()
