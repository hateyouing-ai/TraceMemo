import { describe, expect, it } from 'vitest'
import {
  boxesFromProbabilityMap,
  greedyCtc,
  parseCharacterDict
} from '../../src/main/services/gpu-ocr/rapidocr-postprocess'

describe('RapidOCR 后处理', () => {
  it('概率图里的一块高响应变成一个框，背景噪声被丢掉', () => {
    const width = 16
    const height = 16
    const data = new Float32Array(width * height)
    for (let y = 4; y < 8; y += 1) {
      for (let x = 2; x < 7; x += 1) data[y * width + x] = 0.95
    }
    data[0] = 0.2
    const boxes = boxesFromProbabilityMap({ data, width, height })
    expect(boxes).toHaveLength(1)
    expect(boxes[0].x).toBeLessThanOrEqual(2)
    expect(boxes[0].y).toBeLessThanOrEqual(4)
    expect(boxes[0].width).toBeGreaterThanOrEqual(5)
    expect(boxes[0].score).toBeGreaterThan(0.9)
  })

  it('CTC 会去掉 blank 和重复时间步', () => {
    const dict = parseCharacterDict('报\n价\n')
    const classes = 3
    const steps = [
      [1, 0, 0],
      [0, 9, 0],
      [0, 8, 0],
      [0, 0, 7],
      [1, 0, 0]
    ]
    const logits = Float32Array.from(steps.flat())
    expect(greedyCtc(logits, steps.length, classes, dict)).toBe('报价')
  })
})
