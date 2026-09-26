import { Path, Shape, Vector2 } from 'three'

export interface Point {
  x: number
  y: number
}

export interface Contour {
  points: Point[]
  parent: number | null
  depth: number
}

interface Edge {
  start: Point
  end: Point
}

const pointKey = ({ x, y }: Point): string => `${x},${y}`

function isFilled(mask: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 1
}

function addEdge(edgesByStart: Map<string, Edge[]>, start: Point, end: Point): void {
  const key = pointKey(start)
  const edges = edgesByStart.get(key)
  const edge = { start, end }
  if (edges) {
    edges.push(edge)
  } else {
    edgesByStart.set(key, [edge])
  }
}

function popEdge(edgesByStart: Map<string, Edge[]>, key: string): Edge | undefined {
  const edges = edgesByStart.get(key)
  const edge = edges?.pop()
  if (edges?.length === 0) {
    edgesByStart.delete(key)
  }
  return edge
}

function removeCollinear(points: Point[]): Point[] {
  if (points.length <= 3) return points

  return points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length]
    const next = points[(index + 1) % points.length]
    return (point.x - previous.x) * (next.y - point.y) !==
      (point.y - previous.y) * (next.x - point.x)
  })
}

function perpendicularDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y)
  }

  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) /
    Math.hypot(dx, dy)
}

function simplifyOpen(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points

  let maxDistance = 0
  let splitIndex = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points[points.length - 1])
    if (distance > maxDistance) {
      maxDistance = distance
      splitIndex = index
    }
  }

  if (maxDistance <= tolerance) {
    return [points[0], points[points.length - 1]]
  }

  const left = simplifyOpen(points.slice(0, splitIndex + 1), tolerance)
  const right = simplifyOpen(points.slice(splitIndex), tolerance)
  return [...left.slice(0, -1), ...right]
}

export function simplifyClosedContour(points: Point[], tolerance = 0.75): Point[] {
  const collinearRemoved = removeCollinear(points)
  if (collinearRemoved.length <= 3) return collinearRemoved

  const anchor = collinearRemoved[0]
  let splitIndex = 1
  let maxDistance = 0
  for (let index = 1; index < collinearRemoved.length; index += 1) {
    const distance = Math.hypot(
      collinearRemoved[index].x - anchor.x,
      collinearRemoved[index].y - anchor.y,
    )
    if (distance > maxDistance) {
      maxDistance = distance
      splitIndex = index
    }
  }

  const firstHalf = simplifyOpen(collinearRemoved.slice(0, splitIndex + 1), tolerance)
  const secondHalf = simplifyOpen(
    [...collinearRemoved.slice(splitIndex), anchor],
    tolerance,
  )
  return [...firstHalf.slice(0, -1), ...secondHalf.slice(0, -1)]
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]
    const b = polygon[previous]
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  }
  return inside
}

function polygonArea(points: Point[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const next = points[(index + 1) % points.length]
    area += point.x * next.y - next.x * point.y
  }
  return area / 2
}

export function traceContours(
  mask: Uint8Array,
  width: number,
  height: number,
  simplifyTolerance = 0.75,
): Contour[] {
  if (mask.length !== width * height) {
    throw new Error(`Mask size ${mask.length} does not match ${width} x ${height}.`)
  }

  const edgesByStart = new Map<string, Edge[]>()
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isFilled(mask, width, height, x, y)) continue

      if (!isFilled(mask, width, height, x, y - 1)) {
        addEdge(edgesByStart, { x, y }, { x: x + 1, y })
      }
      if (!isFilled(mask, width, height, x + 1, y)) {
        addEdge(edgesByStart, { x: x + 1, y }, { x: x + 1, y: y + 1 })
      }
      if (!isFilled(mask, width, height, x, y + 1)) {
        addEdge(edgesByStart, { x: x + 1, y: y + 1 }, { x, y: y + 1 })
      }
      if (!isFilled(mask, width, height, x - 1, y)) {
        addEdge(edgesByStart, { x, y: y + 1 }, { x, y })
      }
    }
  }

  const loops: Point[][] = []
  while (edgesByStart.size > 0) {
    const firstKey = edgesByStart.keys().next().value as string
    const firstEdge = popEdge(edgesByStart, firstKey)
    if (!firstEdge) break

    const points = [firstEdge.start]
    let current = firstEdge.end
    while (pointKey(current) !== firstKey) {
      points.push(current)
      const next = popEdge(edgesByStart, pointKey(current))
      if (!next) {
        throw new Error('The alpha silhouette produced an open contour.')
      }
      current = next.end
    }

    const simplified = simplifyClosedContour(points, simplifyTolerance)
    if (simplified.length >= 3 && Math.abs(polygonArea(simplified)) >= 1) {
      loops.push(simplified)
    }
  }

  const areas = loops.map((loop) => Math.abs(polygonArea(loop)))
  const contours: Contour[] = loops.map((points, index) => {
    let parent: number | null = null
    let parentArea = Number.POSITIVE_INFINITY
    for (let candidate = 0; candidate < loops.length; candidate += 1) {
      if (candidate === index || areas[candidate] <= areas[index]) continue
      if (areas[candidate] < parentArea && pointInPolygon(points[0], loops[candidate])) {
        parent = candidate
        parentArea = areas[candidate]
      }
    }
    return { points, parent, depth: 0 }
  })

  const getDepth = (index: number): number => {
    const parent = contours[index].parent
    return parent === null ? 0 : getDepth(parent) + 1
  }
  contours.forEach((contour, index) => {
    contour.depth = getDepth(index)
  })

  return contours
}

function toVector(point: Point, height: number, scale: number): Vector2 {
  return new Vector2(point.x / scale, (height - point.y) / scale)
}

export function contoursToShapes(
  contours: Contour[],
  width: number,
  height: number,
): Shape[] {
  const scale = Math.max(width, height)
  const shapes: Shape[] = []

  contours.forEach((contour, index) => {
    if (contour.depth % 2 !== 0) return

    const vectors = contour.points.map((point) => toVector(point, height, scale))
    const shape = new Shape(vectors)
    contours.forEach((hole) => {
      if (hole.parent !== index || hole.depth !== contour.depth + 1) return
      const holePath = new Path(
        hole.points.map((point) => toVector(point, height, scale)),
      )
      shape.holes.push(holePath)
    })
    shapes.push(shape)
  })

  return shapes
}
