import {
  CanvasTexture,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Vector2,
  type ExtrudeGeometryOptions,
} from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { contoursToShapes, traceContours } from './contours.ts'

export interface ConversionOptions {
  depth: number
  bevelWidth?: number
  edgeCurve?: number
  edgeColorBlend?: number
  alphaThreshold?: number
  traceResolution?: number
}

export interface ConversionResult {
  glb: ArrayBuffer
  previewUrl: string
  contourCount: number
  triangleCount: number
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error('File size must be a non-negative finite number.')
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface PreparedImage {
  textureCanvas: HTMLCanvasElement
  traceData: ImageData
  sourceWidth: number
  sourceHeight: number
}

const DEFAULT_TRACE_RESOLUTION = 640
const DEFAULT_SIMPLIFY_TOLERANCE = 1.5
const SMOOTHING_CREASE_ANGLE = Math.PI / 4

function validateFile(file: File): void {
  if (file.type !== 'image/png') {
    throw new Error('This prototype requires a PNG file with a transparent background.')
  }
  if (file.size === 0) {
    throw new Error('The selected PNG is empty.')
  }
}

async function prepareImage(file: File, traceResolution: number): Promise<PreparedImage> {
  validateFile(file)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (error) {
    throw new Error('The selected file could not be decoded as a PNG.', { cause: error })
  }

  try {
    const longestSide = Math.max(bitmap.width, bitmap.height)
    if (longestSide === 0) {
      throw new Error('The selected PNG has invalid dimensions.')
    }

    const textureScale = Math.min(1, 2048 / longestSide)
    const textureCanvas = document.createElement('canvas')
    textureCanvas.width = Math.max(1, Math.round(bitmap.width * textureScale))
    textureCanvas.height = Math.max(1, Math.round(bitmap.height * textureScale))
    const textureContext = textureCanvas.getContext('2d', { willReadFrequently: true })
    if (!textureContext) throw new Error('The browser could not create a 2D texture canvas.')
    textureContext.drawImage(bitmap, 0, 0, textureCanvas.width, textureCanvas.height)

    const traceScale = Math.min(1, traceResolution / longestSide)
    const traceCanvas = document.createElement('canvas')
    traceCanvas.width = Math.max(1, Math.round(bitmap.width * traceScale))
    traceCanvas.height = Math.max(1, Math.round(bitmap.height * traceScale))
    const traceContext = traceCanvas.getContext('2d', { willReadFrequently: true })
    if (!traceContext) throw new Error('The browser could not create a contour canvas.')
    traceContext.drawImage(bitmap, 0, 0, traceCanvas.width, traceCanvas.height)

    return {
      textureCanvas,
      traceData: traceContext.getImageData(0, 0, traceCanvas.width, traceCanvas.height),
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
    }
  } finally {
    bitmap.close()
  }
}

export function alphaMaskFromImageData(imageData: ImageData, threshold: number): Uint8Array {
  if (threshold < 0 || threshold > 255) {
    throw new Error('Alpha threshold must be between 0 and 255.')
  }

  const mask = new Uint8Array(imageData.width * imageData.height)
  let filledPixels = 0
  for (let index = 0; index < mask.length; index += 1) {
    if (imageData.data[index * 4 + 3] >= threshold) {
      mask[index] = 1
      filledPixels += 1
    }
  }

  if (filledPixels === 0) {
    throw new Error('The PNG contains no visible pixels above the alpha threshold.')
  }
  if (filledPixels === mask.length) {
    throw new Error('The PNG has no transparent background to define a silhouette.')
  }
  return mask
}

export function dilateOpaqueColors(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number,
  maxDistance: number,
): void {
  const pixelCount = width * height
  if (data.length !== pixelCount * 4) {
    throw new Error('RGBA data length does not match its dimensions.')
  }

  const distance = new Int16Array(pixelCount)
  distance.fill(-1)
  const queue = new Int32Array(pixelCount)
  let head = 0
  let tail = 0

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (data[pixel * 4 + 3] >= alphaThreshold) {
      distance[pixel] = 0
      queue[tail] = pixel
      tail += 1
    }
  }

  const enqueue = (next: number, source: number): void => {
    if (distance[next] !== -1) return
    const offset = next * 4
    const sourceOffset = source * 4
    data[offset] = data[sourceOffset]
    data[offset + 1] = data[sourceOffset + 1]
    data[offset + 2] = data[sourceOffset + 2]
    data[offset + 3] = 255
    distance[next] = distance[source] + 1
    queue[tail] = next
    tail += 1
  }

  while (head < tail) {
    const pixel = queue[head]
    head += 1
    if (distance[pixel] >= maxDistance) continue

    const x = pixel % width
    const y = Math.floor(pixel / width)
    if (x > 0) enqueue(pixel - 1, pixel)
    if (x + 1 < width) enqueue(pixel + 1, pixel)
    if (y > 0) enqueue(pixel - width, pixel)
    if (y + 1 < height) enqueue(pixel + width, pixel)
  }
}

function createEdgeTextureCanvas(
  source: HTMLCanvasElement,
  alphaThreshold: number,
  bevelWidth: number,
  edgeColorBlend: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('The browser could not create an edge texture canvas.')
  context.drawImage(source, 0, 0)

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const padding = Math.ceil(bevelWidth * Math.max(canvas.width, canvas.height) * 2) + 12
  dilateOpaqueColors(
    imageData.data,
    imageData.width,
    imageData.height,
    alphaThreshold,
    padding,
  )
  context.putImageData(imageData, 0, 0)

  const smoothedCanvas = document.createElement('canvas')
  smoothedCanvas.width = canvas.width
  smoothedCanvas.height = canvas.height
  const smoothedContext = smoothedCanvas.getContext('2d')
  if (!smoothedContext) throw new Error('The browser could not smooth the edge texture.')
  const maximumBlur = Math.min(64, Math.max(canvas.width, canvas.height) * 0.035)
  smoothedContext.filter = `blur(${edgeColorBlend * maximumBlur}px)`
  smoothedContext.drawImage(canvas, 0, 0)
  smoothedContext.filter = 'none'
  smoothedContext.drawImage(source, 0, 0)

  const sourceContext = source.getContext('2d', { willReadFrequently: true })
  if (!sourceContext) throw new Error('The browser could not read the source texture.')
  const sourceData = sourceContext.getImageData(0, 0, source.width, source.height)
  const smoothedData = smoothedContext.getImageData(
    0,
    0,
    smoothedCanvas.width,
    smoothedCanvas.height,
  )
  for (let offset = 0; offset < sourceData.data.length; offset += 4) {
    if (sourceData.data[offset + 3] < alphaThreshold) continue
    smoothedData.data[offset] = sourceData.data[offset]
    smoothedData.data[offset + 1] = sourceData.data[offset + 1]
    smoothedData.data[offset + 2] = sourceData.data[offset + 2]
    smoothedData.data[offset + 3] = 255
  }
  smoothedContext.putImageData(smoothedData, 0, 0)
  return smoothedCanvas
}

function createUvGenerator(width: number, height: number): NonNullable<ExtrudeGeometryOptions['UVGenerator']> {
  return {
    generateTopUV: (_geometry, vertices, indexA, indexB, indexC) => {
      const uv = (index: number): Vector2 => {
        const vertexOffset = index * 3
        return new Vector2(
          vertices[vertexOffset] / width,
          vertices[vertexOffset + 1] / height,
        )
      }
      return [uv(indexA), uv(indexB), uv(indexC)]
    },
    generateSideWallUV: (_geometry, vertices, indexA, indexB, indexC, indexD) => {
      const uv = (index: number): Vector2 => {
        const vertexOffset = index * 3
        return new Vector2(
          vertices[vertexOffset] / width,
          vertices[vertexOffset + 1] / height,
        )
      }
      return [uv(indexA), uv(indexB), uv(indexC), uv(indexD)]
    },
  }
}

async function exportGlb(object: Group): Promise<ArrayBuffer> {
  const exporter = new GLTFExporter()
  const result = await exporter.parseAsync(object, {
    binary: true,
    onlyVisible: true,
  })
  if (!(result instanceof ArrayBuffer)) {
    throw new Error('GLB export unexpectedly returned JSON.')
  }
  return result
}

export async function convertImageToGlb(
  file: File,
  options: ConversionOptions,
): Promise<ConversionResult> {
  if (!Number.isFinite(options.depth) || options.depth <= 0 || options.depth > 0.5) {
    throw new Error('Depth must be greater than 0 and no more than 0.5.')
  }
  const bevelWidth = options.bevelWidth ?? 0.012
  if (!Number.isFinite(bevelWidth) || bevelWidth < 0 || bevelWidth > 0.06) {
    throw new Error('Edge width must be between 0 and 0.06.')
  }
  const edgeColorBlend = options.edgeColorBlend ?? 0.6
  if (!Number.isFinite(edgeColorBlend) || edgeColorBlend < 0 || edgeColorBlend > 1) {
    throw new Error('Edge color blend must be between 0 and 1.')
  }
  const edgeCurve = options.edgeCurve ?? 0.55
  if (!Number.isFinite(edgeCurve) || edgeCurve < 0 || edgeCurve > 1) {
    throw new Error('Edge curve must be between 0 and 1.')
  }
  const bevelSegments = 1 + Math.round(edgeCurve * 11)

  const alphaThreshold = options.alphaThreshold ?? 16
  const traceResolution = options.traceResolution ?? DEFAULT_TRACE_RESOLUTION
  const prepared = await prepareImage(file, traceResolution)
  const mask = alphaMaskFromImageData(prepared.traceData, alphaThreshold)
  const contours = traceContours(
    mask,
    prepared.traceData.width,
    prepared.traceData.height,
    DEFAULT_SIMPLIFY_TOLERANCE,
  )
  if (contours.length === 0) {
    throw new Error('No closed silhouette could be traced from the PNG.')
  }

  const shapes = contoursToShapes(
    contours,
    prepared.traceData.width,
    prepared.traceData.height,
  )
  if (shapes.length === 0) {
    throw new Error('The silhouette did not produce any solid shapes.')
  }

  const width = prepared.sourceWidth / Math.max(prepared.sourceWidth, prepared.sourceHeight)
  const height = prepared.sourceHeight / Math.max(prepared.sourceWidth, prepared.sourceHeight)
  const extrudedGeometry = new ExtrudeGeometry(shapes, {
    depth: options.depth,
    bevelEnabled: bevelWidth > 0,
    bevelSegments,
    bevelSize: bevelWidth,
    bevelThickness: Math.min(bevelWidth, options.depth * 0.45),
    curveSegments: 2,
    steps: 1,
    UVGenerator: createUvGenerator(width, height),
  })
  const geometry = toCreasedNormals(extrudedGeometry, SMOOTHING_CREASE_ANGLE)
  extrudedGeometry.dispose()
  geometry.translate(-width / 2, -height / 2, -options.depth / 2)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()

  const edgeTexture = new CanvasTexture(
    createEdgeTextureCanvas(
      prepared.textureCanvas,
      alphaThreshold,
      bevelWidth,
      edgeColorBlend,
    ),
  )
  edgeTexture.colorSpace = SRGBColorSpace
  edgeTexture.needsUpdate = true

  const material = new MeshStandardMaterial({
    map: edgeTexture,
    roughness: 0.62,
    metalness: 0.04,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = file.name.replace(/\.png$/i, '')
  mesh.castShadow = true
  mesh.receiveShadow = true

  const group = new Group()
  group.name = 'image-to-3d'
  group.add(mesh)

  try {
    const glb = await exportGlb(group)
    return {
      glb,
      previewUrl: URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' })),
      contourCount: contours.length,
      triangleCount: geometry.index
        ? geometry.index.count / 3
        : geometry.getAttribute('position').count / 3,
    }
  } finally {
    geometry.dispose()
    material.dispose()
    edgeTexture.dispose()
  }
}
