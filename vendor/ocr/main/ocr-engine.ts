/**
 * **OCR 引擎分派层**：让识别链路可在 PaddleJS（旧）与 ONNX（新）之间切换。
 *
 * ## 为什么要分派层
 *
 * 迁移要求"**可回退**"——不能把旧实现删掉。所以这里只在
 * "拿文本块"这一个动作上做分派，上层（网格检测、卡片解析、校验）
 * 完全不用改：它们只要 `{text,x,y,w,h}` 形状的输入。
 *
 * ## 引擎选择
 *
 * ```
 * BEST30_OCR_ENGINE=onnx      强制用 ONNX
 * BEST30_OCR_ENGINE=paddlejs  强制用 PaddleJS（旧）
 * 不设                        默认 PaddleJS（迁移完成前保持现状）
 * ```
 *
 * ## 两条路径的差异
 *
 * | | PaddleJS（旧） | ONNX（新） |
 * |---|---|---|
 * | 运行位置 | 隐藏窗口的 WebGL | 主进程 CPU |
 * | 内存峰值 | 实测 **5058MB**（gpu 进程）| 实测 **307MB** |
 * | 中文字典 | 只有 4 个片假名 → `カール` 读成 `力一儿` | 另有日文模型（85 个片假名）|
 * | 输入 | data URL（经 `JSON.stringify` 序列化，有大小限制）| 直接给像素缓冲 |
 */
import { nativeImage } from 'electron'
import { assignItemsToSlots as assignGridItems } from '../../../shared/ocr-slot-assignment.mjs'
import type { Rect } from '@shared/ocr-layout'
import { fieldRect, type CardFieldProfile, type FieldBand } from '@shared/ocr-fields'
import { ARCAEA_CARD_FIELDS } from '@shared/games/arcaea/ocr'
import { extractPotential, type OcrItem } from '@shared/ocr'
import {
  extractItems,
  recognizeCrop,
  recognizeLineBest,
  recognizeTitle,
  recognizeJapaneseTitleReadings,
  recognizeFieldReadings,
  upscaleRgbaForLine
} from './onnx-ocr'
import { detectBoxes } from './onnx-detect'

/** 当前引擎 */
export type OcrEngine = 'onnx' | 'paddlejs'

/** 读环境变量决定引擎（默认 paddlejs，保证迁移期间行为不变） */
export function currentOcrEngine(): OcrEngine {
  /*
   * 默认 **paddlejs**：迁移期间保持现状，只有显式指定才走 ONNX。
   * 这样"可回退"是默认安全的——不会因为忘设变量就换掉整条链路。
   */
  const raw = process.env.BEST30_OCR_ENGINE
  const engine: OcrEngine = raw === 'onnx' ? 'onnx' : 'paddlejs'
  /*
   * 打日志确认分派生效（用户实测：设了变量却仍走 PaddleJS，
   * 于是内存又是 4.7GB）。这条日志能直接区分"变量没传到"
   * 与"分派写错"。
   */
  if (!loggedEngine) {
    loggedEngine = true
    console.log(`[ocr] 识别引擎 = ${engine}（BEST30_OCR_ENGINE=${JSON.stringify(raw)}）`)
  }
  return engine
}
/** 引擎日志只打一次，避免每批刷屏 */
let loggedEngine = false

/**
 * **曲名增强 + PTT 定向补读 的总开关**。
 *
 * ## 为什么现在**默认开启**（2026-04 决策）
 *
 * 实测最终配置在**同一张分表**上的成绩（50 格）：
 *
 * | 指标 | 只 PaddleJS | **PaddleJS + ONNX 增强** |
 * |---|---|---|
 * | 曲名 | 45（唯一 44）| **46（唯一 45）** |
 * | 分数 | 50 | **50**（不变）|
 * | PTT | 24 | **32** |
 * | 定数 / 难度 | 47 / 45 | **47 / 46** |
 *
 * 三项提升、两项持平，**没有一项变差**，所以设为默认。
 * （曲名增强与 PTT 补读是"只补空值/只加候选"的设计，
 *   不会覆盖 PaddleJS 已经解出的结果——这是默认安全的关键。）
 *
 * ## 取值
 *
 * ```
 * 不设 / 其它                  **开启**（推荐，默认）
 * BEST30_ONNX_ENHANCE=off     关闭增强，完全回到旧的 PaddleJS 行为
 * BEST30_OCR_ENGINE=onnx      整条链路用 ONNX（PTT 更高但曲名/分数更低）
 * ```
 */
export function titlesEngine(): 'onnx' | 'off' {
  /*
   * 已经整链走 ONNX 时不要再补一次——那会重复分词，
   * 而且分数/PTT 本来就会退回 ONNX 的水平（正是要避免的组合）。
   */
  if (currentOcrEngine() === 'onnx') return 'off'
  // 显式关闭才 off；默认开启
  return process.env.BEST30_ONNX_ENHANCE === 'off' ? 'off' : 'onnx'
}

/**
 * 对**一张完整图片**做识别，返回文本块。
 *
 * PaddleJS 路径由调用方负责（它要走隐藏窗口），所以这里只处理 ONNX；
 * 调用方先问 `currentOcrEngine()`，是 `onnx` 才走本函数。
 */
export async function onnxExtractFromImage(
  image: Electron.NativeImage
): Promise<OcrItem[]> {
  const size = image.getSize()
  const bmp = image.toBitmap()
  return extractItems(new Uint8Array(bmp.buffer, bmp.byteOffset, bmp.byteLength), size.width, size.height)
}

/**
 * 对**一批裁剪图**做识别（ONNX 版）。
 *
 * 与 PaddleJS 的 `recognizeBatch` 同形返回，便于调用方无差别使用。
 *
 * ## 演进过程（三次实测，前面两次都错了）
 *
 * | 做法 | 曲名 | 分数 | PTT | 问题 |
 * |---|---|---|---|---|
 * | ① 逐卡 DB 检测后逐行识别 | 50/50 | 3/50 | 0/50 | 检测把一行切成碎块 |
 * | ② 固定 3 等分横条 | 37/50 | 49/50 | **0/50** | **分数与 Potential 被切进同一条** |
 * | ③ **检测分行 + 逐行放大**（本版）| — | — | — | 见下 |
 *
 * ### ② 的失败细节（关键教训）
 *
 * 3 等分把"分数行"和"Potential 行"切进同一条，识别输出变成：
 * ```
 * "19'967759-845"        ← 分数 9'967759 与 Potential 行的开头 -845 粘在一起
 * "922（+848)F871h"
 * ```
 * 分数其实读对了，但**粘在一起后 `extractPotential` 找不到 `12.3xxx`**，
 * 于是 PTT 全部为 0。
 *
 * ### ③ 现在的做法
 *
 * 在**放大后的卡片**（约 696×300）上做 DB 检测分行 —— 这个分辨率下
 * 检测很准（实测分行清晰：曲名 261×27、分数 405×31、Potential 563×24），
 * 然后**逐行识别**，且每行先 `upscaleRgbaForLine` 放大到字高 ~48px
 * （实测能把 `0'067'750` 修正为 `10'067'750`）。
 *
 * 这样每行都是独立小图，既不会被压扁、也不会跨行粘连。
 */

/**
 * **整图分行**：在**全分辨率整图**上做 ONNX 检测，得到每一行的框。
 *
 * ## 为什么必须回到整图（本轮的关键判断）
 *
 * 我试过四种"在卡片 slot 内部分行"的做法，PTT 始终 0/50，而旧 PaddleJS 是 50/50。
 * 差距的根源是**源分辨率**：
 *
 * | | 旧版 PaddleJS | 我前四次尝试 |
 * |---|---|---|
 * | 行从哪来 | **整图（1800×2092）检测** | 卡片 slot（232×100）×3 |
 * | 行的原始高度 | 高（可直接识别） | 低 3–4 倍 |
 *
 * 卡片 slot 只有 232×100，放大 3 倍也只有 696×300，而一整张卡里有
 * 曲名/分数/Potential 三行 —— 每行只有约 25px 高。
 * **放大补不回已经丢掉的笔画信息**（放大是插值，不是超分）。
 *
 * 所以正确做法是照旧版的路径：**在整图上检测**，此时每行有足够像素，
 * 再逐行识别。
 */
export async function onnxLinesFromFullImage(
  image: Electron.NativeImage,
  opts: { minScore?: number; maxLines?: number } = {}
): Promise<OcrItem[]> {
  const size = image.getSize()
  const bmp = image.toBitmap()
  const rgba = new Uint8Array(bmp.buffer, bmp.byteOffset, bmp.byteLength)
  const boxes = await detectBoxes(rgba, size.width, size.height)
  /*
   * ⚠ 阈值从 0.4 降到 0.2（实测驱动）。
   *
   * 新测试图里有 3 格的曲名**完全没进候选池**：
   *   #10 `Remind the Souls (Short Version)`
   *   #29 `感情の摩天楼 ～Arr.Demetori`
   *   #44 `ヒュブリスの頂に聳えるのは`
   * 但它们在卡面上清晰可见。诊断（dump 的 `diagnostics.extraTitles`）
   * 显示这些曲名行**根本没被采纳**，说明是这里的置信度阈值把它们滤掉了。
   *
   * 降低阈值只影响"整图分行"这一路（PaddleJS 那条链路不受影响），
   * 而多留下的低置信度行随后还要过曲名匹配，不会直接把噪声当结果。
   */
  const minScore = opts.minScore ?? 0.2
  const maxLines = opts.maxLines ?? 600
  const items: OcrItem[] = []
  for (const b of boxes.slice(0, maxLines)) {
    /*
     * 裁出该行。
     *
     * ⚠ **要放大 2 倍**（实测关键）。
     *
     * 整图上的行高度只有 14–18px，而识别模型训练时字高约占 30–40px。
     * 不放大时模型要"把小字再缩小到 48 里"，小数点会丢：
     * ```
     * "POTENTIAL 3.47 > 11.1073"  →  "rotenuaL3.4711.10734"   ← 小数点丢失
     * ```
     * 放大 2 倍后模型是"缩下来"而不是"压上去"，笔画得以保留。
     */
    const sub = new Uint8Array(b.w * b.h * 4)
    for (let y = 0; y < b.h; y++) {
      const sy = b.y + y
      if (sy < 0 || sy >= size.height) continue
      const off = (sy * size.width + b.x) * 4
      sub.set(rgba.subarray(off, off + b.w * 4), y * b.w * 4)
    }
    /*
     * **曲名行单独识别**（只用 v4-mobile）。
     *
     * 曲名没有"字段形态"可判（不像分数有 7–8 位、PTT 有至少三位小数），
     * 所以字段择优对它是无效的，反而会让 v5 的通用文本偏好胜出
     * （实测曲名因此从 45 掉到 31）。这里先拿一次 v4 的读数，
     * 按"是否像曲名"分流到不同的识别策略。
     */
    const probe = await recognizeTitle(sub, b.w, b.h)
    const isTitleLine =
      !/\d/.test(probe.text) && /[A-Za-z\u3040-\u30ff\u4e00-\u9fff]{3,}/.test(probe.text)
    const r = isTitleLine ? probe : await recognizeLineBest(sub, b.w, b.h)
    if (!r.text || r.score < minScore) continue
    items.push({ text: r.text, x: b.x, y: b.y, w: b.w, h: b.h })
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x)
  return items
}

/**
 * **PTT 定向补识别**：只挑出整图里的"Potential 行"，用 v5 重读。
 *
 * ## 为什么按字段补，而不是整条链路换
 *
 * 实测两条链路互补，各有明显优势：
 *
 * | 指标 | A 方案（PaddleJS 全程）| 完整 ONNX |
 * |---|---|---|
 * | 曲名 | **46** | 34 |
 * | 分数 | **50** | 23 |
 * | **PTT** | 24 | **40** |
 *
 * 所以最理想的是"**按字段**各取所长"：PaddleJS 保住曲名与分数，
 * 只在它**确实没读出 PTT** 的格子上，用 v5 重读 Potential 行
   * （v5 的优势正是"能读对小数点"，而字段带按版式允许至少 3 位小数）。
 *
 * ## 为什么只回传"含 TENTIAL 的行"
 *
 * 复用 `assignItemsToSlots` 分派到各格，但**只回传 Potential 行**：
 * 其它行（分数/曲名/判定）已经由 PaddleJS 读得更好，
 * 混进来只会污染它。
 *
 * 代价可控：约 26 格需要补读，每格一次检测 + 一次识别（约 50ms），
 * 总计 1–2 秒。
 */
export async function onnxPotentialLines(
  image: Electron.NativeImage
): Promise<OcrItem[]> {
  const size = image.getSize()
  const bmp = image.toBitmap()
  const rgba = new Uint8Array(bmp.buffer, bmp.byteOffset, bmp.byteLength)
  const boxes = await detectBoxes(rgba, size.width, size.height)
  const out: OcrItem[] = []
  for (const b of boxes) {
    /*
     * 先做一次廉价预筛：Potential 行的框通常比较宽（>120px）
     * 且不太高，能过滤掉大量小的碎片与数字块。
     */
    if (b.w < 120 || b.h < 10 || b.h > 40) continue
    const sub = new Uint8Array(b.w * b.h * 4)
    for (let y = 0; y < b.h; y++) {
      const sy = b.y + y
      if (sy < 0 || sy >= size.height) continue
      const off = (sy * size.width + b.x) * 4
      sub.set(rgba.subarray(off, off + b.w * 4), y * b.w * 4)
    }
    const r = await recognizeLineBest(sub, b.w, b.h)
    /*
     * 只保留"确实是 Potential 行"的读数：必须同时出现
     * **POTENTIAL 的误读形态**（`TENTIAL` 等）**或**至少三位小数。
     * 这样既不会把分数行误当 PTT，也不会漏掉词被读坏的 PTT 行。
     */
    if (!/tential|tial|TTIAL|TENTAL/i.test(r.text) && !/\d[.·]\d{3,}/.test(r.text)) continue
    out.push({ text: r.text, x: b.x, y: b.y, w: b.w, h: b.h })
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x)
  return out
}

/**
 * **按几何直接读"曲名带"与"PTT 带"**（不依赖检测、不依赖跨格归属）。
 *
 * ## 为什么这是正确的做法（用户实测暴露的根因）
 *
 * 用户实测这张图时，曲名有 7 格读错、**PTT 有 11 格读成了相邻卡的值**
 * （#1→#6、#9→#4、#16→#11、#28→#23…，实测有 4 对**完全相同**的值）。
 *
 * 我先做了纵向扫描，几何关系**完全确定**（以 `slot.rect.y` 为基准）：
 *
 * | 相对 `slot.rect.y` | 内容 | 实测读数 |
 * |---|---|---|
 * | **`+0 ~ +30`** | **曲名行** | `感情の摩天楼~Ar.Dem.#29` |
 * | `-25` | 分数行 | `9'877'455` |
 * | **`+45 起`** | **Potential 行** | `tetal97>114164NC` |
 * | `+35` | 判定行 | `156(+986F.19L26d` |
 *
 * 既然每格的**行位置相对它自己的 slot 是固定的**，就应该
 * **"每格只读自己的带"**——这样根本不存在跨格归属，
 * 也就不会出现"同一行被多格重复取用"。
 *
 * 对比原来的做法（整图分行 → 按锚点归属到各格）：那需要把行
 * 正确分派到 50 个格子，而 slot 几何在这个图上偏差很大，
 * 分派必然出错。**几何直读把这个问题彻底绕开了。**
 */
/**
 * **版式B 字段带诊断数据**（供 `_ocr-dump.json` 落盘）。
 *
 * ## 为什么需要
 *
 * 版式B 的字段带位置一直难调：只能看到 `extraTitles` / `potExtra` 里的
 * **文本**，看不到"这段文本是从哪个矩形裁出来的"。
 * 没有"带裁到哪"这个直接证据，就只能靠叠加图反复目测，
 * 结果在 4 个轮次里才找到真正的根因（参照系混用）。
 *
 * 有了本记录，一眼就能看出带偏了多少、该往哪挪。
 *
 * 只记最近一次识别的结果（每次 `onnxTitleBands` 开始时重置）。
 */
export interface BandDebugEntry {
  /** 第几个格位（与 `slot.index` 一致） */
  index: number
  /** 该格各字段的"裁剪矩形 + 原始读数" */
  bands: Array<{ name: string; rect: { x: number; y: number; w: number; h: number }; text: string; candidates?: string[] }>
}

let lastBandDebug: BandDebugEntry[] = []

/** 取最近一次版式带识别的诊断（供主流程写入 dump） */
export function takeBandDebug(): BandDebugEntry[] {
  return lastBandDebug
}

export async function onnxTitleBands(
  image: Electron.NativeImage,
  slots: Array<{ index: number; rect: { x: number; y: number; w: number; h: number } }>,
  profile: CardFieldProfile = ARCAEA_CARD_FIELDS
): Promise<Map<number, { title: string; titles: string[]; constant: string; constantTexts: string[]; potential: string; potentialTexts: string[]; faults: string }>> {
  const out = new Map<number, { title: string; titles: string[]; constant: string; constantTexts: string[]; potential: string; potentialTexts: string[]; faults: string }>()
  const size = image.getSize()

  const readBand = async (card: Rect, band: FieldBand, readings = false) => {
    let rect = fieldRect(card, band, size.width, size.height)
    if (rect.w < 8 || rect.h < 4) return { text: '', score: 0, readings: [] as Array<{ text: string; score: number }> }
    let crop = image.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    if (band.ink) {
      const bitmap = crop.toBitmap()
      let top = rect.h
      let bottom = -1
      for (let y = 0; y < rect.h; y++) {
        let count = 0
        for (let x = 0; x < rect.w; x++) {
          const p = (y * rect.w + x) * 4
          const [blue, green, red] = [bitmap[p], bitmap[p + 1], bitmap[p + 2]]
          const ink = band.ink === 'yellow'
            ? red > blue + 15 && green > blue + 15
            : red > green + 10 && blue > green + 5
          if (ink) count++
        }
        if (count >= 2) { top = Math.min(top, y); bottom = y }
      }
      // 颜色只用来定位文字上下沿，保留原图抗锯齿；不把二值化噪声送进模型。
      if (bottom < top) return { text: '', score: 0, readings: [] as Array<{ text: string; score: number }> }
      const y0 = Math.max(0, top - 1)
      const y1 = Math.min(rect.h, bottom + 2)
      rect = { ...rect, y: rect.y + y0, h: y1 - y0 }
      crop = image.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    }
    const bitmap = crop.toBitmap()
    const up = upscaleRgbaForLine(bitmap, rect.w, rect.h, 48, 4)
    const result = await recognizeCrop(up.data, up.w, up.h)
    return { ...result, readings: readings ? await recognizeFieldReadings(up.data, up.w, up.h) : [] }
  }

  lastBandDebug = []
  for (const slot of slots) {
    const title = await readBand(slot.rect, profile.title)
    const titleRect = fieldRect(slot.rect, profile.title, size.width, size.height)
    const titleCrop = image.crop({ x: titleRect.x, y: titleRect.y, width: titleRect.w, height: titleRect.h })
    const japanese = await recognizeJapaneseTitleReadings(titleCrop.toBitmap(), titleRect.w, titleRect.h)
    const titles = [title.text, ...japanese.map(read=>read.text)]
    const constant = profile.constant ? await readBand(slot.rect, profile.constant, true) : null
    // 保留两套数字模型的原始读数；整行择优会丢掉其中一套的小数点。
    const ptt = await readBand(slot.rect, profile.potential, true)
    /*
     * **记录诊断**：每格每条带的"裁剪矩形 + 原始读数"。
     *
     * 没有这条记录时，只能看到 `extraTitles` 里的文本，
     * 无法判断它来自哪个矩形——版式B 的带位置因此反复盲调。
     */
    lastBandDebug.push({
      index: slot.index,
      bands: [
        { name: 'title', rect: titleRect, text: title.text,
          candidates: titles.filter(Boolean) },
        ...(profile.constant ? [{ name: 'constant', rect: fieldRect(slot.rect, profile.constant, size.width, size.height), text: constant?.text ?? '',
          candidates: constant?.readings.map((reading) => reading.text).filter(Boolean) ?? [] }] : []),
        { name: 'potential', rect: fieldRect(slot.rect, profile.potential, size.width, size.height), text: ptt.text,
          candidates: ptt.readings.map((reading) => reading.text).filter(Boolean) }
      ]
    })
    /*
     * **按版式校验 PTT 的小数位数**。
     *
     * 两种版式的卡面精度不同（见 `FieldBand.potentialDecimals`）：
     *   - 第三方 bot：3–4 位（`Potential 10.9 > 12.6306 NC`）
     *   - 官方订阅   ：至少 2 位（`POTENTIAL 11.87`）
     *
     * 读取侧按版式传入的最小位数筛选，并额外检查 9.0–13.5 值域。
     *
     * ⚠ 整数部分仍要求 **≥2 位**：官方分表的这张卡上同时印着定数 `11`
     * 与 PTT `11.87`，而第三方 bot 的卡上有 `10.9`（一位整数）——
     * 要求两位整数可以排除定数类的误读。这是"宁可缺，不可错"的取舍。
     */
    // 版式A 真值中同时有 3 位和 4 位小数；版式B 由字段配置声明最小位数。
    const decimals = profile.potential.potentialDecimals ?? 3
    const potentialCandidates = [ptt.text, ...ptt.readings.map((reading) => reading.text)]
      .map((text) => {
        const value = extractPotential(text, decimals)
        if (!value || value.text.startsWith('恢复:') || value.value < 9 || value.value > 13.5) return null
        return { text, value: value.value }
      })
      .filter((candidate): candidate is { text: string; value: number } => candidate !== null)
    const distinctPotentialValues = new Map<number, string>()
    for (const candidate of potentialCandidates) {
      if (!distinctPotentialValues.has(candidate.value)) distinctPotentialValues.set(candidate.value, candidate.text)
    }
    // Keep readings with the same numeric value: their clear-status suffixes
    // can disagree, and the parser must be able to preserve that uncertainty.
    const potentialTexts = [...new Set(potentialCandidates.map(candidate => candidate.text))]
    const potential = distinctPotentialValues.size === 1
      ? `Potential > ${[...distinctPotentialValues.keys()][0]}`
      : ''
    const faultParts: string[] = []
    /*
     * `far`/`lost` 是可选带：官方订阅查分功能的分表卡面**没有判定数行**，
     * 此时两条带都为 undefined，直接跳过（不猜、不留错值）。
     */
    for (const [label, band] of [['F', profile.far], ['L', profile.lost]] as const) {
      if (!band) continue
      const isolated = await readBand(slot.rect, band, true)
      const natural = await readBand(slot.rect, band.alternate ?? band, true)
      const counts = new Set<number>()
      for (const result of [...isolated.readings, ...natural.readings]) {
        const text = result.text.replace(/^[FL][:;.\s]*/i, '').replace(/[Oo]/g, '0')
        const value = /^[^\d]{0,2}(\d{1,3})[^\d]*$/.exec(text)
        if (value && result.score >= 0.5) counts.add(Number(value[1]))
      }
      // 模型或裁剪读数冲突时留空，不以最高置信度替用户猜 5/6、2/21。
      if (counts.size === 1) faultParts.push(`${label}:${[...counts][0]}`)
    }
    const constantTexts = constant
      ? [constant.text, ...constant.readings.map((reading) => reading.text)].filter(Boolean)
      : []
    out.set(slot.index, {
      title: title.text,
      titles,
      constant: constant?.text ?? '',
      constantTexts: [...new Set(constantTexts)],
      potential,
      potentialTexts,
      faults: faultParts.join(' ')
    })
  }
  return out
}

/**
 * 剥掉 OCR 曲名尾部粘着的**位次标号/时间标**。
 *
 * 实测形态：`感情の摩天楼~Ar.Dem.#29`、`RemindtheSoulsSho10`、
 * `ュブリスの頂にえる…44`。这些尾部会显著拉低相似度，
 * 剥掉后再匹配能救回不少格子。
 *
 * 只剥"确定是噪声"的尾巴：`#数字`、纯数字、单个标点。
 * 不动中间的字符，避免把真曲名削短。
 */
export function stripRankTail(text: string): string {
  let s = text
  // 去掉尾部标点/省略号
  s = s.replace(/[.．·・…、,，~～\-\s]+$/, '')
  // `#12` / `No.12` / `×12`
  s = s.replace(/[#＃*＊×xX]\s*\d{1,3}$/, '')
  // 纯数字尾巴（如 `Sho10`、`…44`、`7d`、`18d`）
  s = s.replace(/\d{1,3}[dhm]?$/, '')
  // 再清一次尾部标点
  s = s.replace(/[.．·・…、,，~～\-\s]+$/, '')
  return s.trim()
}

/** Assign full-image lines once using the calibrated grid, even when score OCR fails. */
export function assignItemsToSlots<
  T extends { rect: { x: number; y: number; w: number; h: number } }
>(items: OcrItem[], slots: T[]): Map<number, OcrItem[]> {
  return assignGridItems(items, slots)
}

export async function onnxRecognizeCrops(
  crops: Array<{ index: number; dataUrl: string }>,
  opts: { detect?: boolean } = {}
): Promise<Array<{ index: number; ok: boolean; items?: OcrItem[]; error?: string }>> {
  const out: Array<{ index: number; ok: boolean; items?: OcrItem[]; error?: string }> = []
  const useDetect = opts.detect !== false
  for (const crop of crops) {
    try {
      const image = nativeImage.createFromDataURL(crop.dataUrl)
      if (image.isEmpty()) {
        out.push({ index: crop.index, ok: false, error: '裁剪图解码失败' })
        continue
      }
      const size = image.getSize()
      const bmp = image.toBitmap()
      const rgba = new Uint8Array(bmp.buffer, bmp.byteOffset, bmp.byteLength)
      const items: OcrItem[] = []

      const boxes = useDetect ? await detectBoxes(rgba, size.width, size.height) : []
      if (boxes.length === 0) {
        // 退化路径：整块当一行识别（检测失败时至少不丢数据）
        const up = upscaleRgbaForLine(rgba, size.width, size.height)
        const r = await recognizeCrop(up.data, up.w, up.h)
        if (r.text) items.push({ text: r.text, x: 0, y: 0, w: size.width, h: size.height })
      } else {
        for (const b of boxes) {
          const sub = new Uint8Array(b.w * b.h * 4)
          for (let y = 0; y < b.h; y++) {
            const sy = b.y + y
            if (sy < 0 || sy >= size.height) continue
            const off = (sy * size.width + b.x) * 4
            sub.set(rgba.subarray(off, off + b.w * 4), y * b.w * 4)
          }
          // 逐行识别，并先把行放大到更接近模型训练时的字高
          const up = upscaleRgbaForLine(sub, b.w, b.h)
          const r = await recognizeCrop(up.data, up.w, up.h)
          if (!r.text) continue
          items.push({ text: r.text, x: b.x, y: b.y, w: b.w, h: b.h })
        }
      }
      items.sort((a, b) => a.y - b.y || a.x - b.x)
      out.push({ index: crop.index, ok: true, items })
    } catch (error) {
      out.push({ index: crop.index, ok: false, error: (error as Error).message })
    }
  }
  return out
}
