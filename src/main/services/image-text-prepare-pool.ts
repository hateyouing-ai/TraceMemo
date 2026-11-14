/**
 * 定位 + 解密线程池。
 *
 * 每个 worker 一次只做一张图。线程崩了会拉起一个新的，并把那一张标成失败，
 * 其它线程上的任务继续。调用方还可以再退回主进程解密。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import type { ImagePrepareCoreResult, ImagePrepareJob } from './image-text-prepare-core'

export interface ImagePrepareRequest {
  md5?: string
  datName?: string
  accountDir: string
  sessionMd5: string
  createTime?: number
  preferThumbnail?: boolean
  datPath?: string
  fault?: 'exit'
}

interface WorkerResponse {
  id: number
  ok: boolean
  result?: ImagePrepareCoreResult
  error?: string
}

interface PendingJob {
  resolve: (result: ImagePrepareCoreResult) => void
  reject: (error: Error) => void
}

export interface PrepareWorkerLaunch {
  filename: string
  execArgv: string[]
}

export function resolvePrepareWorkerLaunch(
  moduleUrl: string = import.meta.url
): PrepareWorkerLaunch {
  const here = dirname(fileURLToPath(moduleUrl))
  const bundled = join(here, 'imageTextPrepareWorker.js')
  if (existsSync(bundled)) return { filename: bundled, execArgv: [] }
  const source = join(here, 'image-text-prepare-worker.ts')
  const loader = join(here, '../../../scripts/ts-worker-loader.mjs')
  return {
    filename: source,
    execArgv: ['--experimental-strip-types', `--import=${loader}`]
  }
}

export class ImageTextPreparePool {
  private readonly workers = new Set<Worker>()
  private readonly idle: Worker[] = []
  private readonly waiters: Array<(worker: Worker) => void> = []
  private readonly pending = new Map<Worker, { id: number; job: PendingJob }>()
  private seq = 0
  private disposed = false
  private size: number

  constructor(
    size: number,
    private readonly material: () => { aesKey: string; xorKey: number },
    private readonly launch: PrepareWorkerLaunch = resolvePrepareWorkerLaunch()
  ) {
    this.size = Math.max(1, Math.floor(size) || 1)
    for (let index = 0; index < this.size; index += 1) this.spawn()
  }

  resize(size: number): void {
    const next = Math.max(1, Math.floor(size) || 1)
    this.size = next
    while (this.workers.size < this.size) this.spawn()
  }

  submit(request: ImagePrepareRequest): Promise<ImagePrepareCoreResult> {
    if (this.disposed) return Promise.reject(new Error('prepare pool disposed'))
    const material = this.material()
    const job: ImagePrepareJob & { fault?: 'exit' } = {
      md5: request.md5,
      datName: request.datName,
      accountDir: request.accountDir,
      sessionMd5: request.sessionMd5,
      createTime: request.createTime,
      preferThumbnail: request.preferThumbnail !== false,
      ...(request.datPath ? { datPath: request.datPath } : {}),
      aesKey: material.aesKey,
      xorKey: material.xorKey,
      ...(request.fault ? { fault: request.fault } : {})
    }
    return new Promise((resolve, reject) => {
      this.acquire()
        .then((worker) => {
          const id = ++this.seq
          this.pending.set(worker, { id, job: { resolve, reject } })
          try {
            worker.postMessage({ ...job, id })
          } catch (error) {
            this.pending.delete(worker)
            this.release(worker)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
        .catch(reject)
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const workers = Array.from(this.workers)
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.once('exit', () => resolve())
            void worker.terminate()
          })
      )
    )
    this.workers.clear()
    this.idle.length = 0
  }

  private spawn(): Worker {
    const worker = new Worker(this.launch.filename, { execArgv: this.launch.execArgv })
    this.workers.add(worker)
    worker.on('message', (message: WorkerResponse) => this.onMessage(worker, message))
    worker.once('error', (error) => this.onCrash(worker, error))
    worker.once('exit', (code) => {
      if (this.workers.has(worker))
        this.onCrash(worker, new Error(`prepare worker exited (${code ?? 'unknown'})`))
    })
    this.release(worker)
    return worker
  }

  private onMessage(worker: Worker, message: WorkerResponse): void {
    const pending = this.pending.get(worker)
    if (!pending || pending.id !== message.id) return
    this.pending.delete(worker)
    if (message.ok && message.result) {
      if (message.result.bytes && !Buffer.isBuffer(message.result.bytes)) {
        message.result.bytes = Buffer.from(message.result.bytes)
      }
      pending.job.resolve(message.result)
    } else pending.job.reject(new Error(message.error || 'prepare worker failed'))
    this.release(worker)
  }

  private onCrash(worker: Worker, error: Error): void {
    if (!this.workers.has(worker)) return
    this.workers.delete(worker)
    const pending = this.pending.get(worker)
    this.pending.delete(worker)
    pending?.job.reject(error)
    const idleIndex = this.idle.indexOf(worker)
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1)
    if (!this.disposed && this.workers.size < this.size) this.spawn()
  }

  private acquire(): Promise<Worker> {
    const worker = this.idle.pop()
    if (worker) return Promise.resolve(worker)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private release(worker: Worker): void {
    if (!this.workers.has(worker)) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(worker)
    else this.idle.push(worker)
  }
}
