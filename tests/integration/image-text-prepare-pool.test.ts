import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImageTextPreparePool } from '../../src/main/services/image-text-prepare-pool'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

describe('解密线程池', () => {
  const pools: ImageTextPreparePool[] = []

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.dispose()))
  })

  it('多张图并行定位解密，坏掉一个线程不会挡住后面的任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-prepare-pool-'))
    const session = 'c'.repeat(32)
    const dir = join(root, 'msg', 'attach', session, '2024-03', 'Img')
    mkdirSync(dir, { recursive: true })
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(dir, `${name}.dat`), Buffer.concat([PNG, Buffer.from(name)]))
    }
    const previous = process.env.TRACEMEMO_OCR_FAULTS
    process.env.TRACEMEMO_OCR_FAULTS = '1'
    const pool = new ImageTextPreparePool(2, () => ({ aesKey: '0123456789abcdef', xorKey: 0 }))
    pools.push(pool)
    const crash = pool.submit({
      md5: 'boom',
      accountDir: root,
      sessionMd5: session,
      fault: 'exit'
    })
    await expect(crash).rejects.toThrow(/exited|exit/i)
    const results = await Promise.all(
      ['one', 'two', 'three'].map((name) =>
        pool.submit({ md5: name, accountDir: root, sessionMd5: session, createTime: 1_710_000_000 })
      )
    )
    expect(
      results.map((result) =>
        Buffer.from(result.bytes ?? [])
          .subarray(-nameLength(result.datPath))
          .toString('utf8')
      )
    ).toEqual(['one', 'two', 'three'])
    if (previous === undefined) delete process.env.TRACEMEMO_OCR_FAULTS
    else process.env.TRACEMEMO_OCR_FAULTS = previous
  })
})

function nameLength(datPath: string | null): number {
  const matched = /([a-z]+)\.dat$/.exec(datPath || '')
  return matched ? matched[1].length : 0
}
