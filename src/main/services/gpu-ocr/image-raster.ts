import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import type { Raster } from './rapidocr-postprocess'

function pngRaster(buffer: Buffer): Raster | null {
  try {
    const decoded = PNG.sync.read(buffer)
    return { width: decoded.width, height: decoded.height, rgba: decoded.data }
  } catch {
    return null
  }
}

function jpegRaster(buffer: Buffer): Raster | null {
  try {
    const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true })
    if (!decoded?.width || !decoded?.height || !decoded.data) return null
    return {
      width: decoded.width,
      height: decoded.height,
      rgba: decoded.data instanceof Uint8Array ? decoded.data : new Uint8Array(decoded.data)
    }
  } catch {
    return null
  }
}

export function decodeImageRaster(buffer: Buffer): Raster | null {
  if (!buffer || buffer.length < 4) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return pngRaster(buffer)
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpegRaster(buffer)
  return pngRaster(buffer) ?? jpegRaster(buffer)
}
