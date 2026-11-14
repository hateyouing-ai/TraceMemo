import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ImageTextIndexStore,
  getImageTextIndexDatabasePath
} from '../../src/main/services/image-text-index-store'
import type { ImageOcrArtifact, ImageOcrBinding } from '../../src/shared/image-text-index'

const ACCOUNT = 'wxid_batch'

function artifact(key: string, text: string): ImageOcrArtifact {
  return {
    accountId: ACCOUNT,
    artifactKey: key,
    imageIdentity: `sha256:${key}`,
    state: 'indexed',
    text,
    charCount: text.length,
    engine: 'rapidocr-onnx-dml',
    platform: 'win32',
    runtimeVersion: 'dml',
    language: 'zh',
    createdAt: 1,
    updatedAt: 1
  }
}

function binding(messageId: string, key: string): ImageOcrBinding {
  return {
    accountId: ACCOUNT,
    conversationId: 'conv',
    messageId,
    createTime: 1,
    imageIdentity: `sha256:${key}`,
    artifactKey: key,
    state: 'indexed',
    updatedAt: 1
  }
}

describe('派生库批量提交', () => {
  it('一批结果和 checkpoint 一起可见', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-ocr-batch-'))
    const databasePath = getImageTextIndexDatabasePath(root, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.commitDerivedBatch({
      records: [1, 2, 3].map((id) => ({
        artifact: artifact(`k${id}`, `文字${id}`),
        binding: binding(`local:${id}`, `k${id}`)
      })),
      scan: {
        conversationId: 'conv',
        state: 'partial',
        imageTotal: 10,
        imageProcessed: 3,
        maxLocalId: 3
      }
    })
    store.close()

    const reopened = new ImageTextIndexStore(databasePath, ACCOUNT)
    expect(reopened.countByState().indexed).toBe(3)
    expect(reopened.getArtifact('k2')?.text).toBe('文字2')
    expect(reopened.readScanState().get('conv')).toMatchObject({
      state: 'partial',
      processed: 3,
      maxLocalId: 3
    })
    reopened.close()
  })

  it('事务中途失败会整批回滚，checkpoint 也不会超前', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-ocr-rollback-'))
    const databasePath = getImageTextIndexDatabasePath(root, ACCOUNT)
    const store = new ImageTextIndexStore(databasePath, ACCOUNT)
    store.commitDerivedBatch({
      records: [{ artifact: artifact('keep', '留下'), binding: binding('local:1', 'keep') }],
      scan: {
        conversationId: 'conv',
        state: 'partial',
        imageTotal: 10,
        imageProcessed: 1,
        maxLocalId: 1
      }
    })
    expect(() =>
      store.commitDerivedBatch({
        records: [
          {
            artifact: { ...artifact('bad', '不该留下'), accountId: 'someone-else' },
            binding: binding('local:2', 'bad')
          }
        ],
        scan: {
          conversationId: 'conv',
          state: 'done',
          imageTotal: 10,
          imageProcessed: 99,
          maxLocalId: 99
        }
      })
    ).toThrow(/account/i)
    expect(store.countByState().indexed).toBe(1)
    expect(store.getArtifact('bad')).toBeNull()
    expect(store.readScanState().get('conv')?.state).toBe('partial')
    expect(store.readScanState().get('conv')?.processed).toBe(1)
    store.close()
  })
})
