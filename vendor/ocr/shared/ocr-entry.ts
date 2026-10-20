/**
 * 把 OCR 识别结果转换成可入库的条目候选。
 *
 * 与 `src/shared/ocr-validate.ts` 的分工：
 *   - `ocr-validate` 负责"判断识别得对不对"（匹配曲名、纠错、反推难度与状态）；
 *   - 本模块负责"把它变成一条可以写进工程的成绩"（补齐条目字段、给出置信度与提示）。
 *
 * 全是纯函数，便于对"界面要显示什么"做单测。
 */

import type { ClearStatus } from './project'
import { requireGame } from './games/presets'
import { formatScore } from './parse'
import type { EntryCandidate, OcrItem } from './ocr'
import type { SettlementCandidate } from './ocr-settlement'
import type { ValidateResult } from './ocr-validate'

/** 一个可入库的条目候选 */
export interface EntrySuggestion {
  /** 一行的稳定键（用于界面列表 key 与勾选） */
  key: string
  /** 在原图中的位置（用于回显"这一行来自哪张卡"） */
  source: { index: number; row: number; col: number }
  /** OCR 原始文本块，供界面展开查看 */
  rawItems: OcrItem[]
  /** 最终建议的字段值（已应用校验层的纠错与反推） */
  title: string
  /** 与该卡 OCR 候选对应的定数表曲名，供复核界面直接选择。 */
  titleOptions: Array<{ title: string; constantCompatible: boolean | null }>
  difficulty: string
  constant: number | null
  score: number | null
  scoreRaw: string
  clearStatus: ClearStatus
  /** 单谱综合值（Arcaea 为 PTT） */
  potential: number | null
  /** 兼容旧数据的准确率字段；Arcaea 不使用 */
  accuracy: number | null
  /** 判定数（Far/Lost 或 Good/Bad/Miss） */
  faults: Array<number | null>
  /**
   * 命中数（结算图的 PURE / PERFECT 计数）。
   *
   * 结算图解析一定有，用于推算通关状态（PM 需要 top 等于总判定数）。
   */
  perfect?: number | null
  /** 0–1，来自 OCR 候选的字段命中率；界面用它决定标黄 */
  confidence: number
  /** 是否建议人工复核（校验层给出的结论） */
  review: boolean
  /** 需要人工注意的问题 */
  warnings: string[]
  /** 可信的自动补全说明 */
  notes: string[]
}

/** 判定数的顺序（与游戏预设一致） */
function faultValues(gameId: string, candidate: EntryCandidate): Array<number | null> {
  const game = requireGame(gameId)
  // 预设里 faults 是形如 ['Far','Lost'] 或 ['Good','Bad','Miss']
  return game.judgement.faults.map((name) => {
    const key = name.toLowerCase()
    if (key === 'far') return candidate.faults.far
    if (key === 'lost') return candidate.faults.lost
    if (key === 'good') return candidate.faults.good ?? null
    if (key === 'bad') return candidate.faults.bad ?? null
    if (key === 'miss') return candidate.faults.miss ?? null
    return null
  })
}

/**
 * 把 `grade` 归一成合法的通关状态。
 *
 * ⚠ `NC` / `HC` 必须收下（用户实测反馈）。
 *
 * 卡面的 Potential 行尾部会印通关缩写，而用户标注素材里**大量卡片是 `NC`**。
 * 早期实现只认 `PM/FR/TC/TL`，于是**大部分格子被丢成 UNKNOWN**——
 * 这就是"通关状态大部分都标上了未知"的原因。
 *
 * `NC`（Normal Clear）与 `HC`（Hard Clear）是 `TC` 的**旧世代写法**，
 * 与 `TC` 同档，所以原样保留，由计分层按等价处理。
 */
const VALID_CLEAR_STATUSES: readonly string[] = ['PM', 'FR', 'TC', 'NC', 'HC', 'TL']

function toClearStatus(raw: string | null): ClearStatus {
  const s = (raw ?? '').toUpperCase()
  return VALID_CLEAR_STATUSES.includes(s) ? (s as ClearStatus) : 'UNKNOWN'
}

/**
 * 把一次识别结果里的所有卡片转成条目候选。
 *
 * 会过滤掉"完全没有可用信息"的行（既没曲名也没分数），
 * 因为它们入库后只会变成一堆报错行，没有复核价值。
 */
export function toEntrySuggestions(
  cards: Array<{ index: number; row: number; col: number; items: OcrItem[]; candidate: EntryCandidate; validation: ValidateResult }>,
  gameId: string
): EntrySuggestion[] {
  const game = requireGame(gameId)
  const out: EntrySuggestion[] = []

  for (const card of cards) {
    const { candidate, validation } = card
    const title = validation.matchedTitle ?? candidate.title
    const score = candidate.score
    /*
     * 过滤掉"没有复核价值"的行。
     *
     * 除了"没曲名也没分数"，还要排除**页头类噪声**：长分表的页头块
     * （`ARCAEA`、`PlayerBests`）清理后有时会留下一个短词（实测 `ARCA`），
     * 它虽然不是空串，但既匹配不到定数表、也没有分数，
     * 入库只会变成一条报错记录。
     */
    if (!validation.matchedTitle && score === null) continue
    if (!title && score === null) continue

    const constant = validation.constant.value
    const potential =
      validation.potential.value !== null && !Number.isNaN(validation.potential.value)
        ? validation.potential.value
        : null

    const warnings = [...validation.reasons]
    // 校验层已经在 reasons 里说过"曲名未匹配"，这里不再重复，避免同一句显示两遍
    if (score === null) warnings.push('分数未识别到，必须手工填写')
    if (game.usesAccuracy && candidate.accuracy === null) warnings.push('准确率未识别到，必须手工填写')

    out.push({
      key: `ocr-${card.index}`,
      source: { index: card.index, row: card.row, col: card.col },
      rawItems: card.items,
      title,
      titleOptions: validation.titleOptions,
      difficulty: validation.difficulty ?? (game.difficulties[0]?.code ?? ''),
      constant,
      score,
      scoreRaw: score !== null ? formatScore(score, game) : '',
      clearStatus: toClearStatus(validation.clearStatus),
      potential,
      accuracy: candidate.accuracy ?? null,
      faults: faultValues(gameId, candidate),
      confidence: candidate.confidence,
      review: validation.review,
      warnings,
      notes: validation.notes
    })
  }

  return out
}

/**
 * 把**单曲结算图**的解析结果转成一条可入库候选。
 *
 * 与分表的区别：结算图只有一条记录、没有 PTT 字段，
 * 难度由校验层按"曲名 → 定数表"反推。
 */
export function settlementToSuggestion(
  candidate: SettlementCandidate,
  validation: ValidateResult,
  items: OcrItem[],
  gameId: string
): EntrySuggestion | null {
  const game = requireGame(gameId)
  const title = validation.matchedTitle ?? candidate.title
  if (!title && candidate.score === null) return null

  const warnings = [...validation.reasons, ...candidate.warnings]
  const notes = [...validation.notes, ...candidate.notes]
  if (!validation.matchedTitle) warnings.push('曲名未在定数表中匹配到，入库后需要手工确认')

  return {
    key: 'ocr-settlement-1',
    source: { index: 1, row: 1, col: 1 },
    rawItems: items,
    title,
    titleOptions: validation.titleOptions,
    difficulty: validation.difficulty ?? (game.difficulties[0]?.code ?? ''),
    constant: validation.constant.value,
    score: candidate.score,
    scoreRaw: candidate.score !== null ? formatScore(candidate.score, game) : candidate.scoreRaw,
    clearStatus: candidate.clearStatus,
    potential: null,
    accuracy: candidate.accuracy,
    // 结算图里 Pure / Perfect 是命中数；其余判定按游戏预设输出。
    faults: game.judgement.faults.map((name) => {
      const key = name.toLowerCase()
      if (key === 'far') return candidate.faults.far
      if (key === 'lost') return candidate.faults.lost
      if (key === 'good') return candidate.faults.good ?? null
      if (key === 'bad') return candidate.faults.bad ?? null
      if (key === 'miss') return candidate.faults.miss ?? null
      return null
    }),
    // 顶部那个 PURE/PERFECT 命中数（分表解析不用，结算图用）
    perfect: candidate.perfect,
    confidence: candidate.confidence,
    review: validation.review || warnings.length > 0,
    warnings,
    notes
  }
}

/** 一行是否需要人工复核（界面标黄依据） */
export function needsAttention(row: EntrySuggestion, gameId?: string): boolean {
  void gameId
  return (
    row.review ||
    row.constant === null ||
    row.score === null ||
    !row.title ||
    row.faults.some((value) => value === null) ||
    false
  )
}

/** 汇总：可直接入库 / 需复核 的数量，用于界面上方统计 */
export function summarizeSuggestions(rows: EntrySuggestion[], gameId?: string): {
  total: number
  ready: number
  attention: number
  duplicates: number
} {
  let ready = 0
  let attention = 0
  const seen = new Map<string, number>()
  for (const r of rows) {
    if (needsAttention(r, gameId)) attention++
    else ready++
    const k = `${r.difficulty}\u0000${r.title.trim().toLowerCase()}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  let duplicates = 0
  for (const n of seen.values()) if (n > 1) duplicates += n - 1
  return { total: rows.length, ready, attention, duplicates }
}
