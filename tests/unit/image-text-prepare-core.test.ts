import { createCipheriv } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decryptWeChatDatV4,
  prepareImageCore
} from '../../src/main/services/image-text-prepare-core'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22])

function pkcs7(input: Buffer): Buffer {
  const padding = 16 - (input.length % 16 || 16)
  return Buffer.concat([input, Buffer.alloc(padding, padding)])
}

function encryptV4(image: Buffer, aesKey: string): Buffer {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii').subarray(0, 16), null)
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(pkcs7(image)), cipher.final()])
  const header = Buffer.alloc(15)
  header.set([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
  header.writeUInt32LE(image.length, 6)
  header.writeUInt32LE(0, 10)
  return Buffer.concat([header, encrypted])
}

describe('图片定位与解密核心', () => {
  it('直接以图片魔数保存的 dat 原样返回', () => {
    expect(decryptWeChatDatV4(PNG, '', 0)?.equals(PNG)).toBe(true)
  })

  it('V4 AES 解密还原出原来的图片字节', () => {
    const key = '0123456789abcdef'
    const file = encryptV4(PNG, key)
    const decrypted = decryptWeChatDatV4(file, key, 0x34)
    expect(decrypted?.equals(PNG)).toBe(true)
  })

  it('按会话目录找到缩略图并解密', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-prepare-core-'))
    const session = 'a'.repeat(32)
    const month = '2024-01'
    const dir = join(root, 'msg', 'attach', session, month, 'Img')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'abc_t.dat'), PNG)
    const result = prepareImageCore({
      md5: 'abc',
      accountDir: root,
      sessionMd5: session,
      createTime: Date.UTC(2024, 0, 15) / 1000,
      aesKey: '0123456789abcdef',
      xorKey: 0,
      preferThumbnail: true
    })
    expect(result.datPath).toMatch(/abc_t\.dat$/)
    expect(result.bytes?.equals(PNG)).toBe(true)
  })

  it('找不到文件时返回空路径，不抛', () => {
    const root = mkdtempSync(join(tmpdir(), 'tm-prepare-miss-'))
    const result = prepareImageCore({
      md5: 'missing',
      accountDir: root,
      sessionMd5: 'b'.repeat(32),
      aesKey: '0123456789abcdef',
      xorKey: 0
    })
    expect(result.datPath).toBeNull()
    expect(result.bytes).toBeNull()
  })
})
