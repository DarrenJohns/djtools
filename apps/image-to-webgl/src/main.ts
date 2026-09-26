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
        <h1>Turn a transparent PNG into a WebGL object.</h1>
        <p class="intro">
          Trace the image silhouette, add real depth, preserve the artwork as a texture,
          and export a self-contained GLB. Everything runs locally in your browser.
        </p>
      </div>

      <form id="converter-form">
        <label class="file-picker">
          <span>Source PNG</span>
          <input id="source-file" type="file" accept="image/png,.png">
          <strong id="file-name">Prism ring sample</strong>
        </label>

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

        <label class="range-control" for="edge-color-blend">
          <span>Edge color blend</span>
          <output id="edge-color-blend-value" for="edge-color-blend">60%</output>
          <input id="edge-color-blend" type="range" min="0" max="100" step="5" value="60">
        </label>

        <label class="range-control" for="edge-curve">
          <span>Edge curve</span>
          <output id="edge-curve-value" for="edge-curve">55%</output>
          <input id="edge-curve" type="range" min="0" max="100" step="5" value="55">
        </label>

        <button id="convert-button" type="submit">Update</button>
      </form>

      <div id="status" class="status" role="status" aria-live="polite">
        Loading the local sample...
      </div>

      <a id="download-link" class="download-link" hidden>Download GLB</a>

      <aside class="scope-note">
        <strong>Prototype boundary</strong>
        <span>Designed for PNG artwork with a transparent background. It extrudes a reliable
          silhouette; it does not guess the hidden sides of a photographed object.</span>
      </aside>

      <footer class="project-credit">
        <span>Brought to you by</span>
        <a href="https://github.com/DarrenJohns/djtools" target="_blank" rel="noreferrer">
          DJ Tools
        </a>
        <span class="version">v0.0.1</span>
      </footer>
    </section>

    <section class="viewer-panel" aria-label="Interactive 3D preview">
      <div id="viewer"></div>
      <button
        id="environment-toggle"
        class="environment-toggle"
        type="button"
        aria-pressed="false"
      >
        <span class="environment-icon" aria-hidden="true">☀</span>
        <span class="environment-label">Light environment</span>
      </button>
      <div class="viewer-hint">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
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

const form = requiredElement<HTMLFormElement>('#converter-form')
const fileInput = requiredElement<HTMLInputElement>('#source-file')
const fileName = requiredElement<HTMLElement>('#file-name')
const depthInput = requiredElement<HTMLInputElement>('#depth')
const depthValue = requiredElement<HTMLOutputElement>('#depth-value')
const bevelWidthInput = requiredElement<HTMLInputElement>('#bevel-width')
const bevelWidthValue = requiredElement<HTMLOutputElement>('#bevel-width-value')
const edgeColorBlendInput = requiredElement<HTMLInputElement>('#edge-color-blend')
const edgeColorBlendValue = requiredElement<HTMLOutputElement>('#edge-color-blend-value')
const edgeCurveInput = requiredElement<HTMLInputElement>('#edge-curve')
const edgeCurveValue = requiredElement<HTMLOutputElement>('#edge-curve-value')
const convertButton = requiredElement<HTMLButtonElement>('#convert-button')
const status = requiredElement<HTMLElement>('#status')
const downloadLink = requiredElement<HTMLAnchorElement>('#download-link')
const viewerContainer = requiredElement<HTMLElement>('#viewer')
const environmentToggle = requiredElement<HTMLButtonElement>('#environment-toggle')
const environmentIcon = requiredElement<HTMLElement>('.environment-icon')
const environmentLabel = requiredElement<HTMLElement>('.environment-label')

const viewer = new ModelViewer(viewerContainer)
let environment: 'dark' | 'light' = 'dark'
let sourceFile: File | null = null
let result: ConversionResult | null = null

function setStatus(message: string, kind: 'working' | 'success' | 'error' = 'working'): void {
  status.textContent = message
  status.dataset.kind = kind
}

function setSourceFile(file: File): void {
  sourceFile = file
  fileName.textContent = file.name
  downloadLink.hidden = true
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}sample/prism-ring.png`)
    if (!response.ok) {
      throw new Error(`Sample request failed with HTTP ${response.status}.`)
    }
    const blob = await response.blob()
    setSourceFile(new File([blob], 'prism-ring.png', { type: 'image/png' }))
    await convert()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown sample loading error.'
    setStatus(`Could not load the sample: ${message}`, 'error')
  }
}

async function convert(): Promise<void> {
  if (!sourceFile) {
    setStatus('Choose a transparent PNG before building the asset.', 'error')
    return
  }

  convertButton.disabled = true
  downloadLink.hidden = true
  setStatus('Tracing silhouette and building GLB...', 'working')

  try {
    if (result) URL.revokeObjectURL(result.previewUrl)
    result = await convertImageToGlb(sourceFile, {
      depth: Number(depthInput.value),
      bevelWidth: Number(bevelWidthInput.value),
      edgeColorBlend: Number(edgeColorBlendInput.value) / 100,
      edgeCurve: Number(edgeCurveInput.value) / 100,
    })
    await viewer.loadGlb(result.glb)
    downloadLink.href = result.previewUrl
    downloadLink.download = `${sourceFile.name.replace(/\.png$/i, '')}.glb`
    downloadLink.hidden = false
    setStatus(
      `${result.contourCount} contours · ${Math.round(result.triangleCount).toLocaleString()} tris · ${formatFileSize(result.glb.byteLength)} GLB`,
      'success',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown conversion error.'
    setStatus(message, 'error')
  } finally {
    convertButton.disabled = false
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) setSourceFile(file)
})

depthInput.addEventListener('input', () => {
  depthValue.value = Number(depthInput.value).toFixed(2)
})

bevelWidthInput.addEventListener('input', () => {
  bevelWidthValue.value = Number(bevelWidthInput.value).toFixed(3)
})

edgeColorBlendInput.addEventListener('input', () => {
  edgeColorBlendValue.value = `${edgeColorBlendInput.value}%`
})

edgeCurveInput.addEventListener('input', () => {
  edgeCurveValue.value = `${edgeCurveInput.value}%`
})

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void convert()
})

environmentToggle.addEventListener('click', () => {
  environment = environment === 'dark' ? 'light' : 'dark'
  viewer.setEnvironment(environment)
  const isLight = environment === 'light'
  environmentToggle.setAttribute('aria-pressed', String(isLight))
  environmentToggle.dataset.environment = environment
  environmentIcon.textContent = isLight ? '☾' : '☀'
  environmentLabel.textContent = isLight ? 'Dark environment' : 'Light environment'
})

window.addEventListener('beforeunload', () => {
  if (result) URL.revokeObjectURL(result.previewUrl)
  viewer.dispose()
})

void loadSample()
