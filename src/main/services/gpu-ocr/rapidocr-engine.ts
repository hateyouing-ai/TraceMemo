/**
 * RapidOCR PP-OCRv4（ONNX Runtime）。
 *
 * 会话创建按 DirectML → CUDA → CPU 的顺序试。索引是否把结果当成「GPU 可用」
 * 由调用方决定：只有 dml / cuda 才算加速成功。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GPU_OCR_MODEL_NAMES, type GpuOcrRecognizeResult } from '../../../shared/gpu-ocr'
import { normalizeSystemOcrText } from '../../../shared/system-ocr'
import { decodeImageRaster } from './image-raster'
import {
  boxesFromProbabilityMap,
  buildDetTensor,
  cropToRecTensor,
  greedyCtc,
  mapBoxToSource,
  parseCharacterDict,
  tensorDataOf,
  tensorDimsOf,
  type Raster
} from './rapidocr-postprocess'

export interface OrtTensorLike {
  data: ArrayLike<number>
  dims: number[]
}

export interface OrtSessionLike {
  inputNames?: string[]
  outputNames?: string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface OrtModuleLike {
  Tensor: new (type: string, data: Float32Array, dims: readonly number[]) => unknown
  InferenceSession: {
    create(modelPath: string, options?: { executionProviders?: string[] }): Promise<OrtSessionLike>
  }
}

export interface RapidOcrEngineOptions {
  modelDir: string
  providers: string[]
  recBatchSize?: number
  recMaxWidth?: number
  detLimitSide?: number
  allowCpu?: boolean
  loadOrt?: () => Promise<OrtModuleLike | null>
  readFile?: (filePath: string) => Buffer
  decodeImage?: (buffer: Buffer) => Raster | null
}

const defaultLoadOrt = async (): Promise<OrtModuleLike | null> => {
  try {
    const loaded = (await import('onnxruntime-node')) as unknown as OrtModuleLike
    if (!loaded?.InferenceSession || !loaded?.Tensor) return null
    return loaded
  } catch {
    return null
  }
}

const failure = (
  errorCode: GpuOcrRecognizeResult['errorCode'],
  error: string,
  provider: string | null
): GpuOcrRecognizeResult => ({
  success: false,
  text: '',
  lines: [],
  provider,
  errorCode,
  error
})

async function openSession(
  ort: OrtModuleLike,
  modelPath: string,
  provider: string
): Promise<OrtSessionLike> {
  return ort.InferenceSession.create(modelPath, { executionProviders: [provider] })
}

export class RapidOcrEngine {
  readonly provider: string

  private constructor(
    private readonly ort: OrtModuleLike,
    private readonly det: OrtSessionLike,
    private readonly rec: OrtSessionLike,
    private readonly dict: string[],
    provider: string,
    private readonly options: {
      recBatchSize: number
      recMaxWidth: number
      detLimitSide: number
      decodeImage: (buffer: Buffer) => Raster | null
    }
  ) {
    this.provider = provider
  }

  static async create(options: RapidOcrEngineOptions): Promise<RapidOcrEngine> {
    const readFile = options.readFile ?? readFileSync
    const detPath = join(options.modelDir, GPU_OCR_MODEL_NAMES.det)
    const recPath = join(options.modelDir, GPU_OCR_MODEL_NAMES.rec)
    const keysPath = join(options.modelDir, GPU_OCR_MODEL_NAMES.keys)
    if (!existsSync(detPath) || !existsSync(recPath) || !existsSync(keysPath)) {
      throw new Error('RapidOCR 模型文件不完整')
    }
    const ort = (await (options.loadOrt ?? defaultLoadOrt)()) ?? null
    if (!ort) throw new Error('onnxruntime-node 不可用')
    const dict = parseCharacterDict(readFile(keysPath).toString('utf8'))
    if (!dict.length) throw new Error('RapidOCR 字典为空')

    let lastError: Error | null = null
    for (const provider of options.providers) {
      if (
        provider === 'cpu' &&
        options.allowCpu !== true &&
        options.providers.some((item) => item !== 'cpu')
      ) {
        continue
      }
      try {
        const det = await openSession(ort, detPath, provider)
        const rec = await openSession(ort, recPath, provider)
        return new RapidOcrEngine(ort, det, rec, dict, provider, {
          recBatchSize: options.recBatchSize ?? 8,
          recMaxWidth: options.recMaxWidth ?? 640,
          detLimitSide: options.detLimitSide ?? 960,
          decodeImage: options.decodeImage ?? decodeImageRaster
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw lastError ?? new Error('没有可用的 ONNX 执行提供程序')
  }

  async recognize(image: Buffer): Promise<GpuOcrRecognizeResult> {
    const raster = this.options.decodeImage(image)
    if (!raster || raster.width < 2 || raster.height < 2) {
      return failure('IMAGE_DECODE_FAILED', '图片无法解码', this.provider)
    }
    try {
      const detTensor = buildDetTensor(raster, this.options.detLimitSide)
      const detOutput = await this.run(this.det, detTensor.data, detTensor.height, detTensor.width)
      const map = probabilityMap(detOutput, detTensor.height, detTensor.width)
      const boxes = boxesFromProbabilityMap(map)
        .map((box) => mapBoxToSource(box, detTensor.ratioX, detTensor.ratioY, raster))
        .filter((box) => box.width >= 2 && box.height >= 2)
      if (!boxes.length)
        return failure('OCR_EMPTY_RESULT', '没有在这张图片里识别到文字。', this.provider)

      const lines: string[] = []
      for (let index = 0; index < boxes.length; index += this.options.recBatchSize) {
        const slice = boxes.slice(index, index + this.options.recBatchSize)
        const texts = await this.recognizeCrops(raster, slice)
        for (const text of texts) {
          const normalized = normalizeSystemOcrText(text)
          if (normalized) lines.push(normalized)
        }
      }
      if (!lines.length)
        return failure('OCR_EMPTY_RESULT', '没有在这张图片里识别到文字。', this.provider)
      return {
        success: true,
        text: lines.join('\n'),
        lines: lines.map((text) => ({ text })),
        provider: this.provider
      }
    } catch (error) {
      return failure(
        'OCR_FAILED',
        error instanceof Error ? error.message : 'OCR 执行失败',
        this.provider
      )
    }
  }

  private async recognizeCrops(
    raster: Raster,
    boxes: ReturnType<typeof mapBoxToSource>[]
  ): Promise<string[]> {
    const crops = boxes.map((box) => cropToRecTensor(raster, box, this.options.recMaxWidth))
    try {
      return await this.recognizeBatch(crops)
    } catch {
      const texts: string[] = []
      for (const crop of crops) texts.push((await this.recognizeBatch([crop]))[0] ?? '')
      return texts
    }
  }

  private async recognizeBatch(
    crops: Array<{ data: Float32Array; width: number; height: number }>
  ): Promise<string[]> {
    const height = 48
    const width = Math.max(...crops.map((crop) => crop.width))
    const batch = crops.length
    const plane = width * height
    const packed = new Float32Array(batch * 3 * plane)
    crops.forEach((crop, index) => {
      const sourcePlane = crop.width * height
      for (let channel = 0; channel < 3; channel += 1) {
        for (let y = 0; y < height; y += 1) {
          const from = channel * sourcePlane + y * crop.width
          const to = index * 3 * plane + channel * plane + y * width
          packed.set(crop.data.subarray(from, from + crop.width), to)
        }
      }
    })
    const output = await this.run(this.rec, packed, height, width, batch)
    const dims = output.dims.length
      ? output.dims
      : [
          batch,
          Math.floor(output.data.length / batch / (this.dict.length + 1)),
          this.dict.length + 1
        ]
    const classes = dims[dims.length - 1]
    const timeSteps = dims.length >= 2 ? dims[dims.length - 2] : 1
    const texts: string[] = []
    for (let index = 0; index < batch; index += 1) {
      const offset = index * timeSteps * classes
      texts.push(
        greedyCtc(
          output.data.subarray(offset, offset + timeSteps * classes),
          timeSteps,
          classes,
          this.dict
        )
      )
    }
    return texts
  }

  private async run(
    session: OrtSessionLike,
    data: Float32Array,
    height: number,
    width: number,
    batch = 1
  ): Promise<{ data: Float32Array; dims: number[] }> {
    const inputName = session.inputNames?.[0] ?? 'x'
    const outputName = session.outputNames?.[0] ?? 'fetch_name_0'
    const tensor = new this.ort.Tensor('float32', data, [batch, 3, height, width])
    const outputs = await session.run({ [inputName]: tensor })
    const output = outputs[outputName] ?? Object.values(outputs)[0]
    return { data: tensorDataOf(output), dims: tensorDimsOf(output) }
  }
}

function probabilityMap(
  output: { data: Float32Array; dims: number[] },
  fallbackHeight: number,
  fallbackWidth: number
): { data: Float32Array; width: number; height: number } {
  const dims = output.dims
  if (dims.length === 4) return { data: output.data, height: dims[2], width: dims[3] }
  if (dims.length === 3) return { data: output.data, height: dims[1], width: dims[2] }
  return { data: output.data, height: fallbackHeight, width: fallbackWidth }
}
