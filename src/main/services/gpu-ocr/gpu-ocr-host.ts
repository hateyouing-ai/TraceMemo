/**
 * GPU OCR 进程池。
 *
 * 一张图把原生运行时打崩时：重启该进程，把这一张再试一次；
 * 第二次还崩就只把这一张记成失败，其它图片继续用新进程。
 * 进程彻底起不来时，`available` 变成 false，上层改回系统 OCR。
 */
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  gpuOcrProviderIsAccelerated,
  gpuOcrProviderOrder,
  type GpuOcrRecognizeResult
} from '../../../shared/gpu-ocr'
import type { ResolvedImageTextPipeline } from '../../../shared/image-text-ocr-pipeline'

export interface GpuWorkerClient {
  provider: string
  recognize(image: Buffer): Promise<GpuOcrRecognizeResult>
  dispose(): Promise<void>
}

export class GpuOcrScheduler {
  private readonly idle: GpuWorkerClient[] = []
  private readonly waiters: Array<(client: GpuWorkerClient) => void> = []
  private readonly live = new Set<GpuWorkerClient>()
  available = false
  provider: string | null = null
  message = 'GPU OCR 尚未探测'

  private constructor(
    private readonly workerCount: number,
    private readonly createWorker: () => Promise<GpuWorkerClient>
  ) {}

  static async open(options: {
    workerCount: number
    createWorker: () => Promise<GpuWorkerClient>
  }): Promise<GpuOcrScheduler> {
    const scheduler = new GpuOcrScheduler(Math.max(1, options.workerCount), options.createWorker)
    const started: GpuWorkerClient[] = []
    let lastError = 'GPU OCR 初始化失败'
    for (let index = 0; index < scheduler.workerCount; index += 1) {
      try {
        started.push(await options.createWorker())
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (!started.length) {
      scheduler.available = false
      scheduler.message = lastError
      return scheduler
    }
    for (const client of started) scheduler.add(client)
    scheduler.provider =
      started.find((client) => gpuOcrProviderIsAccelerated(client.provider))?.provider ??
      started[0].provider
    scheduler.available = true
    scheduler.message = `RapidOCR 正在使用 ${scheduler.provider}`
    return scheduler
  }

  async recognize(image: Buffer): Promise<GpuOcrRecognizeResult> {
    if (!this.available) {
      return {
        success: false,
        text: '',
        lines: [],
        provider: null,
        errorCode: 'GPU_OCR_UNAVAILABLE',
        error: this.message
      }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = await this.acquire()
      try {
        const result = await client.recognize(image)
        this.release(client)
        return result
      } catch (error) {
        this.drop(client)
        const replacement = await this.createWorker().catch(() => null)
        if (replacement) this.add(replacement)
        if (attempt === 1 || !replacement) {
          if (!this.live.size) {
            this.available = false
            this.message = 'GPU OCR 进程崩溃后无法重启，已停止使用 GPU。'
          }
          return {
            success: false,
            text: '',
            lines: [],
            provider: this.provider,
            errorCode: this.available ? 'OCR_FAILED' : 'GPU_OCR_UNAVAILABLE',
            error: error instanceof Error ? error.message : 'GPU OCR 进程崩溃'
          }
        }
      }
    }
    return {
      success: false,
      text: '',
      lines: [],
      provider: this.provider,
      errorCode: 'OCR_FAILED',
      error: 'GPU OCR 失败'
    }
  }

  async dispose(): Promise<void> {
    this.available = false
    const clients = Array.from(this.live)
    this.live.clear()
    this.idle.length = 0
    await Promise.all(clients.map((client) => client.dispose().catch(() => undefined)))
  }

  private add(client: GpuWorkerClient): void {
    this.live.add(client)
    this.release(client)
  }

  private drop(client: GpuWorkerClient): void {
    this.live.delete(client)
    const idleIndex = this.idle.indexOf(client)
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1)
    void client.dispose().catch(() => undefined)
  }

  private acquire(): Promise<GpuWorkerClient> {
    const client = this.idle.pop()
    if (client) return Promise.resolve(client)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(client: GpuWorkerClient): void {
    if (!this.live.has(client)) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(client)
    else this.idle.push(client)
  }
}

interface WorkerReply {
  id: number
  ok: boolean
  provider?: string
  result?: GpuOcrRecognizeResult
  error?: string
  fatal?: boolean
}

export function resolveGpuWorkerLaunch(moduleUrl: string = import.meta.url): {
  filename: string
  execArgv: string[]
} {
  const here = dirname(fileURLToPath(moduleUrl))
  const bundledCandidates = [join(here, 'gpuOcrWorker.js'), join(here, '../../gpuOcrWorker.js')]
  const bundled = bundledCandidates.find((candidate) => existsSync(candidate))
  if (bundled) return { filename: bundled, execArgv: [] }
  const source = join(here, 'gpu-ocr-worker.ts')
  const loader = join(here, '../../../../scripts/ts-worker-loader.mjs')
  return {
    filename: source,
    execArgv: ['--experimental-strip-types', `--import=${loader}`]
  }
}

export function forkGpuWorker(input: {
  modelDir: string
  pipeline: Pick<ResolvedImageTextPipeline, 'recBatchSize' | 'recMaxWidth' | 'detLimitSide'>
  platform: string
  allowCpu?: boolean
  launch?: { filename: string; execArgv: string[] }
}): Promise<GpuWorkerClient> {
  const launch = input.launch ?? resolveGpuWorkerLaunch()
  const providers = gpuOcrProviderOrder({
    platform: input.platform,
    override: process.env['TRACEMEMO_OCR_EP']
  })
  const child = fork(launch.filename, [], {
    execArgv: launch.execArgv,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  return new Promise((resolve, reject) => {
    const client = new ForkedGpuWorker(
      child,
      (provider) => {
        if (
          !gpuOcrProviderIsAccelerated(provider) &&
          input.allowCpu !== true &&
          provider === 'cpu'
        ) {
          void client.dispose()
          reject(new Error('ONNX 只有 CPU 执行提供程序，未把它当作 GPU。'))
          return
        }
        resolve(client)
      },
      reject
    )
    child.send({
      id: 1,
      type: 'init',
      modelDir: input.modelDir,
      providers,
      recBatchSize: input.pipeline.recBatchSize,
      recMaxWidth: input.pipeline.recMaxWidth,
      detLimitSide: input.pipeline.detLimitSide,
      allowCpu: input.allowCpu === true
    })
  })
}

class ForkedGpuWorker implements GpuWorkerClient {
  provider = ''
  private seq = 10
  private readonly pending = new Map<
    number,
    { resolve: (result: GpuOcrRecognizeResult) => void; reject: (error: Error) => void }
  >()
  private settled = false

  constructor(
    private readonly child: ChildProcess,
    private readonly onReady: (provider: string) => void,
    private readonly onInitError: (error: Error) => void
  ) {
    child.on('message', (message: WorkerReply) => {
      if (message.id === 1 && !this.settled) {
        this.settled = true
        if (message.ok && message.provider) {
          this.provider = message.provider
          this.onReady(message.provider)
        } else this.onInitError(new Error(message.error || 'GPU OCR 初始化失败'))
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok && message.result) pending.resolve(message.result)
      else pending.reject(new Error(message.error || 'GPU OCR 失败'))
    })
    child.once('exit', (code) => {
      const error = new Error(`GPU OCR 进程退出（${code ?? 'unknown'}）`)
      if (!this.settled) {
        this.settled = true
        this.onInitError(error)
      }
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
    child.once('error', (error) => {
      if (!this.settled) {
        this.settled = true
        this.onInitError(error)
      }
    })
  }

  recognize(image: Buffer): Promise<GpuOcrRecognizeResult> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.send({ id, type: 'recognize', image }, (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async dispose(): Promise<void> {
    if (this.child.killed || this.child.exitCode !== null) return
    this.child.kill()
  }
}
