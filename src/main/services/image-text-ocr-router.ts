/**
 * 图片文字识别路由：优先 GPU（RapidOCR / DirectML），失败则回到系统 OCR。
 *
 * 初始化失败会记住提示，后面的图片不再反复探测。
 * 单张图把 GPU 进程打崩只影响这一张（调度器会重试一次），不会把整段索引切回系统 OCR，
 * 除非进程已经无法再拉起。
 */
import { GPU_OCR_ENGINE_ID, type GpuOcrRecognizeResult } from '../../shared/gpu-ocr'
import type { ImageTextOcrEnginePreference } from '../../shared/image-text-ocr-pipeline'
import type { ImageOcrProvenance } from '../../shared/image-text-index'
import { parseImageDataUrl } from '../../shared/system-ocr'

export interface RoutedOcrResult {
  success: boolean
  text: string
  language: string | null
  errorCode?: string
  provenance: ImageOcrProvenance
}

export interface ImageTextOcrRouterDeps {
  preference: () => ImageTextOcrEnginePreference
  system: (imageDataUrl: string) => Promise<{
    success: boolean
    text: string
    language: string | null
    errorCode?: string
  }>
  systemProvenance: () => ImageOcrProvenance
  gpuProvenance: () => ImageOcrProvenance
  probeGpu: () => Promise<{ available: boolean; message: string }>
  recognizeGpu: (image: Buffer) => Promise<GpuOcrRecognizeResult>
  gpuStillAvailable?: () => boolean
}

export class ImageTextOcrRouter {
  fallbackNotice: string | null = null
  private probed = false
  private gpuReady = false

  constructor(private readonly deps: ImageTextOcrRouterDeps) {}

  resetProbe(): void {
    this.probed = false
    this.gpuReady = false
  }

  async recognize(imageDataUrl: string): Promise<RoutedOcrResult> {
    const preference = this.deps.preference()
    if (preference !== 'system') {
      if (!this.probed) {
        const probe = await this.deps.probeGpu()
        this.probed = true
        this.gpuReady = probe.available
        if (!probe.available) {
          this.fallbackNotice = probe.message || 'GPU 文字识别不可用，已改用系统 OCR。索引会继续。'
        }
      } else if (this.deps.gpuStillAvailable && !this.deps.gpuStillAvailable()) {
        this.gpuReady = false
        if (!this.fallbackNotice) {
          this.fallbackNotice = 'GPU 文字识别进程无法继续，已改用系统 OCR。索引会继续。'
        }
      }
      if (this.gpuReady) {
        const parsed = parseImageDataUrl(imageDataUrl)
        if (!parsed) {
          return {
            success: false,
            text: '',
            language: 'zh',
            errorCode: 'IMAGE_DECODE_FAILED',
            provenance: this.deps.gpuProvenance()
          }
        }
        const result = await this.deps.recognizeGpu(Buffer.from(parsed.base64, 'base64'))
        if (result.errorCode === 'GPU_OCR_UNAVAILABLE') {
          this.gpuReady = false
          this.fallbackNotice = result.error || 'GPU 文字识别不可用，已改用系统 OCR。索引会继续。'
        } else {
          return this.fromGpu(result)
        }
      }
    }
    const system = await this.deps.system(imageDataUrl)
    return { ...system, provenance: this.deps.systemProvenance() }
  }

  private fromGpu(result: GpuOcrRecognizeResult): RoutedOcrResult {
    const provenance = this.deps.gpuProvenance()
    if (result.provider) provenance.runtimeVersion = result.provider
    if (result.success && result.text.trim()) {
      return { success: true, text: result.text, language: 'zh', provenance }
    }
    return {
      success: false,
      text: '',
      language: 'zh',
      errorCode: result.errorCode || 'OCR_FAILED',
      provenance
    }
  }
}

export function gpuProvenance(provider: string | null): ImageOcrProvenance {
  return {
    engine: GPU_OCR_ENGINE_ID,
    platform: process.platform,
    runtimeVersion: provider,
    language: 'zh'
  }
}
