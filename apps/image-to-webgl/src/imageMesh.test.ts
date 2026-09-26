import { describe, expect, it } from 'vitest'
import {
  alphaMaskFromImageData,
  dilateOpaqueColors,
  formatFileSize,
} from './imageMesh.ts'

function imageDataWithAlpha(alpha: number[]): ImageData {
  const data = new Uint8ClampedArray(alpha.length * 4)
  alpha.forEach((value, index) => {
    data[index * 4 + 3] = value
  })
  return { data, width: alpha.length, height: 1, colorSpace: 'srgb' } as ImageData
}

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
})
