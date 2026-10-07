import { fetchWithTimeout } from './spotify'

// Album covers for the glasses. The SDK accepts encoded image bytes and
// converts them to the display's 16 shades of green, but photos come out
// muddy that way, so we crop, stretch the contrast and dither first. If the
// canvas step fails for any reason we fall back to the original bytes.

export const ART_SIZE = 144   // image containers top out at 144 px tall

const cache = new Map<string, Uint8Array>()
const CACHE_MAX = 24

/** The processed cover if it's already downloaded. */
export const cachedArt = (url: string) => cache.get(url)

export async function loadArt(url: string): Promise<Uint8Array> {
  const hit = cache.get(url)
  if (hit) return hit

  const res = await fetchWithTimeout(url, {})
  if (!res.ok) throw new Error(`cover ${res.status}`)
  const blob = await res.blob()
  let bytes: Uint8Array
  try {
    bytes = await toGlassesPng(blob)
  } catch {
    bytes = new Uint8Array(await blob.arrayBuffer())
  }

  cache.set(url, bytes)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return bytes
}

async function toGlassesPng(blob: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = ART_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')

  // Center-crop to a square (covers are square, but don't assume).
  const side = Math.min(bitmap.width, bitmap.height)
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ART_SIZE, ART_SIZE)
  bitmap.close?.()

  const image = ctx.getImageData(0, 0, ART_SIZE, ART_SIZE)
  ditherTo16Shades(image.data, ART_SIZE, ART_SIZE)
  ctx.putImageData(image, 0, 0)

  const png: Blob = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'))
  return new Uint8Array(await png.arrayBuffer())
}

/**
 * Greyscale, stretch the levels so the darkest 2% is black and the brightest
 * 2% is full green, then Floyd-Steinberg dither to 16 levels.
 */
export function ditherTo16Shades(px: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h
  const grey = new Float32Array(n)
  const histogram = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const g = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
    grey[i] = g
    histogram[g | 0]++
  }

  const percentile = (p: number) => {
    let count = 0
    for (let v = 0; v < 256; v++) {
      count += histogram[v]
      if (count >= n * p) return v
    }
    return 255
  }
  const lo = percentile(0.02)
  const hi = Math.max(lo + 1, percentile(0.98))
  for (let i = 0; i < n; i++) grey[i] = Math.min(255, Math.max(0, ((grey[i] - lo) * 255) / (hi - lo)))

  const step = 255 / 15
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const value = Math.round(grey[i] / step) * step
      const err = grey[i] - value
      grey[i] = value
      if (x + 1 < w) grey[i + 1] += (err * 7) / 16
      if (y + 1 < h) {
        if (x > 0) grey[i + w - 1] += (err * 3) / 16
        grey[i + w] += (err * 5) / 16
        if (x + 1 < w) grey[i + w + 1] += err / 16
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const v = Math.min(255, Math.max(0, Math.round(grey[i])))
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v
    px[i * 4 + 3] = 255
  }
}
