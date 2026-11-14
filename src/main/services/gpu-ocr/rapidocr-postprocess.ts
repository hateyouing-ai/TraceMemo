/**
 * PP-OCRv4 的纯计算部分：缩放、检测框、CTC 解码。
 * 不加载 onnxruntime，单测可以直接喂张量。
 */

export interface Raster {
  width: number
  height: number
  /** RGBA，每像素 4 字节。 */
  rgba: Uint8Array
}

export interface OcrBox {
  x: number
  y: number
  width: number
  height: number
  score: number
}

export interface DetTensor {
  data: Float32Array
  width: number
  height: number
  ratioX: number
  ratioY: number
}

const multipleOf32 = (value: number): number => Math.max(32, Math.ceil(value / 32) * 32)

export function resizeRgba(source: Raster, dstWidth: number, dstHeight: number): Uint8Array {
  const rgba = new Uint8Array(dstWidth * dstHeight * 4)
  const xScale = source.width / dstWidth
  const yScale = source.height / dstHeight
  for (let y = 0; y < dstHeight; y += 1) {
    const srcY = Math.min(source.height - 1, Math.floor(y * yScale))
    for (let x = 0; x < dstWidth; x += 1) {
      const srcX = Math.min(source.width - 1, Math.floor(x * xScale))
      const from = (srcY * source.width + srcX) * 4
      const to = (y * dstWidth + x) * 4
      rgba[to] = source.rgba[from]
      rgba[to + 1] = source.rgba[from + 1]
      rgba[to + 2] = source.rgba[from + 2]
      rgba[to + 3] = source.rgba[from + 3]
    }
  }
  return rgba
}

/** PaddleOCR 的 (pixel / 255 - 0.5) / 0.5，NCHW。 */
export function rgbaToNchw(rgba: Uint8Array, width: number, height: number): Float32Array {
  const plane = width * height
  const out = new Float32Array(3 * plane)
  for (let index = 0; index < plane; index += 1) {
    const pixel = index * 4
    out[index] = (rgba[pixel] / 255) * 2 - 1
    out[plane + index] = (rgba[pixel + 1] / 255) * 2 - 1
    out[2 * plane + index] = (rgba[pixel + 2] / 255) * 2 - 1
  }
  return out
}

export function buildDetTensor(source: Raster, limitSide = 960): DetTensor {
  const longSide = Math.max(source.width, source.height)
  const scale = longSide > limitSide ? limitSide / longSide : 1
  const resizedWidth = Math.max(1, Math.round(source.width * scale))
  const resizedHeight = Math.max(1, Math.round(source.height * scale))
  const width = multipleOf32(resizedWidth)
  const height = multipleOf32(resizedHeight)
  const resized = resizeRgba(source, resizedWidth, resizedHeight)
  const canvas = new Uint8Array(width * height * 4)
  for (let y = 0; y < resizedHeight; y += 1) {
    const from = y * resizedWidth * 4
    canvas.set(resized.subarray(from, from + resizedWidth * 4), y * width * 4)
  }
  return {
    data: rgbaToNchw(canvas, width, height),
    width,
    height,
    ratioX: source.width / resizedWidth,
    ratioY: source.height / resizedHeight
  }
}

export function boxesFromProbabilityMap(input: {
  data: ArrayLike<number>
  width: number
  height: number
  threshold?: number
  minScore?: number
  minSize?: number
}): OcrBox[] {
  const width = input.width
  const height = input.height
  const threshold = input.threshold ?? 0.3
  const minScore = input.minScore ?? 0.5
  const minSize = input.minSize ?? 3
  const seen = new Uint8Array(width * height)
  const boxes: OcrBox[] = []
  const stack: number[] = []

  for (let start = 0; start < seen.length; start += 1) {
    if (seen[start] || input.data[start] < threshold) continue
    stack.push(start)
    seen[start] = 1
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let score = 0
    let count = 0
    while (stack.length) {
      const index = stack.pop() as number
      const x = index % width
      const y = Math.floor(index / width)
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      score += Number(input.data[index])
      count += 1
      const neighbors = [index - 1, index + 1, index - width, index + width]
      for (const next of neighbors) {
        if (next < 0 || next >= seen.length || seen[next]) continue
        const nextX = next % width
        if (Math.abs(nextX - x) + Math.abs(Math.floor(next / width) - y) !== 1) continue
        if (input.data[next] < threshold) continue
        seen[next] = 1
        stack.push(next)
      }
    }
    const boxWidth = maxX - minX + 1
    const boxHeight = maxY - minY + 1
    const mean = count > 0 ? score / count : 0
    if (boxWidth < minSize || boxHeight < minSize || mean < minScore) continue
    const padX = Math.max(1, Math.round(boxWidth * 0.08))
    const padY = Math.max(1, Math.round(boxHeight * 0.15))
    const x = Math.max(0, minX - padX)
    const y = Math.max(0, minY - padY)
    boxes.push({
      x,
      y,
      width: Math.min(width - x, boxWidth + padX * 2),
      height: Math.min(height - y, boxHeight + padY * 2),
      score: mean
    })
  }

  boxes.sort((left, right) => left.y - right.y || left.x - right.x)
  return boxes
}

export function mapBoxToSource(
  box: OcrBox,
  ratioX: number,
  ratioY: number,
  source: Raster
): OcrBox {
  const x = Math.max(0, Math.floor(box.x * ratioX))
  const y = Math.max(0, Math.floor(box.y * ratioY))
  const width = Math.max(1, Math.min(source.width - x, Math.ceil(box.width * ratioX)))
  const height = Math.max(1, Math.min(source.height - y, Math.ceil(box.height * ratioY)))
  return { x, y, width, height, score: box.score }
}

export interface RecTensor {
  data: Float32Array
  width: number
  height: number
}

export function cropToRecTensor(source: Raster, box: OcrBox, maxWidth: number): RecTensor {
  const targetHeight = 48
  const rawWidth = Math.max(1, Math.round((box.width / Math.max(1, box.height)) * targetHeight))
  const width = Math.max(8, Math.min(maxWidth, rawWidth))
  const cropped = new Uint8Array(width * targetHeight * 4)
  for (let y = 0; y < targetHeight; y += 1) {
    const srcY = Math.min(source.height - 1, box.y + Math.floor((y * box.height) / targetHeight))
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(source.width - 1, box.x + Math.floor((x * box.width) / width))
      const from = (srcY * source.width + srcX) * 4
      const to = (y * width + x) * 4
      cropped[to] = source.rgba[from]
      cropped[to + 1] = source.rgba[from + 1]
      cropped[to + 2] = source.rgba[from + 2]
      cropped[to + 3] = 255
    }
  }
  return { data: rgbaToNchw(cropped, width, targetHeight), width, height: targetHeight }
}

export function greedyCtc(
  logits: ArrayLike<number>,
  timeSteps: number,
  classes: number,
  dict: readonly string[]
): string {
  let text = ''
  let previous = -1
  for (let time = 0; time < timeSteps; time += 1) {
    let best = 0
    let bestValue = Number.NEGATIVE_INFINITY
    const offset = time * classes
    for (let label = 0; label < classes; label += 1) {
      const value = Number(logits[offset + label])
      if (value > bestValue) {
        bestValue = value
        best = label
      }
    }
    if (best !== 0 && best !== previous) {
      const character = dict[best - 1]
      if (character) text += character
    }
    previous = best
  }
  return text
}

export function parseCharacterDict(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function tensorDimsOf(value: unknown): number[] {
  if (!value || typeof value !== 'object') return []
  const dims = (value as { dims?: unknown }).dims
  return Array.isArray(dims) ? dims.map((item) => Number(item)) : []
}

export function tensorDataOf(value: unknown): Float32Array {
  if (!value || typeof value !== 'object') return new Float32Array()
  const data = (value as { data?: unknown }).data
  if (data instanceof Float32Array) return data
  if (ArrayBuffer.isView(data)) return Float32Array.from(data as unknown as ArrayLike<number>)
  if (Array.isArray(data)) return Float32Array.from(data)
  return new Float32Array()
}
