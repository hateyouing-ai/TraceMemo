import { describe, expect, it, vi } from 'vitest'
import { ImageTextOcrRouter } from '../../src/main/services/image-text-ocr-router'
import type { ImageOcrProvenance } from '../../src/shared/image-text-index'

const systemProvenance: ImageOcrProvenance = {
  engine: 'windows-system-ocr',
  platform: 'win32',
  runtimeVersion: '1.2.0',
  language: 'zh-Hans-CN'
}
const gpuProvenance: ImageOcrProvenance = {
  engine: 'rapidocr-onnx-dml',
  platform: 'win32',
  runtimeVersion: 'dml',
  language: 'zh'
}

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('GPU OCR 回退', () => {
  it('GPU 探测失败时改走系统 OCR，并留下给 UI 的提示', async () => {
    const system = vi.fn(async () => ({ success: true, text: '系统', language: 'zh-Hans-CN' }))
    const router = new ImageTextOcrRouter({
      preference: () => 'auto',
      system,
      systemProvenance: () => systemProvenance,
      gpuProvenance: () => gpuProvenance,
      probeGpu: async () => ({ available: false, message: '未找到 RapidOCR 模型。' }),
      recognizeGpu: async () => {
        throw new Error('不应该调用 GPU')
      }
    })
    const result = await router.recognize(png)
    expect(result.text).toBe('系统')
    expect(result.provenance.engine).toBe('windows-system-ocr')
    expect(router.fallbackNotice).toContain('RapidOCR')
    expect(system).toHaveBeenCalledTimes(1)
  })

  it('GPU 可用时不调用系统 OCR', async () => {
    const system = vi.fn(async () => ({ success: true, text: '系统', language: null }))
    const router = new ImageTextOcrRouter({
      preference: () => 'gpu',
      system,
      systemProvenance: () => systemProvenance,
      gpuProvenance: () => ({ ...gpuProvenance }),
      probeGpu: async () => ({ available: true, message: 'ok' }),
      recognizeGpu: async () => ({
        success: true,
        text: '报价 128',
        lines: [{ text: '报价 128' }],
        provider: 'dml'
      })
    })
    const result = await router.recognize(png)
    expect(result.text).toBe('报价 128')
    expect(result.provenance.engine).toBe('rapidocr-onnx-dml')
    expect(result.provenance.runtimeVersion).toBe('dml')
    expect(system).not.toHaveBeenCalled()
    expect(router.fallbackNotice).toBeNull()
  })

  it('指定系统 OCR 时不探测 GPU', async () => {
    const probeGpu = vi.fn(async () => ({ available: true, message: 'ok' }))
    const router = new ImageTextOcrRouter({
      preference: () => 'system',
      system: async () => ({ success: true, text: '仅系统', language: null }),
      systemProvenance: () => systemProvenance,
      gpuProvenance: () => gpuProvenance,
      probeGpu,
      recognizeGpu: async () => {
        throw new Error('no gpu')
      }
    })
    const result = await router.recognize(png)
    expect(result.text).toBe('仅系统')
    expect(probeGpu).not.toHaveBeenCalled()
  })
})
