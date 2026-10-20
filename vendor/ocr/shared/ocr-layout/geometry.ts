import type { GrayImage } from './types'

export const BRIGHT_THRESHOLD = 150

export function findBrightRuns(ratio: number[], threshold: number, minLength: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i < ratio.length; i++) {
    const bright = ratio[i] > threshold
    if (bright && start < 0) start = i
    if (!bright && start >= 0) {
      if (i - start >= minLength) out.push([start, i - 1])
      start = -1
    }
  }
  if (start >= 0 && ratio.length - start >= minLength) out.push([start, ratio.length - 1])
  return out
}

export function projectRatio(
  image: GrayImage,
  axis: 'x' | 'y',
  from: number,
  to: number,
  band: [number, number]
): number[] {
  const out: number[] = []
  if (axis === 'y') {
    // 沿 y 投影：对每一行 y，统计 band=[x0,x1] 内的亮像素比例
    const [x0, x1] = band
    const width = x1 - x0 + 1
    for (let y = from; y <= to; y++) {
      let c = 0
      const base = y * image.width
      for (let x = x0; x <= x1; x++) if (image.data[base + x] > BRIGHT_THRESHOLD) c++
      out.push(c / width)
    }
  } else {
    const [y0, y1] = band
    const height = y1 - y0 + 1
    for (let x = from; x <= to; x++) {
      let c = 0
      for (let y = y0; y <= y1; y++) if (image.data[y * image.width + x] > BRIGHT_THRESHOLD) c++
      out.push(c / height)
    }
  }
  return out
}

export function projectSaturation(
  image: GrayImage,
  axis: 'x' | 'y',
  from: number,
  to: number,
  band: [number, number]
): number[] {
  return projectRatio(image, axis, from, to, band)
}
