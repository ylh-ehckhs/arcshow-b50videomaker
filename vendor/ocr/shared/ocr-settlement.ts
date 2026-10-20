/**
 * 单曲结算截图的解析。
 *
 * 与分表长图的区别（决定了解析策略）：
 *   分表长图有几十张小卡，文字很小，检测模型把整图缩到 960×960 后小字会糊掉，
 *   所以必须**先按卡片裁剪再识别**；而结算图只有一张、文字大得多，
 *   **整图一次识别**就能拿到可用结果（实测 1280×960 用 12 秒）。
 *
 * 实测 `arcaea成绩结算截图.png` 的关键文本块（含坐标）：
 *   x=520 y=193  "Xterfusion"        ← 曲名（顶部）
 *   x=503 y=403  "09'855555"         ← 分数（大号）
 *   x=553 y=637  "·PURE·1413"        ← PURE 计数
 *   x=573 y=675  "FAR"   x=659 y=675 "_4"   ← FAR（数字常被读成 _4）
 *   x=568 y=712  "LOST"  x=661 y=711 "_4"
 *   x= 91 y=320  "ETERNAL"  x=89 y=345 "MAXRECALL3"
 *   x=561 y=512  "EX)"               ← 评级
 *
 * 注意：`_4` 是 `14` 的误读，所以判定数的提取要**允许前导下划线/短横线**。
 */

import type { ClearStatus } from './project'
import type { OcrItem } from './ocr'
import { extractAccuracyFrom, extractScore } from './ocr'
import type { ValidateResult } from './ocr-validate'

/** 结算图解析结果（字段可能缺失） */
export interface SettlementCandidate {
  /** 曲名（原样，交给定数表模糊匹配） */
  title: string
  /** 分数 */
  score: number | null
  /** 分数原始文本 */
  scoreRaw: string
  /** Phigros 结算图上的实际准确率；Arcaea 为 null */
  accuracy: number | null
  /** 评级（EX / EX+ / AA / …）与通关状态字样（ETERNAL / MAX RECALL / FULL RECALL） */
  grade: string | null
  /** 由状态字样推断的通关状态 */
  clearStatus: ClearStatus
  /** 判定计数：命中数（PURE / PERFECT）+ 失误数 */
  perfect: number | null
  faults: {
    far: number | null
    lost: number | null
    good?: number | null
    bad?: number | null
    miss?: number | null
  }
  /** 0–1 */
  confidence: number
  /** 每个字段的来源文本 */
  sources: string[]
  /** 需要人工注意的问题 */
  warnings: string[]
  /** 信息性说明 */
  notes: string[]
}

/**
 * 解析结算图时的**可选**上下文。
 *
 * `imageHeight` 很关键：早期用**绝对像素**判断"曲名在图片上三分之一"
 * （`it.y > 300`），一旦调用方把图片放大（实测 2× 后坐标翻倍到 1920 高），
 * 所有候选都会被这个阈值排除，曲名直接变成空。
 * 传入图高后改为**按比例**判断，放大与否都不影响。
 */
export interface SettlementParseOptions {
  /** 图片高度（像素）；缺省时退化为按 y ≤ 300 的经验判断 */
  imageHeight?: number
  /** 游戏 id；不传时按 Arcaea 解析以兼容旧调用方 */
  gameId?: string
}

/**
 * 单曲结算图的识别结果。
 *
 * 与 `SheetOcrResult` 并列放在 shared：主进程产生、渲染层消费，
 * 而渲染层不能从 `src/main` 导入类型（两者是分开的构建产物）。
 */
export interface SettlementOcrResult {
  ok: boolean
  error?: string
  /** 解析出的字段 */
  candidate?: SettlementCandidate
  /** 与定数表交叉校验的结论 */
  validation?: ValidateResult
  /** 原始文本块，供界面展开查看 */
  items: OcrItem[]
  ms: number
}

/**
 * Arcaea 结算界面的状态字样 → 通关状态。
 *
 * 实测卡面会写 `ETERNAL` / `MAX RECALL` / `FULL RECALL` 这类词，
 * 它们对应游戏内语义：
 *   - PURE MEMORY（全 Pure）→ PM
 *   - FULL RECALL（无 Lost）→ FR
 *   - MAX RECALL 也是"无 Lost"的旧称 → FR
 *   - 其它一律 UNKNOWN，交给 PTT 反推
 *
 * ⚠ 这与**评级**（EX / AA / …）不是一回事：早期实现把两者混为一谈，
 * 导致 50 张分表里 33 张产生"状态与 PTT 矛盾"的假警报。
 */
export function clearStatusFromWords(text: string): ClearStatus {
  const s = (text || '').toUpperCase().replace(/\s+/g, '')
  if (/PUREMEMORY|PUREMEMOR/.test(s)) return 'PM'
  if (/FULLRECALL/.test(s)) return 'FR'
  if (/MAXRECALL/.test(s)) return 'FR'
  if (/TRACKLOST/.test(s)) return 'UNKNOWN'
  if (/TRACKCOMPLETE/.test(s)) return 'UNKNOWN'
  return 'UNKNOWN'
}

/** 提取评级：EX+ / EX / AA / A …（结算图里的评级是大号字，常带装饰符） */
export function extractSettlementGrade(items: OcrItem[]): string | null {
  // 按字号降序：评级是这张图里字最大的几块之一
  const big = [...items].sort((a, b) => b.h - a.h)
  for (const it of big) {
    const s = it.text.toUpperCase().replace(/[^A-Z+]/g, '')
    if (/^EX\+?$/.test(s)) return s
    if (/^(AA|AB|A)$/.test(s) && it.h > 40) return s
  }
  return null
}

/**
 * 从"标签 + 数值"型文本块里取数值。
 *
 * 实测会遇到 `_4`（`14` 的误读）、`·PURE·1413`（标签与数值粘在一起）。
 * 因此策略是：先在**同一块**里找标签后面的数字；找不到再到**右侧同高度**的块里找。
 *
 * ⚠ `_4` 的处理很关键：早期实现把非数字字符全删掉，`_4` 变成 `4`——
 * 而 4 落在"判定数"的合理区间里，于是**静默写入了错值**（真实是 14）。
 * 现在把开头的 `_` / `-`（`1` 的常见误读）还原成 `1`。
 */
function normalizeOcrNumber(raw: string): { value: number | null; repaired: boolean } {
  const s = (raw || '').trim()
  // 前导下划线/短横线/竖线是 `1` 的误读（实测 `_4` = 14）
  const leadRepair = /^[_\-\u2502|]+\d/.test(s)
  let t = s.replace(/[_\-\u2502|]/g, leadRepair ? '1' : '')
  // 只保留数字
  t = t.replace(/[^\d]/g, '')
  if (!t || t.length > 5) return { value: null, repaired: false }
  const value = Number.parseInt(t, 10)
  return { value: Number.isFinite(value) ? value : null, repaired: leadRepair }
}

function valueNearLabel(
  items: OcrItem[],
  label: RegExp,
  opts: { maxGapX?: number; maxDy?: number } = {}
): { value: number | null; from: string | null; repaired: boolean } {
  const maxGapX = opts.maxGapX ?? 160
  const maxDy = opts.maxDy ?? 24
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)

  for (const it of sorted) {
    const s = it.text.toUpperCase()
    if (!label.test(s)) continue
    // 同一块内：标签后面跟数字（如 `·PURE·1413`）
    const inline = s.match(/(\d{1,5})\s*$/)
    if (inline) {
      return { value: Number.parseInt(inline[1], 10), from: it.text, repaired: false }
    }
    // 同行右侧：找最近的数字块
    let best: { value: number; from: string; dist: number; repaired: boolean } | null = null
    for (const other of sorted) {
      if (other === it) continue
      if (Math.abs(other.y - it.y) > maxDy) continue
      const gap = other.x - (it.x + it.w)
      if (gap < -8 || gap > maxGapX) continue
      const parsed = normalizeOcrNumber(other.text)
      if (parsed.value === null) continue
      if (!best || gap < best.dist) best = { value: parsed.value, from: other.text, dist: gap, repaired: parsed.repaired }
    }
    if (best) return { value: best.value, from: best.from, repaired: best.repaired }
  }
  return { value: null, from: null, repaired: false }
}

/**
 * 解析结算图。
 *
 * 与分表解析的分工：分表用 `parseCardItems`（按卡裁剪后逐卡解析），
 * 结算图用本函数（整图文本块）。
 */
export function parseSettlementItems(
  items: OcrItem[],
  options: SettlementParseOptions = {}
): SettlementCandidate {
  const gameId = options.gameId ?? 'arcaea'
  const isPhigros = gameId === 'phigros'
  /*
   * 曲名在图片**顶部**，但要按比例判断而不是绝对像素——
   * 实测 1280×960 的原图里曲名在 y=193；若把图放大 2 倍（2560×1920）
   * 它就跑到 y=386，绝对阈值 300 会把它整个排除（曲名变空）。
   */
  const titleBand = options.imageHeight ? options.imageHeight * 0.34 : 300
  const sources: string[] = []
  const warnings: string[] = []
  const notes: string[] = []

  // ---- 分数：取最大的那个 7–8 位数字块 ----
  let score: number | null = null
  let scoreRaw = ''
  for (const it of [...items].sort((a, b) => b.h - a.h)) {
    const s = extractScore(it.text, gameId)
    if (s) {
      score = s.value
      scoreRaw = it.text
      break
    }
  }
  if (score === null) warnings.push('未识别到分数')

  const accuracy = isPhigros
    ? extractAccuracyFrom(items.map((it) => ({ text: it.text, x: it.x, y: it.y })), {
        preferLeftmost: true
      })?.value ?? null
    : null
  if (isPhigros && accuracy === null) warnings.push('未识别到准确率')

  // ---- 曲名 ----
  /*
   * 曲名特征（实测）：在图片上方三分之一、**字号最大**、含拉丁字母或 CJK、
   * 不含大段数字，且不是界面词。
   *
   * ⚠ 实测踩过的坑：初期只按"字号最大"排序，结果取到了 `记忆源点`
   * （界面标签，高 39）而不是 `Xterfusion`（高 60）。
   * 后来加了一层判据：**优先含拉丁字母**的候选——
   * 音游曲名绝大多数是拉丁字母或日文，而中文界面词（记忆源点 / 残片 / 结果）
   * 都是纯 CJK，据此可以稳定区分。
   */
  /*
   * 界面词分两类，匹配方式必须不同：
   *   - 长词（≥5 字，如 TRACKCOMPLETE）用**子串**匹配：OCR 常把它们粘在一起；
   *   - 短词（MAX / PURE / FAR / LOST / 结果 …）必须**整块精确匹配**。
   *
   * ⚠ 实测踩过的坑：初期把 `MAX` 也放进子串正则，结果 `Xterfusion` 里的
   * 字母被匹配到（正则忽略大小写），曲名整个被滤掉，直接变成空。
   */
  const UI_SUBSTR =
    /TRACK|COMPLETE|HIGHSCORE|REWARD|POTENTIAL|FRAGMENT|RESULT|SHARE|RETRY|ETERNAL|RECALL|记忆源点|通关/i
  const UI_EXACT = new Set(
    [
      'MAX',
      'PURE',
      'FAR',
      'LOST',
      'SCORE',
      'PLAYER',
      '残留',
      '残片',
      '结果',
      '分享',
      '重试',
      '返回',
      '搭档',
      'PERFECT',
      'GREAT',
      'GOOD',
      'BAD',
      'MISS'
    ].map((w) => w.toUpperCase())
  )
  const isUiWord = (t: string): boolean => {
    if (UI_SUBSTR.test(t)) return true
    return UI_EXACT.has(t.trim().toUpperCase())
  }

  const scored: Array<{ text: string; score: number }> = []
  for (const it of items) {
    const t = it.text.trim()
    if (!t || t.length < 3) continue
    if (it.y > titleBand) continue // 曲名在顶部（按比例）
    if (isUiWord(t)) continue
    const digits = (t.match(/\d/g) || []).length
    if (digits > 2) continue
    if (!/[\p{L}]/u.test(t)) continue

    // 含拉丁字母（音游曲名的主流写法）大幅加分；纯 CJK 多为界面词
    const latin = (t.match(/[A-Za-z]/g) || []).length
    const latinRatio = latin / t.length
    let score = it.h / 60 // 字号权重（曲名通常是最大的一两块）
    score += latinRatio * 2
    score -= it.y / 2000 // 同一档时偏好更靠上的
    scored.push({ text: t, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const title = scored[0]?.text ?? ''
  if (!title) warnings.push('未识别到曲名')

  // ---- 通关状态与评级 ----
  const joined = items.map((i) => i.text.toUpperCase()).join(' ')
  let clearStatus = clearStatusFromWords(joined)
  const grade = extractSettlementGrade(items)

  // `TRACK COMPLETE` 只说明通关，具体是 PM/FR 要看 MAX RECALL / FULL RECALL
  if (clearStatus === 'UNKNOWN' && /ETERNAL|MAXRECALL/.test(joined.replace(/\s+/g, ''))) {
    clearStatus = 'FR'
    notes.push('状态字样含 ETERNAL / MAX RECALL，按 FR 处理')
  }

  // ---- 判定计数 ----
  const pure = valueNearLabel(items, /PURE|PERFECT/)
  const far = valueNearLabel(items, /FAR/)
  const lost = valueNearLabel(items, /LOST/)
  const good = valueNearLabel(items, /\bGOOD\b/)
  const bad = valueNearLabel(items, /\bBAD\b/)
  const miss = valueNearLabel(items, /\bMISS\b/)
  const hasPhigrosJudgements = [good, bad, miss].some((v) => v.value !== null)

  // ---- 汇总置信度 ----
  let got = 0
  if (title) got++
  if (score !== null) got++
  if (pure.value !== null) got++
  if (far.value !== null || lost.value !== null) got++
  let expected = 4
  if (isPhigros) {
    expected = 6
    got = 0
    if (title) got++
    if (score !== null) got++
    if (accuracy !== null) got++
    if (good.value !== null) got++
    if (bad.value !== null) got++
    if (miss.value !== null) got++
  }
  const confidence = got / expected

  if (hasPhigrosJudgements) {
    if (good.value === null || bad.value === null || miss.value === null) {
      warnings.push('Phigros Good / Bad / Miss 判定计数不完整')
    }
  } else if (!isPhigros && pure.value === null && far.value === null && lost.value === null) {
    warnings.push('判定计数一个都没识别到（PURE / FAR / LOST）')
  }
  if (pure.repaired || far.repaired || lost.repaired || good.repaired || bad.repaired || miss.repaired) {
    notes.push('判定数字含误读符号（实测 `14` 被读成 `_4`），已按 `1` 还原，入库前请核对')
  } else if (hasPhigrosJudgements ? (good.value === null || bad.value === null || miss.value === null) : (far.value === null || lost.value === null)) {
    notes.push('有一项判定计数未识别到，入库前请核对')
  }

  for (const it of items) if (it.text.trim()) sources.push(it.text)

  return {
    title,
    score,
    scoreRaw,
    accuracy,
    grade,
    clearStatus,
    perfect: pure.value,
    faults: hasPhigrosJudgements
      ? { far: null, lost: null, good: good.value, bad: bad.value, miss: miss.value }
      : { far: far.value, lost: lost.value },
    confidence,
    sources,
    warnings,
    notes
  }
}
