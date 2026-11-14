/**
 * 把 GPU OCR、解密线程池和流水线预设接到图片文字索引上。
 * `index.ts` 只负责把这里返回的依赖交给 `ImageTextIndexService`。
 */
import { GPU_OCR_ENGINE_ID } from '../../shared/gpu-ocr'
import {
  detectImageTextHardware,
  normalizeImageTextOcrSettings,
  resolveImageTextPipeline,
  type ImageTextHardwareProfile,
  type ImageTextOcrRuntimeSnapshot,
  type ImageTextOcrStoredSettings,
  type ResolvedImageTextPipeline
} from '../../shared/image-text-ocr-pipeline'
import type { ImageOcrProvenance } from '../../shared/image-text-index'
import { resolveSystemOcrEngine, type SystemOcrCapability } from '../../shared/system-ocr'
import { ImageTextPreparePool, type ImagePrepareRequest } from './image-text-prepare-pool'
import { ImageTextOcrRouter, type RoutedOcrResult } from './image-text-ocr-router'
import { forkGpuWorker, GpuOcrScheduler } from './gpu-ocr/gpu-ocr-host'
import { candidateOcrModelDirs, ensureOcrGpuModels } from './gpu-ocr/model-store'

export interface ImageTextOcrControllerDeps {
  platform: string
  logicalThreads: number
  cpuModel: string
  resourcesPath: string
  cwd: string
  userData: string
  loadSettings: () => ImageTextOcrStoredSettings
  saveSettings: (settings: ImageTextOcrStoredSettings) => void
  systemRecognize: (imageDataUrl: string) => Promise<{
    success: boolean
    text: string
    language: string | null
    errorCode?: string
  }>
  systemCapability: () => Promise<SystemOcrCapability>
  decryptMaterial: () => { aesKey: string; xorKey: number }
}

export class ImageTextOcrController {
  private pool: ImageTextPreparePool | null = null
  private scheduler: GpuOcrScheduler | null = null
  private probing: Promise<void> | null = null
  private systemCap: SystemOcrCapability | null = null
  private readonly router: ImageTextOcrRouter
  private gpuMessage = '尚未检测 GPU 文字识别'

  constructor(private readonly deps: ImageTextOcrControllerDeps) {
    this.router = new ImageTextOcrRouter({
      preference: () => this.settings().engine,
      system: (image) => deps.systemRecognize(image),
      systemProvenance: () => this.systemProvenance(),
      gpuProvenance: () => this.gpuProvenance(),
      probeGpu: () => this.probe(),
      recognizeGpu: async (image) => {
        const scheduler = this.scheduler
        if (!scheduler) {
          return {
            success: false,
            text: '',
            lines: [],
            provider: null,
            errorCode: 'GPU_OCR_UNAVAILABLE',
            error: this.gpuMessage
          }
        }
        return scheduler.recognize(image)
      },
      gpuStillAvailable: () => this.scheduler?.available !== false
    })
  }

  hardware(): ImageTextHardwareProfile {
    return detectImageTextHardware({
      platform: this.deps.platform,
      threads: this.deps.logicalThreads,
      cpuModel: this.deps.cpuModel
    })
  }

  settings(): ImageTextOcrStoredSettings {
    return normalizeImageTextOcrSettings(this.deps.loadSettings())
  }

  pipeline(): ResolvedImageTextPipeline {
    const explicit = Number(process.env['TRACEMEMO_OCR_CONCURRENCY'])
    return resolveImageTextPipeline({
      settings: this.settings(),
      hardware: this.hardware(),
      explicitOcrConcurrency: Number.isFinite(explicit) && explicit >= 1 ? explicit : null
    })
  }

  updateSettings(patch: Partial<ImageTextOcrStoredSettings>): ImageTextOcrStoredSettings {
    const next = normalizeImageTextOcrSettings({ ...this.settings(), ...patch })
    this.deps.saveSettings(next)
    this.router.resetProbe()
    void this.disposeScheduler()
    return next
  }

  async snapshot(): Promise<ImageTextOcrRuntimeSnapshot> {
    const pipeline = this.pipeline()
    if (pipeline.gpuRequested) await this.probe()
    const settings = this.settings()
    const gpuAvailable = this.scheduler?.available === true
    const activeEngineLabel = gpuAvailable ? 'RapidOCR · DirectML' : '系统 OCR'
    return {
      settings,
      resolved: pipeline,
      gpuAvailable,
      gpuMessage: this.gpuMessage,
      activeEngineLabel,
      fallbackNotice: this.router.fallbackNotice
    }
  }

  prepareOffThread(
    request: ImagePrepareRequest
  ): Promise<import('./image-text-prepare-core').ImagePrepareCoreResult> {
    const pool = this.ensurePool(this.pipeline().prepareConcurrency)
    return pool.submit(request)
  }

  async recognize(imageDataUrl: string): Promise<RoutedOcrResult> {
    await this.ensureSystemCapability()
    return this.router.recognize(imageDataUrl)
  }

  engineNotice(): string | undefined {
    return this.router.fallbackNotice ?? undefined
  }

  async ocrReady(): Promise<{ available: boolean; message?: string }> {
    const pipeline = this.pipeline()
    const system = await this.ensureSystemCapability()
    if (!pipeline.gpuRequested) {
      return {
        available: system.available,
        ...(system.available ? {} : { message: system.message })
      }
    }
    const probe = await this.probe()
    if (probe.available || system.available) return { available: true }
    return {
      available: false,
      message: probe.message || system.message || 'GPU 和系统 OCR 都不可用'
    }
  }

  currentProvenance(): ImageOcrProvenance | null {
    if (this.settings().engine === 'system') return null
    if (this.scheduler?.available) return this.gpuProvenance()
    if (this.router.fallbackNotice) return null
    return null
  }

  private ensurePool(size: number): ImageTextPreparePool {
    if (!this.pool) {
      this.pool = new ImageTextPreparePool(size, () => this.deps.decryptMaterial())
    } else {
      this.pool.resize(size)
    }
    return this.pool
  }

  private async probe(): Promise<{ available: boolean; message: string }> {
    if (this.scheduler?.available) {
      return { available: true, message: this.gpuMessage }
    }
    if (this.probing) {
      await this.probing
      return { available: this.scheduler?.available === true, message: this.gpuMessage }
    }
    this.probing = this.probeUncached().finally(() => {
      this.probing = null
    })
    await this.probing
    return { available: this.scheduler?.available === true, message: this.gpuMessage }
  }

  private async probeUncached(): Promise<void> {
    const pipeline = this.pipeline()
    const downloadDir = candidateOcrModelDirs({ userData: this.deps.userData }).at(-1) ?? null
    const located = await ensureOcrGpuModels({
      directories: candidateOcrModelDirs({
        envDir: process.env['TRACEMEMO_OCR_MODEL_DIR'],
        resourcesPath: this.deps.resourcesPath,
        cwd: this.deps.cwd,
        userData: this.deps.userData
      }),
      downloadDir,
      allowDownload: process.env['TRACEMEMO_OCR_SKIP_DOWNLOAD'] !== '1'
    })
    if (!located.directory) {
      this.gpuMessage = located.error || 'RapidOCR 模型不可用，已改用系统 OCR。'
      this.router.fallbackNotice = `${this.gpuMessage}索引会继续。`
      return
    }
    try {
      const scheduler = await GpuOcrScheduler.open({
        workerCount: pipeline.gpuWorkerCount,
        createWorker: () =>
          forkGpuWorker({
            modelDir: located.directory as string,
            pipeline,
            platform: this.deps.platform,
            allowCpu: process.env['TRACEMEMO_OCR_ALLOW_CPU'] === '1'
          })
      })
      this.scheduler = scheduler
      this.gpuMessage = scheduler.available
        ? scheduler.message
        : `${scheduler.message} 已改用系统 OCR。`
      if (!scheduler.available) this.router.fallbackNotice = `${this.gpuMessage}索引会继续。`
    } catch (error) {
      this.gpuMessage = error instanceof Error ? error.message : 'GPU OCR 初始化失败'
      this.router.fallbackNotice = `${this.gpuMessage}，已改用系统 OCR。索引会继续。`
    }
  }

  private async ensureSystemCapability(): Promise<SystemOcrCapability> {
    if (!this.systemCap) this.systemCap = await this.deps.systemCapability()
    return this.systemCap
  }

  private systemProvenance(): ImageOcrProvenance {
    const capability = this.systemCap
    return {
      engine: capability?.engine ?? resolveSystemOcrEngine(process.platform),
      platform: capability?.platform ?? process.platform,
      runtimeVersion: capability?.runtimeVersion ?? null,
      language: capability?.language ?? null
    }
  }

  private gpuProvenance(): ImageOcrProvenance {
    return {
      engine: GPU_OCR_ENGINE_ID,
      platform: process.platform,
      runtimeVersion: this.scheduler?.provider ?? 'pp-ocrv4',
      language: 'zh'
    }
  }

  private async disposeScheduler(): Promise<void> {
    const scheduler = this.scheduler
    this.scheduler = null
    if (scheduler) await scheduler.dispose()
  }
}
