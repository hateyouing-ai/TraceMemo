# RapidOCR 模型目录

PP-OCRv4 中文检测 / 识别模型不进 git。在 Windows 打包机或目标电脑上执行：

```bash
pnpm prepare:ocr-gpu
```

文件会下载到这个目录。应用首次启用 GPU 引擎时，如果这里没有模型，也会尝试下载到用户数据目录。清单和校验值见 `src/shared/ocr-gpu-models.ts`（RapidAI/RapidOCR v3.4.0）。
