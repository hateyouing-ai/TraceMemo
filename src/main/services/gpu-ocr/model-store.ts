/**
 * 解析 RapidOCR 模型目录，必要时下载到 userData。
 * 已有文件按 SHA256 校验；校验失败会重新下载，不会拿一份坏模型去跑。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { OCR_GPU_MODEL_FILES, type OcrGpuModelFile } from '../../../shared/ocr-gpu-models'
import { GPU_OCR_MODEL_NAMES } from '../../../shared/gpu-ocr'

export interface OcrModelLocation {
  directory: string | null
  error?: string
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function fileReady(filePath: string, spec: OcrGpuModelFile): boolean {
  if (!existsSync(filePath)) return false
  try {
    if (statSync(filePath).size < spec.minBytes) return false
  } catch {
    return false
  }
  if (!spec.sha256) return true
  return sha256(filePath) === spec.sha256
}

export function directoryHasOcrModels(directory: string): boolean {
  return OCR_GPU_MODEL_FILES.every((spec) => fileReady(join(directory, spec.name), spec))
}

export function candidateOcrModelDirs(input: {
  envDir?: string | null
  resourcesPath?: string | null
  cwd?: string | null
  userData?: string | null
}): string[] {
  const dirs = [
    input.envDir || '',
    input.resourcesPath ? join(input.resourcesPath, 'resources', 'ocr', 'rapidocr') : '',
    input.resourcesPath ? join(input.resourcesPath, 'ocr', 'rapidocr') : '',
    input.cwd ? join(input.cwd, 'resources', 'ocr', 'rapidocr') : '',
    input.userData ? join(input.userData, 'ocr', 'rapidocr') : ''
  ]
  return Array.from(new Set(dirs.map((dir) => dir.trim()).filter(Boolean)))
}

async function downloadFile(
  url: string,
  destination: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = `${destination}.partial`
  writeFileSync(temporary, bytes)
  renameSync(temporary, destination)
}

export async function ensureOcrGpuModels(input: {
  directories: string[]
  downloadDir?: string | null
  allowDownload?: boolean
  fetchImpl?: typeof fetch
  files?: readonly OcrGpuModelFile[]
}): Promise<OcrModelLocation> {
  for (const directory of input.directories) {
    if (directoryHasOcrModels(directory)) return { directory }
  }
  if (!input.allowDownload || !input.downloadDir) {
    return {
      directory: null,
      error:
        '未找到 RapidOCR 模型。请运行 pnpm prepare:ocr-gpu，或把模型放到 resources/ocr/rapidocr。'
    }
  }
  const fetchImpl = input.fetchImpl ?? fetch
  const files = input.files ?? OCR_GPU_MODEL_FILES
  mkdirSync(input.downloadDir, { recursive: true })
  for (const spec of files) {
    const destination = join(input.downloadDir, spec.name)
    if (fileReady(destination, spec)) continue
    let lastError = '没有可用的下载地址'
    let saved = false
    for (const url of spec.urls) {
      try {
        await downloadFile(url, destination, fetchImpl)
        if (!fileReady(destination, spec)) {
          lastError = `${spec.name} 校验失败`
          continue
        }
        saved = true
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (!saved) return { directory: null, error: `${spec.name} 下载失败：${lastError}` }
  }
  return directoryHasOcrModels(input.downloadDir)
    ? { directory: input.downloadDir }
    : { directory: null, error: '模型下载后仍不完整' }
}

export function requiredModelNames(): string[] {
  return [GPU_OCR_MODEL_NAMES.det, GPU_OCR_MODEL_NAMES.rec, GPU_OCR_MODEL_NAMES.keys]
}
