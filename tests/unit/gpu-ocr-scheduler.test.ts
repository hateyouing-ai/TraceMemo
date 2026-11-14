import { describe, expect, it } from 'vitest'
import { GpuOcrScheduler, type GpuWorkerClient } from '../../src/main/services/gpu-ocr/gpu-ocr-host'

class FakeWorker implements GpuWorkerClient {
  provider = 'dml'
  crashesLeft: number
  disposed = false

  constructor(crashesLeft = 0) {
    this.crashesLeft = crashesLeft
  }

  async recognize(): Promise<{
    success: boolean
    text: string
    lines: Array<{ text: string }>
    provider: string
  }> {
    if (this.crashesLeft > 0) {
      this.crashesLeft -= 1
      throw new Error('native crash')
    }
    return { success: true, text: '报价', lines: [{ text: '报价' }], provider: 'dml' }
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

describe('GPU OCR 进程隔离', () => {
  it('进程崩溃后重启，并把这一张重试成功，下一张继续', async () => {
    let created = 0
    const scheduler = await GpuOcrScheduler.open({
      workerCount: 1,
      createWorker: async () => {
        created += 1
        return new FakeWorker(created === 1 ? 1 : 0)
      }
    })
    const first = await scheduler.recognize(Buffer.from('a'))
    const second = await scheduler.recognize(Buffer.from('b'))
    expect(first.text).toBe('报价')
    expect(second.text).toBe('报价')
    expect(created).toBeGreaterThan(1)
    expect(scheduler.available).toBe(true)
    await scheduler.dispose()
  })

  it('一个进程都起不来时标记不可用，而不是抛到调用方外面', async () => {
    const scheduler = await GpuOcrScheduler.open({
      workerCount: 2,
      createWorker: async () => {
        throw new Error('onnxruntime-node 不可用')
      }
    })
    expect(scheduler.available).toBe(false)
    const result = await scheduler.recognize(Buffer.from('a'))
    expect(result.errorCode).toBe('GPU_OCR_UNAVAILABLE')
    expect(result.success).toBe(false)
  })
})
