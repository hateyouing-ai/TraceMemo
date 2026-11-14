/**
 * RapidOCR PP-OCRv4 中文模型清单。
 *
 * 来源：RapidAI/RapidOCR `default_models.yaml`（Modelscope 修订 v3.4.0）。
 * 检测 / 识别 / 方向分类的 SHA256 与上游清单一致；字典和识别模型必须成对使用。
 * 这套 mobile 模型对中文截图、报价图足够，体积也适合在 4060 Ti 上常驻两份会话。
 */
export interface OcrGpuModelFile {
  name: string
  role: 'det' | 'rec' | 'cls' | 'keys'
  sha256?: string
  minBytes: number
  urls: readonly string[]
}

export const OCR_GPU_MODEL_RELEASE = 'RapidAI/RapidOCR@v3.4.0'

export const OCR_GPU_MODEL_FILES: readonly OcrGpuModelFile[] = [
  {
    name: 'ch_PP-OCRv4_det_infer.onnx',
    role: 'det',
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
    minBytes: 1_000_000,
    urls: [
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_infer.onnx',
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx'
    ]
  },
  {
    name: 'ch_PP-OCRv4_rec_infer.onnx',
    role: 'rec',
    sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b',
    minBytes: 1_000_000,
    urls: [
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_infer.onnx',
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx'
    ]
  },
  {
    name: 'ch_ppocr_mobile_v2.0_cls_infer.onnx',
    role: 'cls',
    sha256: 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
    minBytes: 100_000,
    urls: [
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_infer.onnx',
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_ppocr_mobile_v2.0_cls_infer.onnx'
    ]
  },
  {
    name: 'ppocr_keys_v1.txt',
    role: 'keys',
    minBytes: 1_000,
    urls: [
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.4.0/paddle/PP-OCRv4/rec/ch_PP-OCRv4_rec_infer/ppocr_keys_v1.txt'
    ]
  }
]
