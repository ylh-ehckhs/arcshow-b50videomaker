/**
 * 条目校验与综合值计算调度。
 *
 * 单一入口 computeEntry(gameId, entry)，把"哪种游戏用哪个公式"的差异
 * 全部收在这一层，UI 与渲染层只调用它。
 */

import type { CompositeResult, Entry } from './project'
import type { GameDefinition } from './games/types'
import { requireGame } from './games/presets'
import { arcaeaSinglePotential } from './formulas/arcaea'
import { formatScore, normalizeDifficultyCode } from './parse'

export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  field: string
  severity: ValidationSeverity
  message: string
}

export interface EntryComputation {
  /** 综合值结果（可能为 null：数据不全时无法计算） */
  composite: CompositeResult | null
  /** 实际参与计算的准确率（Arcaea 不使用） */
  effectiveAccuracy: number | null
  /** 准确率是否为推算值 */
  accuracyDerived: boolean
  /** 格式化后的分数（展示用） */
  scoreText: string
  /** 校验问题列表 */
  issues: ValidationIssue[]
  /** 是否可用于渲染（无 error 级问题） */
  renderable: boolean
}

/** 该条目是否使用准确率 */
export function entryUsesAccuracy(game: GameDefinition): boolean {
  return game.usesAccuracy
}

/**
 * 计算条目的全部派生数据。
 */
export function computeEntry(gameId: string, entry: Entry): EntryComputation {
  const game = requireGame(gameId)
  const issues: ValidationIssue[] = []

  // ---- 基础字段校验 ----
  if (!entry.title.trim()) {
    issues.push({ field: 'title', severity: 'error', message: '曲名不能为空' })
  }

  const difficultyCode = normalizeDifficultyCode(entry.difficulty)
  const knownDifficulty = game.difficulties.some((d) => d.code === difficultyCode)
  if (!difficultyCode) {
    issues.push({ field: 'difficulty', severity: 'error', message: '难度不能为空' })
  } else if (!knownDifficulty) {
    issues.push({
      field: 'difficulty',
      severity: 'warning',
      message: `${game.name} 的预设难度不含 ${difficultyCode}`
    })
  }

  if (entry.constant === null) {
    issues.push({ field: 'constant', severity: 'error', message: '难度定数不能为空' })
  } else if (entry.constant < 1 || entry.constant > 16) {
    issues.push({
      field: 'constant',
      severity: 'warning',
      message: `定数 ${entry.constant} 超出常见范围（1.0–16.0）`
    })
  }

  if (entry.score === null) {
    issues.push({ field: 'score', severity: 'error', message: '分数不能为空' })
  } else if (entry.score > game.score.max) {
    issues.push({
      field: 'score',
      severity: 'error',
      message: `分数 ${entry.score} 超过 ${game.name} 的上限 ${game.score.max}`
    })
  }

  // ---- 准确率（当前 Arcaea 预设不使用）----
  let effectiveAccuracy = entry.accuracy
  let accuracyDerived = false
  if (game.usesAccuracy) {
    if (effectiveAccuracy === null) {
      issues.push({ field: 'accuracy', severity: 'error', message: '准确率不能为空' })
    }
  }

  // ---- 综合值 ----
  let composite: CompositeResult | null = null
  if (entry.score !== null && entry.constant !== null) {
    if (game.id === 'arcaea') {
      composite = arcaeaSinglePotential({
        score: entry.score,
        constant: entry.constant,
        clearStatus: entry.clearStatus
      })
    }
  }

  if (composite?.warning) {
    issues.push({ field: 'score', severity: 'warning', message: composite.warning })
  }

  // ---- 素材提示（warning 级，不阻塞排版预览）----
  if (!entry.materials.pipVideo) {
    issues.push({
      field: 'pipVideo',
      severity: 'warning',
      message: '未指定 PIP 录像，导出视频时会缺画中画'
    })
  }
  if (!entry.materials.bgmAudio) {
    issues.push({
      field: 'bgmAudio',
      severity: 'warning',
      message: '未指定歌曲音频，该条目将没有声音'
    })
  }
  if (entry.timing.duration <= 0) {
    issues.push({ field: 'duration', severity: 'error', message: '时长必须大于 0' })
  }

  if (entry.comment && entry.comment.length > 50) {
    issues.push({
      field: 'comment',
      severity: 'warning',
      message: `短评超过 50 字（当前 ${entry.comment.length} 字）`
    })
  }

  return {
    composite,
    effectiveAccuracy,
    accuracyDerived,
    scoreText: entry.score !== null ? formatScore(entry.score, game) : entry.scoreRaw,
    issues,
    renderable: !issues.some((i) => i.severity === 'error')
  }
}

/** 曲目信息模块的展示文本，如 "B21：Nirv lucE/表红 ［FTR］［10.2］" */
export function formatTrackInfo(
  gameId: string,
  entry: Entry,
  ranking: string
): string {
  const game = requireGame(gameId)
  const constant = entry.constant !== null ? entry.constant.toFixed(1) : '—'
  const difficulty = normalizeDifficultyCode(entry.difficulty) || '—'
  const alias = entry.alias?.trim() ? `/${entry.alias.trim()}` : ''
  void game
  return `${ranking}：${entry.title}${alias} ［${difficulty}］［${constant}］`
}
