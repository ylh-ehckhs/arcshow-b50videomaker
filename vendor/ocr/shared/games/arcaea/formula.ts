/**
 * Arcaea 单曲 PTT（Potential）计算。
 *
 * 公式口径（由用户提供并逐条确认边界）：
 *   设得分 x、谱面定数 y、通关奖励 bonus
 *     x ≥ 10,000,000        : max(0, y + 2 + bonus)
 *     9,800,000 ≤ x < 10^7  : max(0, y + 1 + (x - 9,800,000) / 200,000 + bonus)
 *     x < 9,800,000         : max(0, y + (x - 9,500,000) / 300,000 + bonus)
 *
 * 已确认的边界规则：
 *   1. 通关奖励在 max() 内部参与计算
 *   2. x = 9,999,999 拿不到 y+2，在 9,800,000 处直接落到 y+1 档（符合游戏真实机制）
 *   3. x < 9,800,000 时在界面给出"不计分"警告
 *   4. x < 9,500,000 时括号内为负，被 max 兜底为 0
 *
 * 通关奖励：
 *   PM / FR / TC → +0.2
 *   TL           → +0
 *
 * 校验证据（用户提供的真实长分表）：
 *   分数 9,958,701、定数 10.7、FR → 10.7 + 1 + (9958701-9800000)/200000 + 0.2 = 12.6935
 *   与卡面显示的 "Potential 10.7 > 12.6935" 完全一致。
 */

import type { ClearStatus, CompositeResult } from '../../project'
import { formatComposite } from '../../formulas/format'

/** 各分数档位的边界值 */
export const ARCAEA_SCORE_MAX = 10_000_000
export const ARCAEA_TIER2_MIN = 9_800_000
export const ARCAEA_TIER3_MIN = 9_500_000

/** 通关奖励值 */
export const ARCAEA_BONUS = 0.2

export function arcaeaClearBonus(status: ClearStatus): number {
  switch (status) {
    case 'PM':
    case 'FR':
    case 'TC':
    case 'NC':
    case 'HC':
      return ARCAEA_BONUS
    case 'TL':
    case 'UNKNOWN':
    default:
      return 0
  }
}

/**
 * 计算括号内的原始值（未做 max 下限保护），便于测试与解释。
 */
export function arcaeaRawSinglePotential(
  score: number,
  constant: number,
  bonus: number
): number {
  if (score >= ARCAEA_SCORE_MAX) {
    return constant + 2 + bonus
  }
  if (score >= ARCAEA_TIER2_MIN) {
    return constant + 1 + (score - ARCAEA_TIER2_MIN) / 200_000 + bonus
  }
  return constant + (score - ARCAEA_TIER3_MIN) / 300_000 + bonus
}

export interface ArcaeaInput {
  score: number
  constant: number
  clearStatus: ClearStatus
}

/**
 * 计算 Arcaea 单曲 PTT。
 * @returns 结果对象，warning 非空时表示该成绩不计分（低于 9,800,000）
 */
export function arcaeaSinglePotential(input: ArcaeaInput): CompositeResult {
  const { score, constant, clearStatus } = input
  if (!Number.isFinite(score) || !Number.isFinite(constant)) {
    return { value: 0, formatted: formatComposite(0, 4, 'truncate') }
  }

  const bonus = arcaeaClearBonus(clearStatus)
  const raw = arcaeaRawSinglePotential(score, constant, bonus)
  const value = Math.max(0, raw)

  let warning: string | undefined
  if (score < ARCAEA_TIER2_MIN) {
    warning = '分数低于 9,800,000，该成绩不计入 Potential'
  }

  return {
    value,
    formatted: formatComposite(value, 4, 'truncate'),
    warning
  }
}

/** 便捷函数：只要数值 */
export function arcaeaSinglePotentialValue(input: ArcaeaInput): number {
  return arcaeaSinglePotential(input).value
}

/**
 * Arcaea 全局 Potential = Best 30 与 Recent 10 的加权平均。
 * 本工具只展示 Best N，因此提供无 Recent 时的 Best N 平均（用于校验长分表的 Top10/Top50 平均）。
 */
export function arcaeaAverage(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
