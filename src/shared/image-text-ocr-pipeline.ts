/**
 * 图片文字索引的吞吐配置。
 *
 * 旧的 `resolveImageTextOcrConcurrency` 仍把显式覆盖收敛到 1..4，
 * 那是系统 OCR 时代「共享 libuv 池」的上限，测试和 `TRACEMEMO_OCR_CONCURRENCY`
 * 的对照实验继续走那条路径。
 *
 * 生产环境的全力 / 自动调优走本模块：解密线程池、GPU 流水线深度、
 * 读批大小和派生库批量提交彼此独立，不再共用那个上限。
 */

export type ImageTextOcrEnginePreference = 'auto' | 'gpu' | 'system'

export type ImageTextOcrPreset = 'auto' | 'balanced' | 'full-power'

export interface ImageTextOcrStoredSettings {
  engine: ImageTextOcrEnginePreference
  preset: ImageTextOcrPreset
  /**
   * 0 = 按预设计算。大于 0 时作为识别并发 / GPU 流水线深度的显式覆盖。
   */
  ocrConcurrency: number
  /** 0 = 按预设计算。大于 0 时作为解密 / 定位线程数的显式覆盖。 */
  prepareConcurrency: number
}

export interface ImageTextHardwareProfile {
  logicalThreads: number
  cpuModel: string
  platform: string
}

/**
 * 这台电脑的硬件画像。全力预设的数字是按它定的，不是通用「线程数 × 2」。
 *
 * - Windows 11 x64，build 26100
 * - Intel Core i5-14600K：6 个性能核 + 8 个能效核，20 个逻辑线程
 * - NVIDIA GeForce RTX 4060 Ti，驱动 32.0.15.6094
 */
export const TARGET_IMAGE_TEXT_MACHINE = {
  os: 'Windows 11 x64 (build 26100)',
  cpu: 'Intel Core i5-14600K',
  logicalThreads: 20,
  gpu: 'NVIDIA GeForce RTX 4060 Ti',
  driver: '32.0.15.6094'
} as const

export const IMAGE_TEXT_OCR_CONCURRENCY_CAP = 32
export const IMAGE_TEXT_PREPARE_CONCURRENCY_CAP = 16

export interface ResolvedImageTextPipeline {
  mode: 'full-power' | 'balanced'
  /**
   * auto 预设因为识别到 i5-14600K（Windows）而套用了为这台电脑准备的全力参数。
   * 用户显式选择「全力」时同样为 true，即使 CPU 型号对不上。
   */
  targetMachinePreset: boolean
  gpuRequested: boolean
  ocrConcurrency: number
  prepareConcurrency: number
  readBatchSize: number
  persistBatchSize: number
  yieldBetweenBatches: boolean
  /** DirectML 会话进程数。一块 4060 Ti 上 2 个就够重叠预处理，再多只会抢同一块 GPU。 */
  gpuWorkerCount: number
  /** 同一张图里，识别模型一次送进去的文本行数。 */
  recBatchSize: number
  recMaxWidth: number
  detLimitSide: number
  summary: string
}

export interface ImageTextOcrRuntimeSnapshot {
  settings: ImageTextOcrStoredSettings
  resolved: ResolvedImageTextPipeline
  gpuAvailable: boolean
  gpuMessage: string
  activeEngineLabel: string
  fallbackNotice: string | null
}

const clampInt = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function isTargetFullPowerCpu(cpuModel: string, platform: string): boolean {
  return platform === 'win32' && /i5-14600k/i.test(cpuModel)
}

function storedConcurrency(value: unknown, cap: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(cap, Math.floor(parsed))
}

export function normalizeImageTextOcrSettings(
  raw?: Partial<ImageTextOcrStoredSettings> | null
): ImageTextOcrStoredSettings {
  const engine =
    raw?.engine === 'gpu' || raw?.engine === 'system' || raw?.engine === 'auto'
      ? raw.engine
      : 'auto'
  const preset =
    raw?.preset === 'full-power' || raw?.preset === 'balanced' || raw?.preset === 'auto'
      ? raw.preset
      : 'auto'
  return {
    engine,
    preset,
    ocrConcurrency: storedConcurrency(raw?.ocrConcurrency, IMAGE_TEXT_OCR_CONCURRENCY_CAP),
    prepareConcurrency: storedConcurrency(
      raw?.prepareConcurrency,
      IMAGE_TEXT_PREPARE_CONCURRENCY_CAP
    )
  }
}

export function resolveImageTextPipeline(input: {
  settings?: Partial<ImageTextOcrStoredSettings> | null
  hardware: ImageTextHardwareProfile
  explicitOcrConcurrency?: number | null
}): ResolvedImageTextPipeline {
  const settings = normalizeImageTextOcrSettings(input.settings)
  const threads = clampInt(input.hardware.logicalThreads || 1, 1, 256)
  const targetCpu = isTargetFullPowerCpu(input.hardware.cpuModel, input.hardware.platform)
  const mode: ResolvedImageTextPipeline['mode'] =
    settings.preset === 'full-power' || (settings.preset === 'auto' && targetCpu)
      ? 'full-power'
      : 'balanced'
  const gpuRequested = settings.engine !== 'system'
  const targetMachinePreset = mode === 'full-power'

  // 全力：给 14600K 留 8 个逻辑线程给 Electron、DirectML 驱动和系统，其余拿去解密。
  // 均衡：未知机器只拿一半线程，并且不超过 6，避免把交互打满。
  const presetPrepare = mode === 'full-power' ? 12 : clampInt(Math.floor(threads / 2), 2, 6)
  // GPU 路径的「并发」是流水线深度（喂饱一块 GPU），不是 20 个互相抢的会话。
  // 系统 OCR 没有 GPU，14600K 上 8 路 Windows.Media.Ocr 能吃满性能核；再往上收益会掉进争抢。
  const presetOcr =
    mode === 'full-power'
      ? gpuRequested
        ? 4
        : 8
      : gpuRequested
        ? 2
        : clampInt(Math.min(4, threads), 1, 4)

  const explicit = input.explicitOcrConcurrency
  const ocrConcurrency =
    typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 1
      ? clampInt(explicit, 1, IMAGE_TEXT_OCR_CONCURRENCY_CAP)
      : settings.ocrConcurrency > 0
        ? settings.ocrConcurrency
        : presetOcr
  const prepareConcurrency =
    settings.prepareConcurrency > 0 ? settings.prepareConcurrency : presetPrepare

  const readBatchSize = mode === 'full-power' ? 64 : 24
  const persistBatchSize = mode === 'full-power' ? 32 : 16
  const yieldBetweenBatches = mode !== 'full-power'
  const gpuWorkerCount = mode === 'full-power' ? 2 : 1
  const recBatchSize = mode === 'full-power' ? 8 : 4
  const recMaxWidth = mode === 'full-power' ? 640 : 320
  const detLimitSide = 960

  const machineNote = targetMachinePreset
    ? '针对此台电脑（i5-14600K + RTX 4060 Ti）的全力模式'
    : '均衡模式'
  const summary = [
    machineNote,
    `解密 ${prepareConcurrency} 路`,
    `识别队列 ${ocrConcurrency}`,
    gpuRequested ? `GPU 进程 ${gpuWorkerCount}` : '系统 OCR',
    `读批 ${readBatchSize}`,
    `写入批 ${persistBatchSize}`,
    yieldBetweenBatches ? '批间让出事件循环' : '批间不让出'
  ].join(' · ')

  return {
    mode,
    targetMachinePreset,
    gpuRequested,
    ocrConcurrency,
    prepareConcurrency,
    readBatchSize,
    persistBatchSize,
    yieldBetweenBatches,
    gpuWorkerCount,
    recBatchSize,
    recMaxWidth,
    detLimitSide,
    summary
  }
}

export function detectImageTextHardware(
  source: {
    platform?: string
    threads?: number
    cpuModel?: string
  } = {}
): ImageTextHardwareProfile {
  return {
    platform: source.platform ?? 'linux',
    logicalThreads: clampInt(source.threads ?? 1, 1, 256),
    cpuModel: source.cpuModel ?? ''
  }
}
