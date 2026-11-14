/**
 * 快路径：解密可以并行、写入按批提交、暂停不领取新 OCR、重启不重算。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as chat from '../../src/main/services/chat-service'
import { ImageTextIndexService } from '../../src/main/services/image-text-index-service'
import {
  ImageTextIndexStore,
  getImageTextIndexDatabasePath
} from '../../src/main/services/image-text-index-store'
import type { ResolvedImageTextPipeline } from '../../src/shared/image-text-ocr-pipeline'

const ACCOUNT = 'wxid_fast_pipeline'
const CONVERSATION = 'md5-fast'
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tm-image-fast-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  )
})

function pngBytes(seed: number): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    seed & 0xff,
    (seed >> 8) & 0xff
  ])
}

function imageMessage(localId: number): chat.FormattedMessage {
  return {
    id: String(localId),
    localId: String(localId),
    from: 'user',
    type: '图片',
    content: '',
    isSender: false,
    name: '对方',
    contentData: { type: 'image', md5: `md5-${localId}`, datName: `dat-${localId}` },
    createTime: 1_700_000_000 + localId
  } as unknown as chat.FormattedMessage
}

const pipeline: ResolvedImageTextPipeline = {
  mode: 'full-power',
  targetMachinePreset: true,
  gpuRequested: true,
  ocrConcurrency: 4,
  prepareConcurrency: 4,
  readBatchSize: 8,
  persistBatchSize: 4,
  yieldBetweenBatches: false,
  gpuWorkerCount: 2,
  recBatchSize: 8,
  recMaxWidth: 640,
  detLimitSide: 960,
  summary: 'test'
}

function seedFromPath(filePath: string): number {
  const matched = /(\d+)\.dat$/.exec(String(filePath))
  return matched ? Number(matched[1]) : 1
}

function seedFromDataUrl(dataUrl: string): number {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  return bytes[8] | (bytes[9] << 8)
}

function harness(options: {
  count: number
  recognizeImpl?: (
    dataUrl: string,
    callIndex: number
  ) => Promise<{
    success: boolean
    text: string
    language: string | null
    errorCode?: string
  }>
}): {
  service: ImageTextIndexService
  recognize: ReturnType<typeof vi.fn>
  databaseRoot: string
  databasePath: string
  stats: () => { maxInFlight: number; maxPrepare: number }
} {
  const databaseRoot = makeRoot()
  const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
  const messages = Array.from({ length: options.count }, (_, index) => imageMessage(index + 1))
  const service = new ImageTextIndexService()
  let callIndex = 0
  let inFlight = 0
  let maxInFlight = 0
  let maxPrepare = 0
  let prepareInFlight = 0
  const recognize = vi.fn(async (dataUrl: string) => {
    callIndex += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      if (options.recognizeImpl) return await options.recognizeImpl(dataUrl, callIndex)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { success: true, text: `TEXT_${seedFromDataUrl(dataUrl)}`, language: null }
    } finally {
      inFlight -= 1
    }
  })
  service.bind({
    databaseRoot,
    resolveAccountId: () => ACCOUNT,
    resolveAccountRoot: () => databaseRoot,
    readFastPipelineConfig: () => pipeline,
    listContacts: async () => [{ md5: CONVERSATION, m_nsUsrName: 'fast', type: 'user' as const }],
    listMessages: async () => messages,
    countConversationImages: async () => ({ count: messages.length, typeColumn: 'local_type' }),
    imageWatermark: async () => ({ count: messages.length, maxLocalId: messages.length }),
    capability: async () => ({
      available: true,
      engine: 'windows-system-ocr' as const,
      platform: 'win32' as const,
      arch: 'x64',
      runtimeVersion: '1.2.0',
      language: 'zh-Hans-CN',
      message: 'ok'
    }),
    decryptService: () =>
      ({
        findImageFile: (md5: string) => `C:/fake/${md5}.dat`,
        decryptImage: (filePath: string) => pngBytes(seedFromPath(filePath))
      }) as never,
    prepareOffThread: async (request) => {
      prepareInFlight += 1
      maxPrepare = Math.max(maxPrepare, prepareInFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      prepareInFlight -= 1
      const seed = Number(/(\d+)$/.exec(String(request.md5 || ''))?.[1] ?? 1)
      return {
        datPath: `C:/fake/${request.md5}.dat`,
        bytes: pngBytes(seed),
        locateMs: 1,
        decryptMs: 1
      }
    },
    recognize
  })
  return {
    service,
    recognize,
    databaseRoot,
    databasePath,
    stats: () => ({ maxInFlight, maxPrepare })
  }
}

const finish = async (service: ImageTextIndexService): Promise<void> => {
  await vi.waitFor(() => expect(service.isRunning()).toBe(false), { timeout: 30_000 })
}

describe('图片文字索引快路径', () => {
  it('解密并行、OCR 有界，批量写入后结果不串、不丢', async () => {
    const h = harness({ count: 16 })
    await h.service.startPass()
    await finish(h.service)
    expect(h.stats().maxInFlight).toBeLessThanOrEqual(4)
    expect(h.stats().maxInFlight).toBeGreaterThan(1)
    expect(h.stats().maxPrepare).toBeGreaterThan(1)
    expect(h.recognize).toHaveBeenCalledTimes(16)
    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    const ocr = store.getConversationOcr(CONVERSATION)
    expect(ocr.size).toBe(16)
    expect(ocr.get('local:7')?.text).toBe('TEXT_7')
    store.close()
    const status = await h.service.getStatus()
    expect(status.progress.state).toBe('completed')
    expect(status.progress.indexed).toBe(16)
    h.service.resetAccount()
  })

  it('暂停后不再领取新的 OCR，在途的结果已经落库', async () => {
    const gateControl: { release: () => void } = { release: () => undefined }
    const gate = new Promise<void>((resolve) => {
      gateControl.release = () => resolve()
    })
    const h = harness({
      count: 20,
      recognizeImpl: async (_dataUrl, callIndex) => {
        if (callIndex === 4) h.service.pause()
        await gate
        return { success: true, text: 'PAUSED', language: null }
      }
    })
    void h.service.startPass()
    await vi.waitFor(() => expect(h.recognize.mock.calls.length).toBeGreaterThanOrEqual(4))
    gateControl.release()
    await finish(h.service)
    expect(h.recognize).toHaveBeenCalledTimes(4)
    const store = new ImageTextIndexStore(h.databasePath, ACCOUNT)
    expect(store.countByState().indexed).toBe(4)
    expect(store.readScanState().get(CONVERSATION)?.state).toBe('partial')
    store.close()
    const status = await h.service.getStatus()
    expect(status.progress.state).toBe('paused')
    h.service.resetAccount()
  })

  it('一张识别失败不影响其余图片，重启后已成功的不再识别', async () => {
    const h = harness({
      count: 8,
      recognizeImpl: async (dataUrl) => {
        if (seedFromDataUrl(dataUrl) === 3) throw new Error('gpu blew up')
        return { success: true, text: 'OK', language: null }
      }
    })
    await h.service.startPass()
    await finish(h.service)
    const status = await h.service.getStatus()
    expect(status.progress.processed).toBe(8)
    expect(status.progress.indexed).toBe(7)
    expect(status.progress.failed).toBe(1)
    h.service.resetAccount()

    const restarted = new ImageTextIndexService()
    const recognize2 = vi.fn(async () => ({ success: true, text: 'AGAIN', language: null }))
    restarted.bind({
      databaseRoot: h.databaseRoot,
      resolveAccountId: () => ACCOUNT,
      resolveAccountRoot: () => h.databaseRoot,
      readFastPipelineConfig: () => pipeline,
      listContacts: async () => [{ md5: CONVERSATION, m_nsUsrName: 'fast', type: 'user' as const }],
      listMessages: async () => Array.from({ length: 8 }, (_, index) => imageMessage(index + 1)),
      countConversationImages: async () => ({ count: 8, typeColumn: 'local_type' }),
      imageWatermark: async () => ({ count: 8, maxLocalId: 8 }),
      capability: async () => ({
        available: true,
        engine: 'windows-system-ocr' as const,
        platform: 'win32' as const,
        arch: 'x64',
        runtimeVersion: '1.2.0',
        language: 'zh-Hans-CN',
        message: 'ok'
      }),
      decryptService: () =>
        ({
          findImageFile: (md5: string) => `C:/fake/${md5}.dat`,
          decryptImage: (filePath: string) => pngBytes(seedFromPath(filePath))
        }) as never,
      recognize: recognize2
    })
    await restarted.startPass()
    await finish(restarted)
    // ocr_failed 也是终态：崩溃那张已经记下来了，重启不能把成功结果重算一遍。
    expect(recognize2).not.toHaveBeenCalled()
    restarted.resetAccount()
  })
})
