/**
 * 图片定位 + 解密 worker。崩溃只丢掉这一张的本次尝试，池会再拉起线程。
 *
 * `TRACEMEMO_OCR_FAULTS=1` 且 `fault: 'exit'` 时主动退出，供测试验证隔离。
 */
import { parentPort } from 'node:worker_threads'
import { prepareImageCore, type ImagePrepareJob } from './image-text-prepare-core'

interface WorkerJob extends ImagePrepareJob {
  id: number
  fault?: 'exit'
}

if (!parentPort) {
  throw new Error('image text prepare worker requires parentPort')
}

const port = parentPort

port.on('message', (job: WorkerJob) => {
  if (process.env['TRACEMEMO_OCR_FAULTS'] === '1' && job.fault === 'exit') {
    process.exit(99)
  }
  try {
    const result = prepareImageCore(job)
    port.postMessage({ id: job.id, ok: true as const, result })
  } catch (error) {
    port.postMessage({
      id: job.id,
      ok: false as const,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
