/**
 * **ONNX OCR 引擎**（RapidOCR / PP-OCRv4，纯 CPU 推理）。
 *
 * ## 为什么换掉 PaddleJS + WebGL（用户反馈驱动）
 *
 * 1. **内存**：实测单次识别把 Chromium 的 `gpu` 进程撑到 **5GB**，
 *    系统可用内存掉到 0.2GB，导致"连输入文字都卡"（换页）。
 *    试过限制输入长边、每批销毁 worker、缩小批大小，**峰值都压不下来**——
 *    根因在 PaddleJS 自身（WebGL 纹理 + 不释放的中间张量）。
 * 2. **识别正确性**：当前中文字典 `ppocr_keys_v1.txt` 里**只有 4 个片假名**
 *    （`カ`、`ル` 都不在），所以 `カール` 只能被读成形近汉字 `力一儿`。
 *    日文字典有 85 个片假名，能正确输出。
 *
 * 换成 onnxruntime-node 后：**纯 CPU、无 WebGL**，内存可预测；
 * 且可以同时挂中文与日文两个识别模型。
 *
 * ## 模型与字典
 *
 * | 文件 | 用途 |
 * |---|---|
 * | `det_ppocrv4.onnx` | 文本检测（DB 算法） |
 * | `rec_ch.onnx` | 识别（中英） |
 * | `rec_japan.onnx` | 识别（日文，含假名） |
 * | `dict_ch.txt` / `dict_japan.txt` | 对应字典 |
 *
 * ### ⚠ 字典对齐（踩过的坑）
 *
 * 实测输出通道数比字典行数**多 2**：
 * ```
 * rec_ch.onnx     C=6625   字典 6623 行
 * rec_japan.onnx  C=4401   字典 4399 行
 * ```
 * 多出来的是 **`space`（PaddleOCR 的 `use_space_char=True` 追加在末尾）**
 * 与 **blank（最后一类，索引 `C-1`）**。
 *
 * 我最初把 blank 当成 `dict.length`，于是**整个索引错一位**——
 * 解码出来是 `!B!C!D` 这种（`!` 正好是 `A` 的前一号），
 * 看着像乱码，其实是系统性偏移。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOrtModule, modelDir } from './onnx-runtime'
import { detectBoxes } from './onnx-detect'

/*
 * ONNX Runtime 用**动态 require**：它是原生模块（含 .node 二进制），
 * 必须由 Node 直接加载，不能让 Vite/esbuild 打包进去。
 * 用 `createRequire` 保证在 ESM 产物里也能拿到 require。
 */

/** 识别模型的高度固定 48（PP-OCRv4 约定） */
const REC_H = 48
/** 识别模型宽度上限 320（超出会被截断） */
const REC_MAX_W = 320
/** 一个识别会话 + 它的字典 */
interface RecEngine {
  session: import('onnxruntime-node').InferenceSession
  /** 字符表；**已包含追加的 space**，长度 = C - 1 */
  dict: string[]
  name: string
}

let recCh: RecEngine | null = null
let recJp: RecEngine | null = null
let loadError: string | null = null
let japaneseTitleEngine: Promise<RecEngine | null> | null = null


/**
 * 读字典。
 *
 * ## ⚠ 索引对齐：**blank 在索引 0**（我在这里错了三次，记录过程）
 *
 * 实测（用**空白输入**探测，见 `_ocrspike/diag-index.cjs`）：
 * ```
 * 全白/全黑图送入 → 模型 argmax 恒为 0
 * 而字典[0] 分别是 "'"（中文）与 "!"（日文）
 * ```
 * 即**模型用索引 0 表示 blank**，字符从**索引 1** 开始
 * （PaddleOCR 的标准做法：类别数 = 字典字符数 + 2，
 *   `0` = blank，`1..N` = 字典字符，`N+1` = space）。
 *
 * 这也解释了输出里那些莫名的 `'` 与 `!`——**那都是 blank 被当成字符**
 * 解码出来的。
 *
 * ### 我犯的三个错
 * 1. 把 blank 当成 `dict.length`（错，那是末尾）；
 * 2. 又把 space push 到末尾当成索引 N；
 * 3. 直到用**空白输入探测 argmax** 才确认 blank 在 0。
 *    教训：**索引类问题要用探测确定，不要靠读文档猜**。
 *
 * 因此这里返回的字典**在开头补一个占位**，使
 * `dict[i]` 正好对应模型输出索引 `i`（`dict[0]` 永远用不到，
 * 因为 `ctcDecode` 会把 0 当 blank 跳过）。
 */
function loadDict(path: string): string[] {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
  // 文件末尾通常有一个空行（最后的换行符），去掉它
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  /*
   * 开头补占位：让字符索引与模型输出索引对齐。
   * 注意**不要再追加 space**——`dict_japan.txt` 本身末行就是空格，
   * 中文模型虽无空格但也不影响（多余的空位不会被 argmax 选中）。
   */
  return ['', ...lines]
}

/** 惰性加载识别模型（首次调用约 100–300ms） */
async function ensureRec(): Promise<{ ch: RecEngine; jp: RecEngine }> {
  if (recCh && recJp) return { ch: recCh, jp: recJp }
  if (loadError) throw new Error(loadError)
  try {
    const o = await loadOrtModule()
    const dir = modelDir()
    const mk = async (model: string, dict: string, name: string): Promise<RecEngine> => ({
      session: await o.InferenceSession.create(join(dir, model), { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 }),
      dict: loadDict(join(dir, dict)),
      name
    })
    /*
     * ## **双模型组合**（实测得出的最终配置）
     *
     * 实测两个模型各有一项更强（209 条真实卡片行）：
     *
     * | 内容 | **v5**（`ch` 槽位）| v4-mobile（`jp` 槽位）|
     * |---|---|---|
     * | PTT `11.53888` | **`11.53888`** ✅ 小数点可靠 | `1153888`（丢小数点）|
     * | 分数 `09'888'705` | **`09'888'705`** ✅ | `09888705`（丢分隔符）|
     * | 分数 `09'967'759` | `0996/708`（丢一位）| **`09967'759`** ✅ |
     *
     * 整表实测：**全用 v5 时 PTT 24→37、可入库 15→23，但分数 20→10**；
     * 反之全用 v4 则小数不可靠。所以两个都保留，
     * 由 `recognizeCrop` 按"**是否读到至少三位 PTT 小数**"择优（见那里的注释）。
     *
     * 另外 v4-mobile 的日文字典也挂了日文模型，用于假名曲名的兜底。
     * `BEST30_REC_MODEL=v4` 可退回"只用 v4"的旧行为。
     */
    const useV5 = process.env.BEST30_REC_MODEL !== 'v4'
    recCh = useV5
      ? await mk('rec_ch_v5.onnx', 'dict_v5.txt', 'ch-v5')
      : await mk('rec_ch.onnx', 'dict_ch.txt', 'ch')
    /*
     * `jp` 槽位实际用 **v4-mobile 中文模型**：它在这条链路上扮演的是
     * "**分数兜底**"角色（v5 偶尔丢一位数字，而 v4 的分数形态更完整）。
     * 名字仍叫 `jp` 是历史原因（槽位类型未改名）。
     */
    recJp = await mk('rec_ch.onnx', 'dict_ch.txt', 'ch-v4')
    return { ch: recCh, jp: recJp }
  } catch (error) {
    loadError = `ONNX 模型加载失败：${(error as Error).message}（目录 ${modelDir()}）`
    throw new Error(loadError)
  }
}

/**
 * 双线性采样 RGBA 位图 → `[1,3,48,320]` 的 Float32 张量数据。
 *
 * ## ⚠ 缩放必须双线性
 *
 * 实测教训：最初用**最近邻**把 307×52 缩到 288×48，笔画被丢掉，
 * 中文/日文模型都输出乱码。卡片文字只有约 20px 高，最近邻缩小时
 * 会直接丢笔画。
 *
 * ## 归一化
 *
 * PaddleOCR 的识别预处理是 `(pixel/255 - 0.5) / 0.5`。
 *
 * @param rgba 图像像素。**注意 Electron 的 `toBitmap()` 是 BGRA 顺序**
 * @param w,h  原始尺寸
 */
export function buildRecTensor(rgba: Uint8Array, w: number, h: number): Float32Array {
  /*
   * ## ⚠ 必须**严格保持宽高比**（这是我第一版的主要错误）
   *
   * 第一版是"按高度缩放到 48，宽度 = 48×比例，超出 320 就截断"。
   * 后果：输入若是一条很宽的带（实测 700×90，比例 7.8），
   * `48×7.8 = 374 > 320` → **宽度被硬截断，文字横向压扁 1.17 倍**，
   * 识别输出变成 `'鹤''痿沉t林痼呦uh憩'g鹤'鹤` 这种噪声。
   *
   * PaddleOCR 的标准做法（`resize_norm_img`）：
   *   1. 先按高度缩放到 48；
   *   2. 若宽度超出 320，改为**按宽度**缩放到 320（此时高度不足 48）；
   *   3. 不足的部分用 0 padding，且垂直方向**居中**（`(48-newH)/2`）。
   *
   * 这样文字比例永远不失真——对识别正确率是决定性的。
   */
  const targetRatio = REC_MAX_W / REC_H
  const srcRatio = w / Math.max(1, h)
  let newW: number
  let newH: number
  if (srcRatio <= targetRatio) {
    // 不太宽：按高度铺满，宽度留白
    newH = REC_H
    newW = Math.max(1, Math.min(REC_MAX_W, Math.ceil(REC_H * srcRatio)))
  } else {
    // 太宽：按宽度铺满，高度不足并居中
    newW = REC_MAX_W
    newH = Math.max(1, Math.min(REC_H, Math.floor(REC_MAX_W / srcRatio)))
  }
  const padTop = Math.floor((REC_H - newH) / 2)

  const at = (xx: number, yy: number, c: number): number => {
    const i = (yy * w + xx) * 4
    // Electron 的 toBitmap() 是 BGRA，PP-OCR 训练用 RGB，所以交换 R/B
    return c === 0 ? rgba[i + 2] : c === 1 ? rgba[i + 1] : rgba[i]
  }
  const sample = (x: number, y: number, c: number): number => {
    const sx = ((x + 0.5) * w) / newW - 0.5
    const sy = ((y + 0.5) * h) / newH - 0.5
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

  const out = new Float32Array(3 * REC_H * REC_MAX_W)
  const plane = REC_H * REC_MAX_W
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      for (let c = 0; c < 3; c++) {
        out[c * plane + (y + padTop) * REC_MAX_W + x] = (sample(x, y, c) / 255 - 0.5) / 0.5
      }
    }
  }
  return out
}

/**
 * **行级识别**：把一条已经很扁的文本行裁剪，先**放大**到模型期望的字高再识别。
 *
 * ## 为什么需要"先放大"
 *
 * 识别模型的输入高度固定 48，且它训练时字高约占 30–40px。
 * 实测卡片里的行被检出后只有 **20–31px 高**，直接送进去会被
 * **缩小**到 48 里的更小比例 —— 字比训练分布还小，数字就糊了：
 * ```
 * "9'967'759"  →  "9967759"     （千位分隔符丢失）
 * "09'967'759" →  "0'067'750"   （9→0、8→6）
 * ```
 * 所以先按倍数放大到"字高接近 40px"，再交给识别模型——
 * 它最后仍会缩到 48，但**此时是缩小而不是继续压小**，笔画得以保留。
 *
 * @param rgba BGRA 位图
 */
export function upscaleRgbaForLine(
  rgba: Uint8Array,
  w: number,
  h: number,
  /** 目标字高：行高不足它就放大 */
  targetH = 48,
  /** 放大倍数上限，避免把很小的噪声块放得过大 */
  maxScale = 3
): { data: Uint8Array; w: number; h: number } {
  const scale = Math.min(maxScale, Math.max(1, targetH / Math.max(1, h)))
  if (scale <= 1.01) return { data: rgba, w, h }
  const nw = Math.max(1, Math.round(w * scale))
  const nh = Math.max(1, Math.round(h * scale))
  const out = new Uint8Array(nw * nh * 4)
  // 双线性（对 BGRA 四通道）
  for (let y = 0; y < nh; y++) {
    const sy = ((y + 0.5) * h) / nh - 0.5
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)))
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < nw; x++) {
      const sx = ((x + 0.5) * w) / nw - 0.5
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)))
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1))
      const fx = Math.max(0, Math.min(1, sx - x0))
      const o = (y * nw + x) * 4
      for (let c = 0; c < 4; c++) {
        const a = rgba[(y0 * w + x0) * 4 + c]
        const b = rgba[(y0 * w + x1) * 4 + c]
        const cc = rgba[(y1 * w + x0) * 4 + c]
        const d = rgba[(y1 * w + x1) * 4 + c]
        const top = a * (1 - fx) + b * fx
        const bot = cc * (1 - fx) + d * fx
        out[o + c] = Math.round(top * (1 - fy) + bot * fy)
      }
    }
  }
  return { data: out, w: nw, h: nh }
}

/** CTC 贪心解码的结果 */
export interface RecResult {
  text: string
  /** 平均置信度（只统计输出字符的那些时刻） */
  score: number
}

/**
 * CTC 贪心解码。
 *
 * @param logits softmax 输出（扁平），形状 `[T, C]`
 * @param dict   字符表，长度应为 `C - 1`（含追加的 space）
 */
export function ctcDecode(logits: Float32Array, T: number, C: number, dict: string[]): RecResult {
  /*
   * ⚠ **blank = 索引 0**（实测确认，见 `loadDict` 的说明）。
   * 不是 `C-1` —— 我最初按"最后一类是 blank"写，导致所有字符错位一位，
   * 输出表现为凯撒位移（`Alexandrite` → `Bb!boemf!`）。
   */
  const blank = 0
  let text = ''
  let sum = 0
  let n = 0
  let prev = -1
  for (let t = 0; t < T; t++) {
    let best = 0
    let bestV = -Infinity
    const base = t * C
    for (let c = 0; c < C; c++) {
      const v = logits[base + c]
      if (v > bestV) {
        bestV = v
        best = c
      }
    }
    if (best !== blank && best !== prev) {
      text += dict[best] ?? ''
      sum += bestV
      n++
    }
    prev = best
  }
  return { text, score: n > 0 ? sum / n : 0 }
}

/**
 * **按内容类型选择识别方式**（实测得出的最终策略）。
 *
 * ## 192 个候选行的实测对比（`_ocrspike/test-score.cjs`）
 *
 * | 内容类型 | 整行识别 | 分段识别 | 胜者 |
 * |---|---|---|---|
 * | 曲名（长）| `FractureRav` | **`TFractureRay`** | **分段** |
 * | 曲名（长）| `Finhoriarlokar` | **`nFinheriarJolker`** | **分段** |
 * | **分数** | **`09967'759`** | `29'967759` | **整行** |
 * | **分数** | **`09955'394`** | `ng'g555'3994` | **整行** |
 * | **Potential** | `Potential95>115388HC` | **`Potential95>11.53888HC`** | **分段** |
 * | 判定 | `P:1139(+1065)E101:8` | `P:1139（+）1065)E:10L8` | 相当 |
 *
 * 规律：
 *   - **分数（纯数字）**：字符少，整行读更准；分段会切坏左边缘，
 *     冒出一个假 `2`（`09967'759` → `29'967759`）；
 *   - **Potential 行**：**必须分段**——它是长文本，受 320 宽度上限挤压后
 *     **小数点会丢**，而 `extractPotential` 的正则要求 4 位小数，
 *     丢小数点 = PTT 解析失败。分段后 `11.53888` 就出来了；
 *   - **曲名**：分段略好（首尾字符更完整），但整行也不算差。
 *
 * ## 为什么"只对 Potential 行分段"
 *
 * 我先试过"所有行都分段"：PTT 从 28 升到 38，但**分数从 24 掉到 13**。
 * 又试过"整行+分段都跑再择优"：更复杂且**更差**（33/19/32）。
 * 最终采用**按内容类型定向分段**——只给真正受益的行付代价。
 *
 * 判据用**整行结果**判断（先跑一次整行，很便宜）：
 * 含 `potential` / `tential` / `otential` 这类片段的行 → 再跑分段取分段结果。
 */
export async function recognizeLineBest(
  rgba: Uint8Array,
  w: number,
  h: number,
  opts: { targetH?: number; maxScale?: number } = {}
): Promise<{ text: string; score: number; engine: 'ch' | 'japan' }> {
  const up = upscaleRgbaForLine(rgba, w, h, opts.targetH ?? 96, opts.maxScale ?? 4)
  const whole = await recognizeCrop(up.data, up.w, up.h)
  /** 这一行是否是"Potential / PTT 行"（决定要不要分段） */
  const isPotentialLine = (t: string): boolean =>
    /p[o0]?t+ent?[i1l]+a?l/i.test(t) || /\d[.·]\d{4,6}/.test(t) || /\d{1,2}>\d{4}/.test(t)
  /*
   * ⚠ 这里只对 **Potential 行** 付分段的代价。
   *
   * 我试过更"聪明"的组合（整行+分段都跑再按结构择优），实测**反而更差**
   * （曲名 43→33、PTT 30→32 但可入库 24→14）。而且同一配置重复运行的
   * 数值本身有波动（43/20/30/24 与 33/19/32 是同一份代码的两次测量），
   * 说明继续在这上面调参已经是在拟合噪声。
   *
   * 所以保留这个**最简单且实测最好**的版本：先整行（便宜），
   * 只有认出是 Potential 行时才额外跑一次分段。
   */
  if (isPotentialLine(whole.text)) {
    const seg = await recognizeCropSegmented(rgba, w, h, opts)
    if (seg.text.length >= whole.text.length) return seg
  }
  return whole
}

/**
 * **曲名专用识别**：只用 v4-mobile 的读数。
 *
 * ## 为什么要独立（实测）
 *
 * v5 是通用模型，对**假名**很强，但在这些卡片的**全大写/无空格拉丁曲名**上
 * 反而不如 v4-mobile：
 * ```
 * 卡面 "LALUE" → v5: "AUUEIOON"    v4-mobile: "LALUE]OON"   ← v4 更接近
 * 卡面 "Grievous Lady" → v5: "?"   v4-mobile: 能读出
 * ```
 * 实测整表曲名命中：**只用 v4 时 45–46**，用"按字段择优"后掉到 31–34，
 * 因为曲名行的字段分数为 0，选择权落到置信度，而 v5 在长文本上置信度偏高。
 *
 * 所以曲名这一路**固定用 v4-mobile**，不参与字段择优——
 * 曲名没有可用的"字段形态"判据，结构分不适用。
 */
export async function recognizeTitle(
  rgba: Uint8Array,
  w: number,
  h: number
): Promise<{ text: string; score: number }> {
  const { jp } = await ensureRec()
  const o = await loadOrtModule()
  return recognizeWith(jp, o, rgba, w, h)
}

/** 日文模型只补曲名，不占用用于数字兜底的 v4 中文会话。缺模型时保留其他候选。 */
export async function recognizeJapaneseTitle(rgba: Uint8Array, w: number, h: number): Promise<RecResult | null> {
  if (!japaneseTitleEngine) {
    japaneseTitleEngine = (async () => {
      try {
        const o = await loadOrtModule()
        const dir = modelDir()
        return {
          session: await o.InferenceSession.create(join(dir, 'rec_japan.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 }),
          dict: loadDict(join(dir, 'dict_japan.txt')),
          name: 'japan-title'
        }
      } catch {
        return null
      }
    })()
  }
  const engine = await japaneseTitleEngine
  return engine ? recognizeWith(engine, await loadOrtModule(), rgba, w, h) : null
}

/** Preserve native and enlarged Japanese readings; title matching chooses using the local catalog. */
export async function recognizeJapaneseTitleReadings(rgba: Uint8Array,w: number,h: number): Promise<RecResult[]> {
  const native=await recognizeJapaneseTitle(rgba,w,h)
  const up=upscaleRgbaForLine(rgba,w,h,64,4)
  const enlarged=await recognizeJapaneseTitle(up.data,up.w,up.h)
  return [native,enlarged].filter((r): r is RecResult=>!!r&&r.score>=.35&&!!r.text.trim())
    .filter((r,i,all)=>all.findIndex(x=>x.text===r.text)===i)
}

/** 独立数字字段保留两份模型读数，由字段层处理冲突，不以通用文本分数选一个。 */
export async function recognizeFieldReadings(rgba: Uint8Array, w: number, h: number): Promise<RecResult[]> {
  const { ch, jp } = await ensureRec()
  const runtime = await loadOrtModule()
  return Promise.all([recognizeWith(ch, runtime, rgba, w, h), recognizeWith(jp, runtime, rgba, w, h)])
}

/** 用某个识别引擎读一块裁剪图 */
async function recognizeWith(
  eng: RecEngine,
  o: Awaited<ReturnType<typeof loadOrtModule>>,
  rgba: Uint8Array,
  w: number,
  h: number
): Promise<RecResult> {
  const data = buildRecTensor(rgba, w, h)
  const tensor = new o.Tensor('float32', data, [1, 3, REC_H, REC_MAX_W])
  const out = await eng.session.run({ x: tensor })
  const o0 = out[eng.session.outputNames[0]]
  const dims = o0.dims
  const T = dims[1]
  const C = dims[2]
  return ctcDecode(o0.data as Float32Array, T, C, eng.dict)
}

/**
 * 同时用中文与日文模型识别同一块图，返回**更可信**的那个。
 *
 * ## 为什么两个都跑
 *
 * 中文字典覆盖简体中文好（Phigros 曲名如 `风屿`、`盏茗`），
 * 日文字典覆盖假名好（Arcaea 曲名如 `カール`）。
 * 单一模型都会在一侧翻车，所以两边都跑、取置信度高的。
 *
 * 代价：单块推理时间翻倍（实测 20–60ms → 40–120ms），
 * 但相对原来 WebGL 版的几十秒可以忽略。
 */
export async function recognizeCrop(
  rgba: Uint8Array,
  w: number,
  h: number
): Promise<{ text: string; score: number; engine: 'ch' | 'japan' }> {
  const { ch, jp } = await ensureRec()
  const o = await loadOrtModule()
  const a = await recognizeWith(ch, o, rgba, w, h)
  const b = await recognizeWith(jp, o, rgba, w, h)

  /*
   * ========================================================================
   * **按"字段质量"择优**（2026-04，替代之前的逐行二选一）
   * ========================================================================
   *
   * ## 为什么逐行二选一不够好（实测数据）
   *
   * 之前用"v5 是否读到固定 4 位小数"来逐行决定用哪个模型。现在按至少三位小数和
   * `9–13.5` 值域判定。整表实测出来：
   * ```
   * 全 v4        → PTT 24
   * 全 v5        → PTT 37
   * 逐行二选一   → PTT 40，但曲名 45→31、分数 50→16
   * ```
   * 原因：**同一行里不同字段的胜负可能相反**。例如
   * ```
   * v5: "Potential9711.34B5FC"    ← 有 "Potential" 但小数位被打断
   * v4: "POTENTIAL9.711.3435EC"   ← 结构完整但小数点位置不同
   * ```
   * 逐行只能整行选一个，必然丢掉另一个模型的正确字段。
   *
   * ## 现在的做法：**按"能支撑多少合法字段"打分**
   *
   * 对两个读数分别计算它**解析出的字段数量**与**字段形态质量**：
   *   - 分数：能读出落在 `SCORE_RANGE` 内的 7–8 位值 → 加分
   *   - PTT：能读出 `整数.至少三位小数`（9–13.5 区间）→ 加分
   *   - 定数：能读出 `整数.一位小数`（1–12 区间）→ 加分
   *
   * 取**总分更高**的那个读数。这样"该行哪个模型更能支撑字段解析"
   * 就成了判据，而不是靠单个特征猜。
   */
  const fieldsOf = (t: string): number => {
    let n = 0
    // 分数：7–8 位、落在 8000000–10002221
    const digits = t.replace(/[^\d]/g, '')
    for (const m of t.matchAll(/\d[\d'’:,./]{5,10}\d/g)) {
      const d = m[0].replace(/[^\d]/g, '')
      if (d.length === 7 || d.length === 8) {
        const tail = d.slice(-3)
        const head = d.slice(0, -3).replace(/^0+/, '')
        const v = Number.parseInt(head + tail, 10)
        if (Number.isFinite(v) && v >= 8_000_000 && v <= 10_002_221) {
          n += 2
          break
        }
      }
    }
    void digits
    // PTT：`整数.至少三位小数`，9–13.5
    if (/\d[.·]\d{3,6}/.test(t)) {
      for (const m of t.matchAll(/(\d{1,2})[.·](\d{3,6})/g)) {
        const v = Number.parseFloat(`${m[1]}.${m[2]}`)
        if (v >= 9 && v <= 13.5) {
          n += 2
          break
        }
      }
    }
    // 定数：`整数.一位小数`，1–12（且不是 PTT 那种多位小数）
    if (/\d{1,2}[.·]\d(?!\d)/.test(t)) n += 1
    return n
  }
  const qa = fieldsOf(a.text)
  const qb = fieldsOf(b.text)
  if (qa !== qb) {
    return qa > qb
      ? { text: a.text, score: a.score, engine: 'ch' }
      : { text: b.text, score: b.score, engine: 'japan' }
  }
  // 字段质量相同时，用置信度决胜
  return a.score >= b.score
    ? { text: a.text, score: a.score, engine: 'ch' }
    : { text: b.text, score: b.score, engine: 'japan' }
}

/**
 * **分段识别长行**：把超过模型宽度上限（320）的行按空白处切开，逐段识别后拼接。
 *
 * ## 为什么这是必要的（实测数据）
 *
 * 识别模型的输入宽度上限是 **320**。整图上的长行（如 Potential 行
 * `POTENTIAL 9.5 > 11.5388 HC` 约 600px）无论放大多少倍，
 * 最终都被压进 320 宽 —— **横向压缩 3–4 倍**，小数点这种小目标最先糊掉。
 *
 * 40 行抽样对比（`_ocrspike/test-digits.cjs`）：
 *
 * | 策略 | 出现小数点 | 出现千位分隔符 |
 * |---|---|---|
 * | 整体缩放（H48/H72/H96 都一样）| **0 行** | 9 行 |
 * | **分段识别** | **7 行** | 8 行 |
 *
 * 具体例子：
 * ```
 * "POTENTIAL 9.5 > 11.5388 HC"
 *   整体 → "Potential95>115388HC"     ← 小数点丢失 → PTT 解析失败
 *   分段 → "Potential95>11.53888HC"   ← 小数点保留 ✅
 * ```
 *
 * 提升放大倍率**没有用**（H48/H72/H96 结果完全相同）——因为瓶颈是
 * 宽度上限，不是纵向分辨率。只有分段才能突破。
 *
 * ## 切分点怎么找
 *
 * 在行内计算每列的"文字能量"（与行均值的偏离），在允许范围内挑
 * **能量最低的列**当切点——那就是字与字之间的空白，切开不会切断笔画。
 */

/** 一行里每列的"文字能量"（用于找空白切点） */
function columnEnergy(rgba: Uint8Array, w: number, h: number): Float64Array {
  const col = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    let s = 0
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      s += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3
    }
    col[x] = s / h
  }
  let mean = 0
  for (let x = 0; x < w; x++) mean += col[x]
  mean /= Math.max(1, w)
  const e = new Float64Array(w)
  for (let x = 0; x < w; x++) e[x] = Math.abs(col[x] - mean)
  return e
}

/** 从行里切出一段列范围 */
function sliceColumns(
  rgba: Uint8Array,
  w: number,
  h: number,
  x0: number,
  x1: number
): { data: Uint8Array; w: number; h: number } {
  const sw = Math.max(1, x1 - x0)
  const out = new Uint8Array(sw * h * 4)
  for (let y = 0; y < h; y++) {
    const src = (y * w + x0) * 4
    out.set(rgba.subarray(src, src + sw * 4), y * sw * 4)
  }
  return { data: out, w: sw, h }
}

/** 计算某段在模型里会被缩放到多宽（用于判断是否需要再切） */
function resizedWidth(w: number, h: number): number {
  const targetRatio = 320 / 48
  const srcRatio = w / Math.max(1, h)
  return srcRatio <= targetRatio ? Math.min(320, Math.ceil(48 * srcRatio)) : 320
}

export async function recognizeCropSegmented(
  rgba: Uint8Array,
  w: number,
  h: number,
  opts: { maxScale?: number; targetH?: number } = {}
): Promise<{ text: string; score: number; engine: 'ch' | 'japan' }> {
  const targetH = opts.targetH ?? 96
  const up = upscaleRgbaForLine(rgba, w, h, targetH, opts.maxScale ?? 4)
  /*
   * ⚠ **只对真正超宽的行分段**（无条件分段会变差，实测）。
   *
   * 我第一版对**所有**行都分段，结果 PTT 从 28 升到 38，但**分数从 24 掉到 13**：
   * ```
   * 分段前  "09967'759"      分段后  "29'967759"   ← 左边缘被切到，多出一个 2
   * 分段前  "09955'394"      分段后  "ng'g555'3994" ← 严重崩坏
   * ```
   * 原因是短行本来就能完整放进 320，切开反而让每段**上下文变少**，
   * 且切点可能落在字符上。
   *
   * 判据：用 `resizedWidth` 算出"这一行在模型里会被缩到多宽"。
   * 若已经 <= 320（即能完整放进模型输入），就**不分段**。
   */
  if (resizedWidth(up.w, up.h) <= 320 && up.w <= 340) {
    return recognizeCrop(up.data, up.w, up.h)
  }
  const energy = columnEnergy(up.data, up.w, up.h)
  const segs: Array<[number, number]> = []
  let start = 0
  const maxSegW = 300
  while (up.w - start > maxSegW) {
    const lo = Math.floor(start + maxSegW * 0.55)
    const hi = Math.min(up.w - 1, start + maxSegW)
    let bestX = lo
    let bestV = Infinity
    for (let x = lo; x <= hi; x++) {
      if (energy[x] < bestV) {
        bestV = energy[x]
        bestX = x
      }
    }
    if (bestX <= start) bestX = start + maxSegW
    segs.push([start, bestX])
    start = bestX
  }
  segs.push([start, up.w])

  let text = ''
  let sum = 0
  let n = 0
  let engine: 'ch' | 'japan' = 'ch'
  for (const [x0, x1] of segs) {
    const s = sliceColumns(up.data, up.w, up.h, x0, x1)
    const r = await recognizeCrop(s.data, s.w, s.h)
    text += r.text
    sum += r.score
    n++
    if (r.engine === 'japan') engine = 'japan'
  }
  return { text, score: n > 0 ? sum / n : 0, engine }
}

/** 供诊断：ONNX 引擎是否可用、模型目录在哪 */
export function onnxOcrState(): { ready: boolean; error: string | null; dir: string } {
  return { ready: !!recCh && !!recJp, error: loadError, dir: modelDir() }
}

/**
 * **检测 → 逐框识别**，产出与应用现有流程同形的文本块列表。
 *
 * 这是接入主流程的入口：检测给出框，识别给出文字，
 * 结果形状与 PaddleJS 那条路径一致（`{text,x,y,w,h}`），
 * 所以上层解析器（`parseCardItems` / `gridFromOcrAnchors` 等）不用改。
 *
 * ## 为什么要过滤
 *
 * 检测会给出很多"非文字"或"噪声"的小框（实测有 score 很低的 `TM` 之类）。
 * 这里按**置信度**丢掉低质量块，避免把噪声喂给解析器。
 * 阈值取 0.4：实测真实文字基本都在 0.6 以上，而噪声多在 0.2–0.4。
 */
export async function extractItems(
  rgba: Uint8Array,
  w: number,
  h: number,
  opts: { minScore?: number } = {}
): Promise<Array<{ text: string; x: number; y: number; w: number; h: number }>> {
  const boxes = await detectBoxes(rgba, w, h)
  const minScore = opts.minScore ?? 0.4
  const items: Array<{ text: string; x: number; y: number; w: number; h: number }> = []
  for (const b of boxes) {
    // 裁出该框的像素（BGRA）
    const sub = new Uint8Array(b.w * b.h * 4)
    for (let y = 0; y < b.h; y++) {
      const sy = b.y + y
      if (sy < 0 || sy >= h) continue
      const srcOff = (sy * w + b.x) * 4
      sub.set(rgba.subarray(srcOff, srcOff + b.w * 4), y * b.w * 4)
    }
    const r = await recognizeCrop(sub, b.w, b.h)
    if (!r.text || r.score < minScore) continue
    items.push({ text: r.text, x: b.x, y: b.y, w: b.w, h: b.h })
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x)
  return items
}
