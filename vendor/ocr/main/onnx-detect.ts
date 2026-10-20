/**
 * **文本检测**（DB 算法，PP-OCRv4 `det_ppocrv4.onnx`）。
 *
 * ## 为什么必须有检测
 *
 * 识别模型（`rec_*.onnx`）要求输入是**单行文本**。我最初想
 * "跳过检测、直接按比例裁曲名行"，结果裁不准 + 宽条带被压扁，
 * 识别输出全是噪声（实测 `'鹤''痿沉t林痼呦uh憩'g鹤'鹤`）。
 *
 * ## DB 的输入约定
 *
 * - 输入 `[1,3,H,W]`，H、W 必须是 **32 的倍数**，长边不超过 960
 * - 归一化 `(pixel/255 - mean) / std`，mean=`[0.485,0.456,0.406]`、
 *   std=`[0.229,0.224,0.225]`（ImageNet 口径，PP-OCR 约定）
 * - 输出 `[1,1,H,W]` 的概率图（模型内已 sigmoid）
 *
 * ## 后处理：为什么用"连通域 + 外接矩形"而不是完整 DB
 *
 * 标准 DB 会做"二值化 → 轮廓 → `minAreaRect` → Vatti 裁剪 → 分数过滤"。
 * 但我们的用途只是"在一张卡片裁剪里分出若干文本行"，文字都是水平的，
 * 所以**连通域 + 外接矩形**足够，且实现短、易验：
 *   1. 概率图按阈值二值化（PP-OCR 默认 0.3）；
 *   2. 连通域标记（4 邻域，迭代式 BFS 避免递归爆栈）；
 *   3. 每个连通域取外接矩形，过滤过小/过扁的；
 *   4. 按阅读顺序（先上后下、再左到右）排序。
 */
import { join } from 'node:path'
import { loadOrtModule, modelDir } from './onnx-runtime'

/** 检测输入的长边上限（再大不提升精度，只烧内存） */
const DET_MAX_SIDE = 960
/** DB 二值化阈值（PP-OCR 默认 0.3） */
const DET_BIN_THRESH = 0.3
/** 检测的 ImageNet 归一化参数 */
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

/** 一个检测到的文本框（原图坐标） */
export interface DetBox {
  x: number
  y: number
  w: number
  h: number
  /** 框内平均概率 */
  score: number
}

let detSession: import('onnxruntime-node').InferenceSession | null = null

async function ensureDet(): Promise<import('onnxruntime-node').InferenceSession> {
  if (detSession) return detSession
  const o = await loadOrtModule()
  detSession = await o.InferenceSession.create(join(modelDir(), 'det_ppocrv4.onnx'), {
    executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1
  })
  return detSession
}

/**
 * 把 BGRA 位图做成检测张量：缩放到 32 的倍数并做 ImageNet 归一化。
 *
 * @param rgba BGRA（Electron `toBitmap()` 的顺序）
 */
export function buildDetTensor(
  rgba: Uint8Array,
  w: number,
  h: number
): { data: Float32Array; dw: number; dh: number; ratio: number } {
  const long = Math.max(w, h)
  const ratio = long > DET_MAX_SIDE ? DET_MAX_SIDE / long : 1
  // 对齐到 32 的倍数（DB 的下采样要求）
  let dw = Math.max(32, Math.floor((w * ratio) / 32) * 32)
  let dh = Math.max(32, Math.floor((h * ratio) / 32) * 32)

  const at = (xx: number, yy: number, c: number): number => {
    const i = (yy * w + xx) * 4
    // BGRA → RGB
    return c === 0 ? rgba[i + 2] : c === 1 ? rgba[i + 1] : rgba[i]
  }
  const sample = (x: number, y: number, c: number): number => {
    const sx = ((x + 0.5) * w) / dw - 0.5
    const sy = ((y + 0.5) * h) / dh - 0.5
    const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)))
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)))
    const x1 = Math.max(0, Math.min(w - 1, x0 + 1))
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
    const fx = Math.max(0, Math.min(1, sx - x0))
    const fy = Math.max(0, Math.min(1, sy - y0))
    const top = at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx
    const bot = at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx
    return top * (1 - fy) + bot * fy
  }

  const plane = dw * dh
  const data = new Float32Array(3 * plane)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      for (let c = 0; c < 3; c++) {
        data[c * plane + y * dw + x] = (sample(x, y, c) / 255 - DET_MEAN[c]) / DET_STD[c]
      }
    }
  }
  return { data, dw, dh, ratio: dw / w }
}

/**
 * 概率图 → 文本框（连通域 + 外接矩形）。**纯函数，便于单测。**
 *
 * 返回的坐标已换算回**原图尺度**。
 */
export function boxesFromProb(
  prob: Float32Array,
  pw: number,
  ph: number,
  ratio: number,
  origW: number,
  origH: number,
  opts: { thresh?: number; minH?: number; minArea?: number; expand?: number } = {}
): DetBox[] {
  const thresh = opts.thresh ?? DET_BIN_THRESH
  const minH = opts.minH ?? 5
  const minArea = opts.minArea ?? 16
  const expand = opts.expand ?? 2

  const seen = new Uint8Array(pw * ph)
  const boxes: DetBox[] = []
  const dx = [1, -1, 0, 0]
  const dy = [0, 0, 1, -1]
  const stack: number[] = []

  for (let sy = 0; sy < ph; sy++) {
    for (let sx = 0; sx < pw; sx++) {
      const start = sy * pw + sx
      if (seen[start] || prob[start] < thresh) continue
      let minX = sx
      let maxX = sx
      let minY = sy
      let maxY = sy
      let sum = 0
      let n = 0
      stack.length = 0
      stack.push(start)
      seen[start] = 1
      while (stack.length > 0) {
        const idx = stack.pop() as number
        const x = idx % pw
        const y = (idx / pw) | 0
        sum += prob[idx]
        n++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        for (let k = 0; k < 4; k++) {
          const nx = x + dx[k]
          const ny = y + dy[k]
          if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue
          const ni = ny * pw + nx
          if (seen[ni] || prob[ni] < thresh) continue
          seen[ni] = 1
          stack.push(ni)
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      if (bh < minH || bw * bh < minArea) continue
      const k = 1 / ratio
      const x0 = Math.max(0, Math.floor(minX * k) - expand)
      const y0 = Math.max(0, Math.floor(minY * k) - expand)
      const x1 = Math.min(origW, Math.ceil((maxX + 1) * k) + expand)
      const y1 = Math.min(origH, Math.ceil((maxY + 1) * k) + expand)
      if (x1 <= x0 || y1 <= y0) continue
      boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: n > 0 ? sum / n : 0 })
    }
  }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x)
  return boxes
}

/** 检测一张图里的所有文本框 */
export async function detectBoxes(rgba: Uint8Array, w: number, h: number): Promise<DetBox[]> {
  const o = await loadOrtModule()
  const session = await ensureDet()
  const { data, dw, dh, ratio } = buildDetTensor(rgba, w, h)
  const tensor = new o.Tensor('float32', data, [1, 3, dh, dw])
  const out = await session.run({ x: tensor })
  const o0 = out[session.outputNames[0]]
  const dims = o0.dims
  const pw = dims[3]
  const ph = dims[2]
  return boxesFromProb(o0.data as Float32Array, pw, ph, ratio, w, h)
}

/** 释放检测会话（供测试/诊断） */
export async function releaseDet(): Promise<void> {
  if (detSession) {
    await detSession.release()
    detSession = null
  }
}
