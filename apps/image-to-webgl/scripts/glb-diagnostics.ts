import { Mesh, Texture } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

interface TextureSample {
  x: number
  y: number
}

export async function inspectExportedGlb(
  glb: ArrayBuffer,
  textureSamples: TextureSample[],
  sourceSize: { width: number; height: number },
) {
  const loaded = await new GLTFLoader().parseAsync(glb.slice(0), '')
  let capTriangles = 0
  let sideTriangles = 0
  let capVertices = 0
  let sideVertices = 0
  const sideDirections = new Set<string>()
  let sideMinZ = Infinity
  let sideMaxZ = -Infinity
  let texture: Texture | null = null

  loaded.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return
    const position = object.geometry.getAttribute('position')
    const normal = object.geometry.getAttribute('normal')
    if (!position || !normal || position.count !== normal.count) {
      throw new Error('Reloaded GLB mesh has invalid position or normal data.')
    }

    const index = object.geometry.index
    const vertexAt = (triangleOffset: number) => (
      index ? index.getX(triangleOffset) : triangleOffset
    )
    const triangleCount = (index?.count ?? position.count) / 3
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const indices = [0, 1, 2].map((corner) => vertexAt(triangle * 3 + corner))
      const z = indices.map((vertex) => position.getZ(vertex))
      const isCap = Math.max(...z) - Math.min(...z) < 1e-7

      if (isCap) capTriangles += 1
      else sideTriangles += 1

      for (const vertex of indices) {
        const x = normal.getX(vertex)
        const y = normal.getY(vertex)
        const normalZ = normal.getZ(vertex)
        if (isCap) {
          capVertices += 1
          if (x !== 0 || y !== 0 || Math.abs(normalZ) !== 1) {
            throw new Error(
              `Reloaded cap normal is not exact: ${x}, ${y}, ${normalZ}.`,
            )
          }
        } else {
          sideVertices += 1
          sideMinZ = Math.min(sideMinZ, normalZ)
          sideMaxZ = Math.max(sideMaxZ, normalZ)
          sideDirections.add(
            `${x.toFixed(4)},${y.toFixed(4)},${normalZ.toFixed(4)}`,
          )
        }
      }
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) {
      if ('map' in material && material.map instanceof Texture) {
        texture ??= material.map
      }
    }
  })

  if (!texture?.image) {
    throw new Error('Reloaded GLB has no embedded texture image.')
  }
  const image = texture.image as CanvasImageSource & { width: number; height: number }
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Could not inspect the reloaded GLB texture.')
  context.drawImage(image, 0, 0)
  const sampledPixels = textureSamples.map(({ x, y }) => {
    const textureX = Math.floor(x * canvas.width / sourceSize.width)
    const textureY = canvas.height - 1 -
      Math.floor(y * canvas.height / sourceSize.height)
    return {
      x,
      y,
      textureX,
      textureY,
      rgba: [...context.getImageData(textureX, textureY, 1, 1).data],
    }
  })

  loaded.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return
    object.geometry.dispose()
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) {
      if ('map' in material && material.map instanceof Texture) material.map.dispose()
      material.dispose()
    }
  })

  return {
    capTriangles,
    sideTriangles,
    capVertices,
    sideVertices,
    sideDirectionCount: sideDirections.size,
    sideMinZ,
    sideMaxZ,
    textureSize: { width: canvas.width, height: canvas.height },
    sampledPixels,
  }
}
