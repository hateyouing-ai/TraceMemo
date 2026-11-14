/**
 * 下载 RapidOCR PP-OCRv4 中文模型到 resources/ocr/rapidocr。
 *
 * 用法：node --experimental-strip-types scripts/prepare-ocr-gpu-runtime.mjs
 * 已存在且 SHA256 相符的文件会跳过。链接来自 RapidAI/RapidOCR v3.4.0 清单。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OCR_GPU_MODEL_FILES, OCR_GPU_MODEL_RELEASE } from '../src/shared/ocr-gpu-models.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = path.join(root, 'resources', 'ocr', 'rapidocr')

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function ready(filePath, spec) {
  if (!existsSync(filePath)) return false
  if (statSync(filePath).size < spec.minBytes) return false
  if (!spec.sha256) return true
  return sha256(filePath) === spec.sha256
}

async function download(url, filePath) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const temporary = `${filePath}.partial`
  writeFileSync(temporary, bytes)
  renameSync(temporary, filePath)
}

async function main() {
  mkdirSync(destination, { recursive: true })
  console.log(`[prepare-ocr-gpu] ${OCR_GPU_MODEL_RELEASE}`)
  console.log(`[prepare-ocr-gpu] -> ${destination}`)
  for (const spec of OCR_GPU_MODEL_FILES) {
    const filePath = path.join(destination, spec.name)
    if (ready(filePath, spec)) {
      console.log(`[prepare-ocr-gpu] keep ${spec.name}`)
      continue
    }
    let saved = false
    let lastError = 'no url'
    for (const url of spec.urls) {
      try {
        console.log(`[prepare-ocr-gpu] download ${spec.name}`)
        await download(url, filePath)
        if (!ready(filePath, spec)) {
          lastError = `${spec.name} checksum mismatch`
          continue
        }
        saved = true
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (!saved) {
      throw new Error(`[prepare-ocr-gpu] ${spec.name} failed: ${lastError}`)
    }
  }
  console.log('[prepare-ocr-gpu] ready')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
