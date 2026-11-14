/**
 * 图片索引的定位 + 解密。只依赖 Node 内置模块，给 worker 线程用。
 *
 * 覆盖微信 4 常见布局：会话目录里的 Img / 气泡预览，以及 V4 DAT（AES-128-ECB + XOR）。
 * 找不到文件时返回空路径，调用方再退回主进程里的 `ImageDecryptService`
 * （硬链接库、旧目录）。这样热路径离开主线程，冷路径不丢图。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { imageFileQuality, imageQualityRank } from '../../shared/image-quality'

export interface ImagePrepareJob {
  md5?: string
  datName?: string
  accountDir: string
  sessionMd5: string
  createTime?: number
  aesKey: string
  xorKey: number
  preferThumbnail?: boolean
}

export interface ImagePrepareCoreResult {
  datPath: string | null
  bytes: Buffer | null
  locateMs: number
  decryptMs: number
}

const DAT_V4_SIGNATURE = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

export function sessionDirectoryName(sessionId: string): string {
  const value = String(sessionId || '').trim()
  if (!value) return ''
  if (/^[a-f0-9]{32}$/i.test(value)) return value.toLowerCase()
  return createHash('md5').update(value).digest('hex')
}

function normalizeDatBase(value: string): string {
  const lower = String(value || '')
    .trim()
    .toLowerCase()
  if (!lower) return ''
  const file = lower.split(/[/\\]/).pop() || ''
  const withoutDat = file.endsWith('.dat') ? file.slice(0, -4) : file
  return withoutDat.replace(/(?:_thumb|\.thumb|_hd|\.hd|_h_m|_h|\.h|_t_m|_t|\.t|_m|_b|_w|_c)$/i, '')
}

function buildPreferredDatNames(baseName: string): string[] {
  const base = normalizeDatBase(baseName)
  if (!base) return []
  return [
    `${base}.dat`,
    `${base}_hd.dat`,
    `${base}_h_M.dat`,
    `${base}_h.dat`,
    `${base}_M.dat`,
    `${base}_b.dat`,
    `${base}_w.dat`,
    `${base}_c.dat`,
    `${base}_t_M.dat`,
    `${base}_t.dat`,
    `${base}.thumb.dat`,
    `${base}_thumb.dat`
  ]
}

function monthLabel(createTime?: number): string {
  if (!createTime || !Number.isFinite(createTime)) return ''
  const date = new Date(createTime * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function listMonths(root: string, createTime?: number): string[] {
  let names: string[] = []
  try {
    names = readdirSync(root)
      .filter((name) => /^\d{4}-\d{2}$/.test(name))
      .sort((left, right) => right.localeCompare(left))
  } catch {
    return []
  }
  const preferred = monthLabel(createTime)
  if (!preferred || !names.includes(preferred)) return names
  return [preferred, ...names.filter((name) => name !== preferred)]
}

function pickExisting(
  paths: string[],
  allowThumbnail: boolean,
  preferThumbnail: boolean
): string | null {
  const sized = paths
    .filter((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile()
      } catch {
        return false
      }
    })
    .map((candidate) => {
      try {
        return { candidate, size: statSync(candidate).size }
      } catch {
        return { candidate, size: 0 }
      }
    })
  if (preferThumbnail) {
    const thumbnail = sized
      .filter((entry) => imageFileQuality(entry.candidate) === 'thumbnail')
      .sort((left, right) => right.size - left.size)[0]
    if (thumbnail) return thumbnail.candidate
  }
  const allowed = sized
    .filter((entry) => allowThumbnail || imageFileQuality(entry.candidate) !== 'thumbnail')
    .sort(
      (left, right) =>
        imageQualityRank(imageFileQuality(right.candidate)) -
          imageQualityRank(imageFileQuality(left.candidate)) || right.size - left.size
    )
  return allowed[0]?.candidate ?? null
}

export function locateWeChatImage(job: ImagePrepareJob): string | null {
  const accountDir = String(job.accountDir || '')
  if (!accountDir || !existsSync(accountDir)) return null
  const session = sessionDirectoryName(job.sessionMd5)
  const keys = Array.from(
    new Set([normalizeDatBase(job.datName || ''), normalizeDatBase(job.md5 || '')].filter(Boolean))
  )
  if (!session || keys.length === 0) return null
  const preferThumbnail = job.preferThumbnail !== false
  if (preferThumbnail) {
    const cacheRoot = join(accountDir, 'cache')
    const previewNames = keys.flatMap((key) => [
      `${key}_b.dat`,
      `${key}_w.dat`,
      `${key}_c.dat`,
      `${key}_t_M.dat`,
      `${key}_t.dat`
    ])
    for (const month of listMonths(cacheRoot, job.createTime)) {
      const bubbleDir = join(cacheRoot, month, 'Message', session, 'Bubble')
      const found = pickExisting(
        previewNames.map((name) => join(bubbleDir, name)),
        true,
        true
      )
      if (found) return found
    }
  }
  const sessionRoot = join(accountDir, 'msg', 'attach', session)
  const variants = keys.flatMap((key) => buildPreferredDatNames(key))
  for (const month of listMonths(sessionRoot, job.createTime)) {
    const candidates = ['Img', 'Image', 'image'].flatMap((sub) =>
      variants.map((name) => join(sessionRoot, month, sub, name))
    )
    const found = pickExisting(candidates, true, preferThumbnail)
    if (found) return found
  }
  return null
}

function isDirectImage(buffer: Buffer): boolean {
  if (buffer.length < 4) return false
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
    return true
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return true
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return true
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length > 11 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true
  }
  return false
}

function removePkcs7(buffer: Buffer): Buffer | null {
  if (buffer.length === 0) return buffer
  const padding = buffer[buffer.length - 1]
  if (padding <= 0 || padding > 16 || padding > buffer.length) return null
  for (let index = buffer.length - padding; index < buffer.length; index += 1) {
    if (buffer[index] !== padding) return null
  }
  return buffer.subarray(0, buffer.length - padding)
}

/** 与 `ImageDecryptService.decryptDatV4` 同一套 V4 布局。失败返回 null，不抛。 */
export function decryptWeChatDatV4(
  file: Buffer,
  aesKeyAscii: string,
  xorKey: number
): Buffer | null {
  if (isDirectImage(file)) return file
  if (file.length < 0x0f) return null
  if (!file.subarray(0, 6).equals(DAT_V4_SIGNATURE)) return null
  const aesSize = file.readUInt32LE(6)
  const xorSize = file.readUInt32LE(10)
  const data = file.subarray(0x0f)
  const remainder = ((aesSize % 16) + 16) % 16
  const alignedAesSize = aesSize + (16 - remainder)
  if (alignedAesSize > data.length) return null
  const keyText = String(aesKeyAscii || '')
  if (!keyText) return null
  const key = Buffer.from(keyText, 'ascii').subarray(0, 16)
  if (key.length < 16) return null

  let unpadded = Buffer.alloc(0)
  const aesData = data.subarray(0, alignedAesSize)
  if (aesData.length > 0) {
    try {
      const decipher = createDecipheriv('aes-128-ecb', key, null)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])
      const stripped = removePkcs7(decrypted)
      if (!stripped) return null
      unpadded = Buffer.from(stripped)
    } catch {
      return null
    }
  }

  const remaining = data.subarray(alignedAesSize)
  if (xorSize < 0 || xorSize > remaining.length) return null
  let rawData: Buffer
  let xored = Buffer.alloc(0)
  if (xorSize > 0) {
    const rawLength = remaining.length - xorSize
    if (rawLength < 0) return null
    rawData = remaining.subarray(0, rawLength)
    const xorData = remaining.subarray(rawLength)
    xored = Buffer.alloc(xorData.length)
    const mask = xorKey & 0xff
    for (let index = 0; index < xorData.length; index += 1) xored[index] = xorData[index] ^ mask
  } else {
    rawData = remaining
  }
  return Buffer.concat([unpadded, rawData, xored])
}

export function prepareImageCore(job: ImagePrepareJob): ImagePrepareCoreResult {
  const locateStarted = Date.now()
  const datPath = locateWeChatImage(job)
  const locateMs = Date.now() - locateStarted
  if (!datPath) return { datPath: null, bytes: null, locateMs, decryptMs: 0 }
  const decryptStarted = Date.now()
  let bytes: Buffer | null = null
  try {
    bytes = decryptWeChatDatV4(readFileSync(datPath), job.aesKey, job.xorKey)
  } catch {
    bytes = null
  }
  return { datPath, bytes, locateMs, decryptMs: Date.now() - decryptStarted }
}
