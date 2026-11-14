/**
 * 微信图片目录的文件索引。
 *
 * 逐张 locate 会为了确认「文件不存在」去扫月份目录、对十几个候选路径做 stat，
 * 还会掉进旧目录的递归查找。缺文件的账号上，这一步比 OCR 还贵。
 *
 * 这里改成：每个索引 pass 开始时走一遍目录树，按「规范化文件名 → 路径」放进内存。
 * 叶子目录的 mtime 和文件数没变就沿用上次的缓存。微信后来又下载了原图，
 * 那个目录的 mtime 会变，下一次 sync 会把它补进索引。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  imageFileQuality,
  imageQualityRank,
  type ExportImageQuality
} from '../../shared/image-quality'
import { normalizeDatBase } from './image-text-prepare-core'

interface CatalogHit {
  path: string
  quality: ExportImageQuality
  size: number
}

export interface ImageFileCatalogSyncResult {
  files: number
  directories: number
  rescanned: number
  reused: number
  removed: number
}

const ROOTS: Array<{ name: string; depth: number }> = [
  { name: join('msg', 'attach'), depth: 4 },
  { name: 'cache', depth: 6 },
  { name: 'FileStorage', depth: 6 }
]

export function wechatImageRootsExist(accountDir: string): boolean {
  return ROOTS.some((root) => existsSync(join(accountDir, root.name)))
}

export class ImageFileCatalog {
  private readonly database: DatabaseSync
  private readonly hits = new Map<string, CatalogHit[]>()
  private ready = false

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS catalog_dirs (
        dir TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        file_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalog_files (
        dir TEXT NOT NULL,
        file_name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (dir, file_name)
      );
      CREATE INDEX IF NOT EXISTS catalog_files_key ON catalog_files (name_key);
    `)
  }

  get active(): boolean {
    return this.ready
  }

  sync(accountDir: string): ImageFileCatalogSyncResult {
    const seen = new Set<string>()
    let rescanned = 0
    let reused = 0
    const stored = new Map<string, { mtimeMs: number; fileCount: number }>()
    for (const row of this.database
      .prepare('SELECT dir, mtime_ms, file_count FROM catalog_dirs')
      .all() as Array<{
      dir: string
      mtime_ms: number
      file_count: number
    }>) {
      stored.set(row.dir, { mtimeMs: Number(row.mtime_ms), fileCount: Number(row.file_count) })
    }

    const upsertDir = this.database.prepare(
      `INSERT INTO catalog_dirs (dir, mtime_ms, file_count) VALUES (?, ?, ?)
       ON CONFLICT(dir) DO UPDATE SET mtime_ms = excluded.mtime_ms, file_count = excluded.file_count`
    )
    const deleteFiles = this.database.prepare('DELETE FROM catalog_files WHERE dir = ?')
    const insertFile = this.database.prepare(
      'INSERT INTO catalog_files (dir, file_name, name_key, size) VALUES (?, ?, ?, ?)'
    )

    const visit = (dir: string, names: string[]): void => {
      seen.add(dir)
      let mtimeMs = 0
      try {
        mtimeMs = Math.round(statSync(dir).mtimeMs)
      } catch {
        return
      }
      const previous = stored.get(dir)
      if (previous && previous.mtimeMs === mtimeMs && previous.fileCount === names.length) {
        reused += 1
        return
      }
      rescanned += 1
      this.database.exec('BEGIN IMMEDIATE')
      try {
        deleteFiles.run(dir)
        for (const name of names) {
          const key = normalizeDatBase(name)
          if (!key) continue
          let size = 0
          try {
            size = statSync(join(dir, name)).size
          } catch {
            size = 0
          }
          insertFile.run(dir, name, key, size)
        }
        upsertDir.run(dir, mtimeMs, names.length)
        this.database.exec('COMMIT')
      } catch (error) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          // 事务可能没打开。
        }
        throw error
      }
    }

    for (const root of ROOTS) {
      const absolute = join(accountDir, root.name)
      if (!existsSync(absolute)) continue
      walkDatDirectories(absolute, root.depth, visit)
    }

    let removed = 0
    const deleteDir = this.database.prepare('DELETE FROM catalog_dirs WHERE dir = ?')
    for (const dir of stored.keys()) {
      if (seen.has(dir)) continue
      deleteFiles.run(dir)
      deleteDir.run(dir)
      removed += 1
    }

    this.reload()
    const files = this.database.prepare('SELECT COUNT(*) AS total FROM catalog_files').get() as {
      total: number
    }
    return {
      files: Number(files.total ?? 0),
      directories: seen.size,
      rescanned,
      reused,
      removed
    }
  }

  /**
   * 目录索引是否认这张图。
   * 索引没建好时返回 undefined，调用方继续走原来的逐张查找。
   */
  lookup(md5?: string, datName?: string, preferThumbnail = true): string | null | undefined {
    if (!this.ready) return undefined
    const keys = [normalizeDatBase(datName || ''), normalizeDatBase(md5 || '')].filter(Boolean)
    const found: CatalogHit[] = []
    for (const key of keys) {
      const hits = this.hits.get(key)
      if (hits) found.push(...hits)
    }
    if (!found.length) return null
    found.sort((left, right) => {
      if (preferThumbnail) {
        const thumb =
          (right.quality === 'thumbnail' ? 1 : 0) - (left.quality === 'thumbnail' ? 1 : 0)
        if (thumb !== 0) return thumb
      }
      return (
        imageQualityRank(right.quality) - imageQualityRank(left.quality) || right.size - left.size
      )
    })
    return found[0]?.path ?? null
  }

  close(): void {
    this.ready = false
    this.hits.clear()
    try {
      this.database.close()
    } catch {
      // best effort
    }
  }

  private reload(): void {
    this.hits.clear()
    const rows = this.database
      .prepare('SELECT dir, file_name, name_key, size FROM catalog_files')
      .all() as Array<{ dir: string; file_name: string; name_key: string; size: number }>
    for (const row of rows) {
      const key = String(row.name_key)
      const hit: CatalogHit = {
        path: join(String(row.dir), String(row.file_name)),
        quality: imageFileQuality(String(row.file_name)),
        size: Number(row.size ?? 0)
      }
      const list = this.hits.get(key)
      if (list) list.push(hit)
      else this.hits.set(key, [hit])
    }
    this.ready = true
  }
}

function walkDatDirectories(
  dir: string,
  depth: number,
  visit: (dir: string, names: string[]) => void
): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const datNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dat'))
    .map((entry) => entry.name)
  if (datNames.length) visit(dir, datNames)
  if (depth <= 0) return
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    walkDatDirectories(join(dir, entry.name), depth - 1, visit)
  }
}
