/**
 * GPU OCR 子进程。onnxruntime 原生崩溃只结束这个进程，Electron 主进程还在。
 */
import { RapidOcrEngine, type RapidOcrEngineOptions } from './rapidocr-engine'
import type { GpuOcrRecognizeResult } from '../../../shared/gpu-ocr'

interface InitMessage {
  id: number
  type: 'init'
  modelDir: string
  providers: string[]
  recBatchSize?: number
  recMaxWidth?: number
  detLimitSide?: number
  allowCpu?: boolean
}

interface RecognizeMessage {
  id: number
  type: 'recognize'
  image: Buffer
  fault?: 'exit'
}

interface ShutdownMessage {
  id: number
  type: 'shutdown'
}

type WorkerMessage = InitMessage | RecognizeMessage | ShutdownMessage

let engine: RapidOcrEngine | null = null

const send = (payload: Record<string, unknown>): void => {
  process.send?.(payload)
}

const fail = (id: number, error: string, fatal = false): void => {
  send({ id, ok: false, error, fatal })
}

process.on('message', (message: WorkerMessage) => {
  void handle(message)
})

async function handle(message: WorkerMessage): Promise<void> {
  if (message.type === 'shutdown') {
    send({ id: message.id, ok: true })
    process.exit(0)
  }
  if (message.type === 'init') {
    try {
      const options: RapidOcrEngineOptions = {
        modelDir: message.modelDir,
        providers: message.providers,
        recBatchSize: message.recBatchSize,
        recMaxWidth: message.recMaxWidth,
        detLimitSide: message.detLimitSide,
        allowCpu: message.allowCpu === true
      }
      engine = await RapidOcrEngine.create(options)
      send({ id: message.id, ok: true, provider: engine.provider })
    } catch (error) {
      fail(message.id, error instanceof Error ? error.message : String(error), true)
    }
    return
  }
  if (process.env['TRACEMEMO_OCR_FAULTS'] === '1' && message.fault === 'exit') {
    process.exit(99)
  }
  if (!engine) {
    fail(message.id, 'GPU OCR 尚未初始化', true)
    return
  }
  const result: GpuOcrRecognizeResult = await engine.recognize(message.image)
  send({ id: message.id, ok: true, result })
}
