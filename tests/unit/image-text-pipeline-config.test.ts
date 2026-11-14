import { describe, expect, it } from 'vitest'
import {
  resolveImageTextPipeline,
  TARGET_IMAGE_TEXT_MACHINE
} from '../../src/shared/image-text-ocr-pipeline'
import { OCR_GPU_MODEL_FILES } from '../../src/shared/ocr-gpu-models'
import { gpuOcrProviderOrder } from '../../src/shared/gpu-ocr'

const stored = {
  engine: 'auto' as const,
  preset: 'auto' as const,
  ocrConcurrency: 0,
  prepareConcurrency: 0
}

describe('图片文字索引吞吐配置', () => {
  it('i5-14600K + Windows 的自动预设就是为这台电脑准备的全力模式', () => {
    const resolved = resolveImageTextPipeline({
      settings: stored,
      hardware: {
        logicalThreads: TARGET_IMAGE_TEXT_MACHINE.logicalThreads,
        cpuModel: 'Intel(R) Core(TM) i5-14600K',
        platform: 'win32'
      }
    })
    expect(resolved.mode).toBe('full-power')
    expect(resolved.targetMachinePreset).toBe(true)
    expect(resolved.gpuRequested).toBe(true)
    expect(resolved.prepareConcurrency).toBe(12)
    expect(resolved.ocrConcurrency).toBe(4)
    expect(resolved.gpuWorkerCount).toBe(2)
    expect(resolved.readBatchSize).toBe(64)
    expect(resolved.persistBatchSize).toBe(32)
    expect(resolved.yieldBetweenBatches).toBe(false)
    expect(resolved.summary).toContain('针对此台电脑')
  })

  it('同一台 CPU 若指定系统 OCR，识别并发提到 8 而不是 GPU 队列深度', () => {
    const resolved = resolveImageTextPipeline({
      settings: { ...stored, engine: 'system' },
      hardware: {
        logicalThreads: 20,
        cpuModel: '12th Gen Intel(R) Core(TM) i5-14600K',
        platform: 'win32'
      }
    })
    expect(resolved.gpuRequested).toBe(false)
    expect(resolved.ocrConcurrency).toBe(8)
    expect(resolved.prepareConcurrency).toBe(12)
  })

  it('非目标机器的自动预设保持均衡，并尊重显式并发', () => {
    const resolved = resolveImageTextPipeline({
      settings: { ...stored, ocrConcurrency: 3, prepareConcurrency: 5 },
      hardware: { logicalThreads: 4, cpuModel: 'Intel(R) Xeon(R)', platform: 'linux' },
      explicitOcrConcurrency: 6
    })
    expect(resolved.mode).toBe('balanced')
    expect(resolved.targetMachinePreset).toBe(false)
    expect(resolved.ocrConcurrency).toBe(6)
    expect(resolved.prepareConcurrency).toBe(5)
    expect(resolved.yieldBetweenBatches).toBe(true)
    expect(resolved.readBatchSize).toBe(24)
  })

  it('用户可以在别的 CPU 上强制全力，也可以在 14600K 上改回均衡', () => {
    const forced = resolveImageTextPipeline({
      settings: { ...stored, preset: 'full-power' },
      hardware: { logicalThreads: 8, cpuModel: 'Apple M2', platform: 'darwin' }
    })
    expect(forced.mode).toBe('full-power')
    expect(forced.prepareConcurrency).toBe(12)
    const balanced = resolveImageTextPipeline({
      settings: { ...stored, preset: 'balanced' },
      hardware: { logicalThreads: 20, cpuModel: 'i5-14600K', platform: 'win32' }
    })
    expect(balanced.mode).toBe('balanced')
    expect(balanced.yieldBetweenBatches).toBe(true)
  })

  it('Windows 默认先试 DirectML，CUDA 只有显式指定才排第一', () => {
    expect(gpuOcrProviderOrder({ platform: 'win32' })).toEqual(['dml', 'cpu'])
    expect(gpuOcrProviderOrder({ platform: 'win32', override: 'cuda' })).toEqual(['cuda', 'cpu'])
    expect(gpuOcrProviderOrder({ platform: 'linux' })).toEqual(['cpu'])
  })

  it('模型清单带检测和识别的校验值', () => {
    const det = OCR_GPU_MODEL_FILES.find((file) => file.role === 'det')
    const rec = OCR_GPU_MODEL_FILES.find((file) => file.role === 'rec')
    expect(det?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(rec?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(det?.urls[0]).toContain('ch_PP-OCRv4_det_infer.onnx')
  })
})
