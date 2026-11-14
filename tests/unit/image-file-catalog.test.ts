import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ImageFileCatalog } from '../../src/main/services/image-file-catalog'

function touch(dir: string, seconds: number): void {
  const time = new Date(seconds * 1000)
  utimesSync(dir, time, time)
}

describe('微信图片目录索引', () => {
  it('一次扫描后内存查表，目录没变就复用，新文件下一次补上', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-catalog-'))
    const session = 'a'.repeat(32)
    const img = join(root, 'msg', 'attach', session, '2024-06', 'Img')
    mkdirSync(img, { recursive: true })
    writeFileSync(join(img, 'keep_t.dat'), Buffer.from('keep'))
    touch(img, 1_700_000_000)

    const databasePath = join(root, 'catalog.sqlite')
    const catalog = new ImageFileCatalog(databasePath)
    const first = catalog.sync(root)
    expect(first.files).toBe(1)
    expect(first.rescanned).toBe(1)
    expect(catalog.lookup('keep', undefined, true)).toMatch(/keep_t\.dat$/)
    expect(catalog.lookup('missing', 'nope')).toBeNull()

    const second = catalog.sync(root)
    expect(second.reused).toBeGreaterThan(0)
    expect(second.rescanned).toBe(0)

    writeFileSync(join(img, 'fresh.dat'), Buffer.from('fresh'))
    touch(img, 1_700_000_100)
    const third = catalog.sync(root)
    expect(third.rescanned).toBe(1)
    expect(catalog.lookup(undefined, 'fresh')).toMatch(/fresh\.dat$/)
    catalog.close()

    const reopened = new ImageFileCatalog(databasePath)
    reopened.sync(root)
    expect(reopened.lookup('keep')).toMatch(/keep_t\.dat$/)
    reopened.close()
  })
})
