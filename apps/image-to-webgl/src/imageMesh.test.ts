import { describe, expect, it } from 'vitest'
import {
  BufferGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Shape,
} from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  alphaMaskFromImageData,
  correctExtrudeCapNormals,
  dilateOpaqueColors,
  formatFileSize,
  validatePngFile,
} from './imageMesh.ts'

function imageDataWithAlpha(alpha: number[], width = alpha.length): ImageData {
  const data = new Uint8ClampedArray(alpha.length * 4)
  alpha.forEach((value, index) => {
    data[index * 4 + 3] = value
  })
  return { data, width, height: alpha.length / width, colorSpace: 'srgb' } as ImageData
}

function groupedGeometry(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ], 3))
  geometry.setAttribute('normal', new Float32BufferAttribute([
    0.2, 0.1, 0.9,
    -0.2, 0.1, 0.9,
    0.1, -0.2, -0.9,
    0.25, 0.75, 0.5,
    0.5, 0.25, 0.75,
    0.75, 0.5, 0.25,
  ], 3))
  geometry.setAttribute('uv', new Float32BufferAttribute([
    0, 0,
    1, 0,
    0, 1,
    0, 0,
    0, 1,
    1, 1,
  ], 2))
  geometry.addGroup(0, 3, 0)
  geometry.addGroup(3, 3, 1)
  return geometry
}

describe('correctExtrudeCapNormals', () => {
  it('corrects every cap group in a creased, beveled multi-shape extrusion without changing side normals', () => {
    const concaveShape = new Shape()
      .moveTo(0, 0)
      .lineTo(3, 0)
      .lineTo(3, 1)
      .lineTo(1, 1)
      .lineTo(1, 3)
      .lineTo(0, 3)
      .lineTo(0, 0)
    const disconnectedShape = new Shape()
      .moveTo(5, 0)
      .lineTo(7, 0)
      .lineTo(7, 2)
      .lineTo(5, 2)
      .lineTo(5, 0)
    const source = new ExtrudeGeometry([concaveShape, disconnectedShape], {
      depth: 0.4,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.15,
      bevelThickness: 0.15,
    })
    const geometry = toCreasedNormals(source, Math.PI / 4)
    const normals = geometry.getAttribute('normal')
    const rawNormals = new Float32Array(normals.array)
    const positionsBefore = Array.from(geometry.getAttribute('position').array)
    const uvsBefore = Array.from(geometry.getAttribute('uv').array)
    const groupsBefore = geometry.groups.map((group) => ({ ...group }))
    const capGroups = geometry.groups.filter((group) => group.materialIndex === 0)

    expect(capGroups.length).toBeGreaterThan(1)
    expect(capGroups.some((group) => {
      for (let vertex = group.start; vertex < group.start + group.count; vertex += 1) {
        const offset = vertex * 3
        if (
          rawNormals[offset] !== 0 ||
          rawNormals[offset + 1] !== 0 ||
          Math.abs(rawNormals[offset + 2]) < 1
        ) {
          return true
        }
      }
      return false
    })).toBe(true)

    correctExtrudeCapNormals(geometry)

    let traversedCapGroups = 0
    for (const group of geometry.groups) {
      if (group.materialIndex === 0) traversedCapGroups += 1
      for (let vertex = group.start; vertex < group.start + group.count; vertex += 1) {
        const offset = vertex * 3
        if (group.materialIndex === 0) {
          expect([
            normals.getX(vertex),
            normals.getY(vertex),
            normals.getZ(vertex),
          ]).toEqual([0, 0, rawNormals[offset + 2] > 0 ? 1 : -1])
        } else {
          expect(normals.getX(vertex)).toBe(rawNormals[offset])
          expect(normals.getY(vertex)).toBe(rawNormals[offset + 1])
          expect(normals.getZ(vertex)).toBe(rawNormals[offset + 2])
        }
      }
    }
    expect(traversedCapGroups).toBe(capGroups.length)
    expect(traversedCapGroups).toBeGreaterThan(1)
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(positionsBefore)
    expect(Array.from(geometry.getAttribute('uv').array)).toEqual(uvsBefore)
    expect(geometry.groups).toEqual(groupsBefore)
    expect(geometry.index).toBeNull()

    source.dispose()
    geometry.dispose()
  })

  it('makes cap normals exactly planar without changing side normals or other geometry data', () => {
    const geometry = groupedGeometry()
    const position = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    const groups = geometry.groups.map((group) => ({ ...group }))
    const normal = geometry.getAttribute('normal')
    const sideNormals = Array.from(normal.array).slice(9)

    correctExtrudeCapNormals(geometry)

    expect(Array.from(normal.array).slice(0, 9)).toEqual([
      0, 0, 1,
      0, 0, 1,
      0, 0, -1,
    ])
    expect(Array.from(normal.array).slice(9)).toEqual(sideNormals)
    expect(geometry.getAttribute('position')).toBe(position)
    expect(geometry.getAttribute('uv')).toBe(uv)
    expect(geometry.groups).toEqual(groups)
    expect(geometry.index).toBeNull()
  })

  it('rejects missing or invalid normal and group data', () => {
    const indexed = groupedGeometry()
    indexed.setIndex([0, 1, 2, 3, 4, 5])
    expect(() => correctExtrudeCapNormals(indexed)).toThrow(/non-indexed/)

    const missingNormals = groupedGeometry()
    missingNormals.deleteAttribute('normal')
    expect(() => correctExtrudeCapNormals(missingNormals)).toThrow(/vertex normals/)

    const missingGroups = groupedGeometry()
    missingGroups.clearGroups()
    expect(() => correctExtrudeCapNormals(missingGroups)).toThrow(/material groups/)

    const invalidGroup = groupedGeometry()
    invalidGroup.groups[1].count = 4
    expect(() => correctExtrudeCapNormals(invalidGroup)).toThrow(/group range/)

    const overlappingGroups = groupedGeometry()
    overlappingGroups.groups[1].start = 0
    expect(() => correctExtrudeCapNormals(overlappingGroups)).toThrow(/must not overlap/)

    const uncoveredVertices = groupedGeometry()
    uncoveredVertices.groups[1].count = 0
    expect(() => correctExtrudeCapNormals(uncoveredVertices)).toThrow(/group range/)

    const unexpectedMaterial = groupedGeometry()
    unexpectedMaterial.groups[1].materialIndex = 2
    expect(() => correctExtrudeCapNormals(unexpectedMaterial)).toThrow(/material index/)

    const invalidNormal = groupedGeometry()
    invalidNormal.getAttribute('normal').setX(4, Number.NaN)
    expect(() => correctExtrudeCapNormals(invalidNormal)).toThrow(/invalid vertex normal/)

    const unorientedCap = groupedGeometry()
    const normalsBefore = Array.from(unorientedCap.getAttribute('normal').array)
    unorientedCap.getAttribute('normal').setZ(2, 0)
    expect(() => correctExtrudeCapNormals(unorientedCap)).toThrow(/no front\/back orientation/)
    expect(Array.from(unorientedCap.getAttribute('normal').array)).toEqual([
      ...normalsBefore.slice(0, 8),
      0,
      ...normalsBefore.slice(9),
    ])
  })
})

describe('alphaMaskFromImageData', () => {
  it('applies the configured alpha threshold', () => {
    const mask = alphaMaskFromImageData(imageDataWithAlpha([0, 15, 16, 255]), 16)
    expect([...mask]).toEqual([0, 0, 1, 1])
  })

  describe('dilateOpaqueColors', () => {
    it('extends the nearest opaque color into the padded region', () => {
      const data = new Uint8ClampedArray([
        0, 0, 0, 0,
        10, 20, 30, 255,
        0, 0, 0, 0,
      ])

      dilateOpaqueColors(data, 3, 1, 16, 1)

      expect([...data]).toEqual([
        10, 20, 30, 255,
        10, 20, 30, 255,
        10, 20, 30, 255,
      ])
    })

    describe('formatFileSize', () => {
      it('formats bytes, kilobytes, and megabytes for display', () => {
        expect(formatFileSize(840)).toBe('840 B')
        expect(formatFileSize(8 * 1024)).toBe('8.0 KB')
        expect(formatFileSize(256 * 1024)).toBe('256 KB')
        expect(formatFileSize(1.25 * 1024 * 1024)).toBe('1.3 MB')
      })

      it('rejects invalid file sizes', () => {
        expect(() => formatFileSize(-1)).toThrow(/non-negative/)
      })
    })

    it('respects the maximum expansion distance', () => {
      const data = new Uint8ClampedArray([
        50, 60, 70, 255,
        0, 0, 0, 0,
        0, 0, 0, 0,
      ])

      dilateOpaqueColors(data, 3, 1, 16, 1)

      expect([...data.slice(4, 7)]).toEqual([50, 60, 70])
      expect([...data.slice(8, 11)]).toEqual([0, 0, 0])
    })
  })

  it('rejects an entirely transparent image', () => {
    expect(() => alphaMaskFromImageData(imageDataWithAlpha([0, 0]), 16))
      .toThrow(/no visible pixels/)
  })

  it('rejects an image without a transparent background', () => {
    expect(() => alphaMaskFromImageData(imageDataWithAlpha([255, 255]), 16))
      .toThrow(/no transparent background/)
  })

  it('rejects an invalid threshold', () => {
    expect(() => alphaMaskFromImageData(imageDataWithAlpha([0, 255]), 256))
      .toThrow(/between 0 and 255/)
  })

  it('rejects transparency that does not reach the image boundary', () => {
    expect(() => alphaMaskFromImageData(imageDataWithAlpha([
      255, 255, 255,
      255, 0, 255,
      255, 255, 255,
    ], 3), 16)).toThrow(/outside edge/)
  })
})

describe('validatePngFile', () => {
  it('accepts a file with the PNG signature', async () => {
    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])],
      'sample.png',
      { type: 'image/png' },
    )

    await expect(validatePngFile(file)).resolves.toBeUndefined()
  })

  it('rejects a renamed non-PNG file', async () => {
    const file = new File(
      [new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70])],
      'renamed.png',
      { type: 'image/png' },
    )

    await expect(validatePngFile(file)).rejects.toThrow(/not a valid PNG/)
  })
})
