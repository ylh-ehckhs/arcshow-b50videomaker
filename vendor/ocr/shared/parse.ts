/**
 * 输入解析与格式化。
 *
 * 用户录入的分数可能带各种分隔符（09'967'966 / 9,967,966 / 9967966 / 9 967 966），
 * 需求要求"按输入原样显示、解析时容错"，因此这里分成两步：
 *   1. parseScore     —— 宽松解析成数值，用于计算
 *   2. formatScore    —— 按游戏规格格式化成展示串
 */

import type { GameDefinition } from './games/types'
import { roundTo, truncateTo } from './formulas/format'

/**
 * 去除千分位等分隔符，但**保留小数点**。
 *
 * 小数点必须保留：早期版本把它一起当分隔符删掉，导致
 * `parseDuration('12.5')` 得到 125、`parseAccuracy('99.09')` 得到 9909。
 * 分隔符里若传入 '.' 也会被忽略。
 */
export function normalizeNumericText(raw: string, extraSeparators: string[] = []): string {
  let text = raw.trim()
  // 注意不要包含 '-'：它是负号，不是千分位分隔符。
  // 早期版本把 '-' 当分隔符删掉，导致 parseDuration('-1') 得到 1（负数被悄悄转正）。
  const separators = ["'", '’', '＇', ',', '，', ' ', '\u00a0', '\t', '_']
  for (const sep of [...separators, ...extraSeparators]) {
    if (!sep || sep === '.') continue
    text = text.split(sep).join('')
  }
  // 全角数字与全角句点转半角
  text = text
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/。/g, '.')
  return text
}

/**
 * 宽松解析分数。
 * @returns 数值；无法解析时返回 null
 */
export function parseScore(raw: string, game: GameDefinition): number | null {
  if (!raw) return null
  const normalized = normalizeNumericText(raw, game.score.tolerantSeparators)
  if (!/^\d+$/.test(normalized)) return null
  const value = Number.parseInt(normalized, 10)
  if (!Number.isSafeInteger(value)) return null
  return value
}

/**
 * 按游戏规格格式化分数用于展示。
 * Arcaea：每 3 位插入 '，如 9958701 → 9'958'701（**不补前导零**）
 * Phigros：每 3 位插入 ,，如 840244 → 840,244
 *
 * 关于前导零：Arcaea 游戏内结算界面确实显示 9 位（09'958'701），但用户明确要求
 * 分表展示不要补这个 0——8 位就是 8 位。因此这里只用分数本身的位数分组。
 */
export function formatScore(score: number, game: GameDefinition): string {
  if (!Number.isFinite(score)) return ''
  const digits = String(Math.max(0, Math.trunc(score)))
  const sep = game.score.displaySeparator
  if (!sep) return digits
  const parts: string[] = []
  for (let i = digits.length; i > 0; i -= 3) {
    parts.unshift(digits.slice(Math.max(0, i - 3), i))
  }
  return parts.join(sep)
}

/** 解析难度定数（保留 1 位小数）。允许 "10+"/"10.7" 等写法 */
export function parseConstant(raw: string): number | null {
  if (!raw) return null
  const text = normalizeNumericText(raw).replace(/\+/g, '')
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value) || value < 0 || value > 20) return null
  return Math.round(value * 10) / 10
}

/** 解析准确率（百分数）。允许 "99.09"、"99.09%" */
export function parseAccuracy(raw: string): number | null {
  if (!raw) return null
  const text = normalizeNumericText(raw.replace('%', ''))
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value) || value < 0 || value > 100) return null
  return value
}

/** 解析非负整数（判定计数等） */
export function parseNonNegativeInt(raw: string): number | null {
  if (!raw) return null
  const text = normalizeNumericText(raw)
  if (!/^\d+$/.test(text)) return null
  const value = Number.parseInt(text, 10)
  return Number.isSafeInteger(value) ? value : null
}

/** 解析时长（秒，允许 2 位小数） */
export function parseDuration(raw: string): number | null {
  if (!raw) return null
  const text = normalizeNumericText(raw)
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100) / 100
}

/** 难度代号标准化：去掉全角括号/空格，转大写 */
export function normalizeDifficultyCode(raw: string): string {
  return raw
    .replace(/[［\[\]］\s]/g, '')
    .toUpperCase()
}

/** 展示用难度（全角方括号包裹，统一大写） */
export function formatDifficulty(code: string): string {
  return `［${normalizeDifficultyCode(code)}］`
}

/** 展示用定数（1 位小数，如 10.7） */
export function formatConstant(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return truncateTo(value, 1)
}

/** 展示用准确率（2 位小数，如 90.76%） */
export function formatAccuracy(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${roundTo(value, 2)}%`
}
