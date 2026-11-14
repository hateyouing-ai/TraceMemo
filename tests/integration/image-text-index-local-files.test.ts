/**
 * 目录索引确认没有原图时，不调用逐张 locate，也不进 OCR。
 * 后来文件出现了，下一次 pass 要补上，不能被旧的 image_missing 永远挡住。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

const ACCOUNT = 'wxid_local_files'
const SESSION = 'e'.repeat(32)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function png(seed: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed])
}

function message(name: string, localId: number): chat.FormattedMessage {
  return {
    id: String(localId),
    localId: String(localId),
    from: 'user',
    type: '图片',
    content: '',
    isSender: false,
    name: '对方',
    contentData: { type: 'image', md5: name, datName: name },
    createTime: 1_700_000_000 + localId
  } as unknown as chat.FormattedMessage
}

describe('只索引本地存在的图片', () => {
  it('没有原图的消息直接记 missing，不 locate、不 OCR；文件补上后下一遍会识别', async () => {
    const databaseRoot = mkdtempSync(join(tmpdir(), 'tm-local-db-'))
    const accountDir = mkdtempSync(join(tmpdir(), 'tm-local-wx-'))
    roots.push(databaseRoot, accountDir)
    const img = join(accountDir, 'msg', 'attach', SESSION, '2024-06', 'Img')
    mkdirSync(img, { recursive: true })
    writeFileSync(join(img, 'keep.dat'), png(1))

    const messages = [message('keep', 1), message('gone', 2)]
    const findImageFile = vi.fn(() => {
      throw new Error('逐张 locate 不该被调用')
    })
    const decryptImage = vi.fn((filePath: string) => png(filePath.includes('keep') ? 1 : 2))
    const recognize = vi.fn(async () => ({ success: true, text: '报价', language: null }))

    const bind = (service: ImageTextIndexService): void => {
      service.bind({
        databaseRoot,
        resolveAccountId: () => ACCOUNT,
        resolveAccountRoot: () => accountDir,
        ocrConcurrency: 1,
        listContacts: async () => [{ md5: SESSION, m_nsUsrName: 'local', type: 'user' as const }],
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
        decryptService: () => ({ findImageFile, decryptImage }) as never,
        recognize
      })
    }

    const service = new ImageTextIndexService()
    bind(service)
    await service.startPass()
    await vi.waitFor(() => expect(service.isRunning()).toBe(false), { timeout: 20_000 })

    expect(findImageFile).not.toHaveBeenCalled()
    expect(recognize).toHaveBeenCalledTimes(1)
    expect(decryptImage).toHaveBeenCalledTimes(1)
    const status = await service.getStatus()
    expect(status.progress.localFiles).toBe(1)
    expect(status.progress.localMissing).toBe(1)
    expect(status.progress.indexed).toBe(1)
    expect(status.progress.missing).toBe(1)
    service.resetAccount()

    writeFileSync(join(img, 'gone.dat'), png(2))
    const resumed = new ImageTextIndexService()
    bind(resumed)
    await resumed.startPass()
    await vi.waitFor(() => expect(resumed.isRunning()).toBe(false), { timeout: 20_000 })
    expect(recognize).toHaveBeenCalledTimes(2)
    const databasePath = getImageTextIndexDatabasePath(databaseRoot, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    expect(store.getConversationOcr(SESSION).get('local:2')?.text).toBe('报价')
    store.close()
    resumed.resetAccount()
  })
})
