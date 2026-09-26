import { describe, expect, it } from 'vitest'
import { contoursToShapes, traceContours } from './contours.ts'

function maskFromRows(rows: string[]): Uint8Array {
  return Uint8Array.from(rows.join('').split('').map((value) => value === '1' ? 1 : 0))
}

describe('traceContours', () => {
  it('traces one closed contour around a filled rectangle', () => {
    const mask = maskFromRows([
      '00000',
      '01110',
      '01110',
      '00000',
    ])

    const contours = traceContours(mask, 5, 4, 0)

    expect(contours).toHaveLength(1)
    expect(contours[0].depth).toBe(0)
    expect(contours[0].parent).toBeNull()
    expect(contours[0].points).toHaveLength(4)
  })
  it('preserves a transparent hole inside a solid silhouette', () => {
    const mask = maskFromRows([
      '0000000',
      '0111110',
      '0111110',
      '0110110',
      '0111110',
      '0111110',
      '0000000',
    ])

    const contours = traceContours(mask, 7, 7, 0)
    const shapes = contoursToShapes(contours, 7, 7)

    expect(contours).toHaveLength(2)
    expect(contours.map(({ depth }) => depth).sort()).toEqual([0, 1])
    expect(shapes).toHaveLength(1)
    expect(shapes[0].holes).toHaveLength(1)
  })

  it('rejects a mask whose dimensions do not match its data', () => {
    expect(() => traceContours(new Uint8Array(3), 2, 2)).toThrow(/does not match/)
  })
})
