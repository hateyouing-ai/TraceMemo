import { useCallback, useEffect, useState } from 'react'
import type {
  ImageTextOcrEnginePreference,
  ImageTextOcrPreset,
  ImageTextOcrRuntimeSnapshot
} from '../../../../shared/image-text-ocr-pipeline'

interface ImageTextOcrSettingsPanelProps {
  speedPerSec?: number | null
  localFiles?: number
  localMissing?: number
}

/**
 * 图片文字索引的引擎和并发。
 *
 * 放在「设置 → 数据管理 → 本地索引」的卡片上。AI 模型页里那块单张试识别
 * 不是用户建索引时会打开的地方，控件只放在那里等于没有入口。
 */
export function ImageTextOcrSettingsPanel({
  speedPerSec,
  localFiles,
  localMissing
}: ImageTextOcrSettingsPanelProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<ImageTextOcrRuntimeSnapshot | null>(null)

  useEffect(() => {
    const read = window.api.getImageTextOcrSettings
    if (typeof read !== 'function') return
    let alive = true
    void read()
      .then((value) => {
        if (alive) setSnapshot(value)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback(
    (patch: {
      engine?: ImageTextOcrEnginePreference
      preset?: ImageTextOcrPreset
      ocrConcurrency?: number
      prepareConcurrency?: number
    }): void => {
      const write = window.api.setImageTextOcrSettings
      if (typeof write !== 'function') return
      void write(patch)
        .then((value) => setSnapshot(value))
        .catch(() => undefined)
    },
    []
  )

  const speed =
    typeof speedPerSec === 'number' && speedPerSec > 0
      ? `约 ${speedPerSec.toFixed(1)} 张/秒`
      : '计算中'

  return (
    <div className="local-index-ocr-settings">
      <div className="local-ocr-controls">
        <label>
          索引引擎
          <select
            aria-label="索引引擎"
            value={snapshot?.settings.engine ?? 'auto'}
            onChange={(event) =>
              update({ engine: event.target.value as ImageTextOcrEnginePreference })
            }
          >
            <option value="auto">自动（优先 GPU，失败回退系统 OCR）</option>
            <option value="gpu">GPU（RapidOCR / DirectML）</option>
            <option value="system">系统 OCR</option>
          </select>
        </label>
        <label>
          性能预设
          <select
            aria-label="性能预设"
            value={snapshot?.settings.preset ?? 'auto'}
            onChange={(event) => update({ preset: event.target.value as ImageTextOcrPreset })}
          >
            <option value="auto">自动（i5-14600K 用全力）</option>
            <option value="full-power">全力（针对此台电脑）</option>
            <option value="balanced">均衡</option>
          </select>
        </label>
        <label>
          识别并发
          <input
            aria-label="识别并发"
            type="number"
            min={0}
            max={32}
            value={snapshot?.settings.ocrConcurrency ?? 0}
            onChange={(event) => update({ ocrConcurrency: Number(event.target.value) })}
          />
        </label>
        <label>
          解密并发
          <input
            aria-label="解密并发"
            type="number"
            min={0}
            max={16}
            value={snapshot?.settings.prepareConcurrency ?? 0}
            onChange={(event) => update({ prepareConcurrency: Number(event.target.value) })}
          />
        </label>
      </div>
      <p className="local-index-note">
        {snapshot?.resolved.summary ??
          '并发填 0 表示自动。这台 i5-14600K + RTX 4060 Ti 上，自动会套用全力参数。'}
      </p>
      <p className="local-index-note">
        {snapshot
          ? `当前实际引擎：${snapshot.activeEngineLabel}${snapshot.gpuMessage ? ` · ${snapshot.gpuMessage}` : ''}`
          : '当前实际引擎会在设置读取后显示。'}
        {typeof localFiles === 'number'
          ? ` · 本次扫描本地有原图 ${localFiles.toLocaleString()} 张`
          : ''}
        {typeof localMissing === 'number'
          ? ` · 无原图已跳过 ${localMissing.toLocaleString()} 张`
          : ''}
        {typeof speedPerSec === 'number' || speedPerSec === null ? ` · 当前速度 ${speed}` : ''}
      </p>
      {snapshot?.fallbackNotice ? (
        <p className="local-index-note is-error">{snapshot.fallbackNotice}</p>
      ) : null}
    </div>
  )
}
