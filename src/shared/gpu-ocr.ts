/**
 * GPU OCR（RapidOCR / PP-OCRv4 ONNX）契约。
 *
 * Windows 上默认执行提供程序是 DirectML，而不是 CUDA：
 * 官方 `onnxruntime-node` 预编译包带 DirectML，不带 CUDA EP。
 * RTX 4060 Ti（驱动 32.0.15.6094）可以直接用这套 DirectML，不必再装 CUDA Toolkit。
 * `TRACEMEMO_OCR_EP=cuda` 只在用户自行换上带 CUDA 的 onnxruntime 时才有意义。
 */

export const GPU_OCR_ENGINE_ID = 'rapidocr-onnx-dml'

export const GPU_OCR_MODEL_NAMES = {
  det: 'ch_PP-OCRv4_det_infer.onnx',
  rec: 'ch_PP-OCRv4_rec_infer.onnx',
  cls: 'ch_ppocr_mobile_v2.0_cls_infer.onnx',
  keys: 'ppocr_keys_v1.txt'
} as const

export type GpuOcrErrorCode =
  | 'GPU_OCR_UNAVAILABLE'
  | 'IMAGE_DECODE_FAILED'
  | 'OCR_FAILED'
  | 'OCR_EMPTY_RESULT'

export interface GpuOcrLine {
  text: string
}

export interface GpuOcrRecognizeResult {
  success: boolean
  text: string
  lines: GpuOcrLine[]
  /** 实际会话用上的执行提供程序，例如 dml / cuda / cpu。不可用时为 null。 */
  provider: string | null
  errorCode?: GpuOcrErrorCode
  error?: string
}

export type GpuOcrExecutionProviderName = 'dml' | 'cuda' | 'cpu'

/**
 * 执行提供程序尝试顺序。
 *
 * Windows 默认 DirectML → CPU。CPU 只作为会话创建失败时的探测，
 * 索引路径不会把「只有 CPU」当成 GPU 可用（除非 `TRACEMEMO_OCR_ALLOW_CPU=1`）。
 */
export function gpuOcrProviderOrder(input: {
  platform: string
  override?: string | null
}): GpuOcrExecutionProviderName[] {
  const override = String(input.override ?? '')
    .trim()
    .toLowerCase()
  if (override === 'cpu') return ['cpu']
  if (override === 'cuda') return ['cuda', 'cpu']
  if (override === 'dml') return ['dml', 'cpu']
  if (input.platform === 'win32') return ['dml', 'cpu']
  return ['cpu']
}

export function gpuOcrProviderIsAccelerated(provider: string | null | undefined): boolean {
  return provider === 'dml' || provider === 'cuda'
}
