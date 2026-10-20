/**
 * 工程数据模型。
 *
 * 一个工程（Project）描述"一款游戏的一套 Best N 成绩展示视频"：
 * 游戏 → 若干条目（每个条目 = 一首歌的一个难度）→ 每条的素材与时间 → 全局布局与转场。
 *
 * 设计要点：
 * - 所有版面坐标归一化到 [0,1]，与输出分辨率解耦（输出固定 1920x1080）
 * - 素材只存路径引用，不复制文件（避免数十 GB 占用）
 * - 综合值不入库，一律由公式实时计算（只有 OCR/手填的原始数据入库）
 */

import type { GameDefinition } from './games/types'

export const PROJECT_FILE_VERSION = 1
export const OUTPUT_WIDTH = 1920
export const OUTPUT_HEIGHT = 1080
export const OUTPUT_FPS = 60

/**
 * 通关状态。
 *
 * ## 卡面上真实出现的标记（用户实测标注素材）
 *
 * Arcaea 卡面的 Potential 行尾部会直接印**通关状态的缩写**，
 * 例如 `Potential 10.6 > 12.1414 NC`、`... FR`、`... PM`。
 * 用户的手动标注里大量卡片是 **`NC`**，但早期实现只认 `PM/FR/TC/TL`，
 * 于是**大部分格子被判成 UNKNOWN**——这是用户反馈的
 * "通关状态大部分都标上了未知"的直接原因。
 *
 * | 卡面标记 | 含义 | 计入 PTT 的 +0.2 奖励 |
 * |---|---|---|
 * | `PM` | Pure Memory | ✅ |
 * | `FR` | Full Recall | ✅ |
 * | `TC` | Track Complete（全新称）| ✅ |
 * | `NC` | Normal Clear（**旧称，等同 TC**）| ✅ |
 * | `HC` | Hard Clear（**旧称**）| ✅ |
 * | `TL` | Track Lost | ❌ |
 *
 * ⚠ `NC`/`HC` 与 `TC` 是**同一档**的不同世代写法（v3 前后改的名），
 * 所以计分时它们与 `TC` 等价。
 */
export type ClearStatus = 'PM' | 'FR' | 'TC' | 'NC' | 'HC' | 'TL' | 'UNKNOWN'

/** 通关状态的简短标签（表格列宽有限，完整说明放在 title 提示里） */
export const CLEAR_STATUS_SHORT: Record<ClearStatus, string> = {
  PM: 'PM',
  FR: 'FR',
  TC: 'TC',
  NC: 'NC',
  HC: 'HC',
  TL: 'TL',
  UNKNOWN: '—'
}

export const CLEAR_STATUS_LABELS: Record<ClearStatus, string> = {
  PM: 'PM（Pure Memory）',
  FR: 'FR（Full Recall）',
  TC: 'TC（Track Complete）',
  NC: 'NC（Normal Clear，等同 TC）',
  HC: 'HC（Hard Clear，等同 TC）',
  TL: 'TL（Track Lost）',
  UNKNOWN: '未指定'
}

/** 判定计数。Arcaea: Pure/Far/Lost；Phigros: Perfect/Good/Bad/Miss */
export interface Judgements {
  /** 最优判定（Pure / Perfect）——界面不渲染，用于推导通关状态与评级 */
  top: number | null
  /** 失误判定计数，键名由游戏预设决定（Far/Lost 或 Good/Bad/Miss） */
  faults: Record<string, number | null>
}

/** 综合值计算结果 */
export interface CompositeResult {
  /** 数值（未格式化） */
  value: number
  /** 按游戏规格格式化后的展示串，如 "12.6935" */
  formatted: string
  /** 不参与计分的警告（如 Arcaea 分数低于 9,800,000） */
  warning?: string
  /** 数值为推算而非原始录入 */
  derived?: boolean
}

/** 排序编号的展示前缀风格 */
export type RankingPrefix = 'B' | '#'

/** 渐变色定义 */
export interface GradientSpec {
  kind: 'gradient'
  /** 起始色，CSS 颜色值 */
  from: string
  /** 结束色 */
  to: string
  /** 渐变角度（度），0 = 从上到下 */
  angle: number
}

export interface SolidSpec {
  kind: 'solid'
  color: string
}

export type BackgroundSpec = GradientSpec | SolidSpec

/** 文本在模块内的对齐方式 */
export type TextAlign = 'left' | 'center' | 'right'

/** 可选字体（都用系统自带字体，避免打包字体带来的体积与授权问题） */
export const FONT_FAMILY_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '微软雅黑（默认）', value: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { label: '思源黑体 / Noto', value: '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif' },
  { label: '苹方（macOS）', value: '"PingFang SC", "Microsoft YaHei", sans-serif' },
  { label: '黑体', value: 'SimHei, "Microsoft YaHei", sans-serif' },
  { label: '宋体', value: 'SimSun, "Microsoft YaHei", serif' },
  { label: '楷体', value: 'KaiTi, "Microsoft YaHei", serif' },
  { label: '等线', value: 'DengXian, "Microsoft YaHei", sans-serif' },
  { label: 'Consolas（等宽）', value: 'Consolas, "Courier New", monospace' }
]

/**
 * 单个文字模块的可调样式。
 *
 * 字段全部可选：未设置时使用该模块的内置默认值
 * （见 renderer/src/design.ts 的 MODULE_STYLE_DEFAULTS），
 * 这样旧工程文件无需迁移也能正常渲染。
 */
export interface TextModuleStyle {
  /** 模块内文本对齐方式 */
  align?: TextAlign
  /** 字体族（CSS font-family 值，可含多个备选） */
  fontFamily?: string
  /** 字号倍率（相对该模块的基准字号；1 = 默认） */
  fontScale?: number
  /** 字重，如 400 / 600 / 700 */
  fontWeight?: number
  /** 主文本颜色，如 #ffffff */
  color?: string
}

/** 各文字模块的样式覆盖表 */
export type ModuleStyles = Partial<Record<LayoutModuleId, TextModuleStyle>>

/** 条目使用的素材 */
export interface Materials {
  /** PIP 游玩录像（必填，工具会静音它） */
  pipVideo?: string
  /** 歌曲原声音频（BGM） */
  bgmAudio?: string
  /** 静态背景图（可选，优先于背景色） */
  backgroundImage?: string
  /** 纯色/渐变背景 */
  background: BackgroundSpec
  /** BGA 视频（后续轮次使用；最多 3 条可作背景，其余仅作开场） */
  bgaVideo?: string
  /** BGA 用法：background = 作背景满屏播放；intro = 仅作开场 */
  bgaUsage?: 'background' | 'intro'
  /** 解锁动画（后续轮次使用；只能作开场） */
  unlockVideo?: string
}

/** 时间线上的一个可渲染片段。gapAfter 是片段结束后的缓冲黑场秒数。 */
export interface TimelineEntryItem {
  id: string
  kind: 'entry'
  entryId: string
  gapAfter: number
}

export interface TimelineUnlockItem {
  id: string
  kind: 'unlock'
  /** 解锁动画视频路径 */
  video: string
  /** 从素材第几秒开始取用 */
  sourceStart: number
  /** 在成片中的显示时长 */
  duration: number
  /** 是否保留素材原音 */
  keepAudio: boolean
  gapAfter: number
}

export type TimelineItem = TimelineEntryItem | TimelineUnlockItem

/** 条目时间（秒）。允许小数，渲染时按帧对齐 */
export interface Timing {
  /** PIP 录像从第几秒开始取用 */
  pipStart: number
  /** BGM 从第几秒开始取用；允许大于 0 表示跳过前奏，也可为 0 */
  bgmStart: number
  /** 本条目展示时长（秒） */
  duration: number
}

/** 一个谱面条目 */
export interface Entry {
  /** 稳定 ID */
  id: string
  /** 曲名（必填） */
  title: string
  /** 外号（可选），展示为 曲名/外号 */
  alias?: string
  /** 难度代号，如 FTR / IN（必填） */
  difficulty: string
  /** 难度定数，保留 1 位小数（必填） */
  constant: number | null
  /** 分数原始串（保留用户输入的分隔符，展示原样） */
  scoreRaw: string
  /** 分数数值（解析后，必填） */
  score: number | null
  /** 准确率（百分数）。Arcaea 不用；Phigros 必填，可由判定推算 */
  accuracy: number | null
  /** 通关状态（Arcaea 用） */
  clearStatus: ClearStatus
  /** 判定计数 */
  judgements: Judgements
  /** 谱面评级（可选展示），如 EX / EX+ / V / Φ */
  grade?: string
  /** 短评（可选，≤50 字，支持换行） */
  comment?: string
  /** 素材 */
  materials: Materials
  /** 时间设置 */
  timing: Timing
}

/** 四模块的归一化矩形（左上角 + 宽高，单位 1 = 画面宽/高） */
export interface NormalizedRect {
  x: number
  y: number
  w: number
  h: number
}

export type LayoutModuleId = 'trackInfo' | 'score' | 'comment' | 'pip'

/** 每个模块的版面。背景模块不可调，故不在此列 */
export type Layout = Record<LayoutModuleId, NormalizedRect>

/** 转场类型（全局统一） */
export type TransitionKind = 'fade' | 'black'

export interface TransitionSpec {
  kind: TransitionKind
  /** 单次转场时长（秒） */
  duration: number
}

export interface VideoSpec {
  width: number
  height: number
  fps: number
  /** 容器格式 */
  container: 'mp4' | 'mkv'
  /** 编码方式；auto = 优先硬件编码，失败回退 libx264 */
  encoder: 'auto' | 'libx264'
  /** 视频质量（CRF），仅软编生效 */
  crf: number
}

export interface Project {
  /** 工程文件格式版本 */
  fileVersion: number
  /** 游戏 ID */
  gameId: string
  /** 视频内显示的玩家名（可选） */
  playerName?: string
  /** 排序编号前缀风格 */
  rankingPrefix: RankingPrefix
  /** 条目列表（数组顺序即展示顺序） */
  entries: Entry[]
  /** 条目与解锁动画的轻量时间线；缺失时按 entries 顺序自动生成 */
  timeline: TimelineItem[]
  /** 版面 */
  layout: Layout
  /** 转场 */
  transition: TransitionSpec
  /** 视频输出规格 */
  video: VideoSpec
  /** 背景（全局默认，可被条目覆盖） */
  background: BackgroundSpec
  /** 全局默认背景图，可被条目自己的背景图覆盖 */
  backgroundImage?: string
  /** 文字层全局字号倍率（1 = 默认） */
  fontScale: number
  /**
   * 各文字模块的样式覆盖（对齐/字体/颜色/字号/字重）。
   * 未设置的模块使用内置默认样式。
   */
  moduleStyles?: ModuleStyles
}

/**
 * 默认版面（依据需求文档 3.4 节的"默认位置"约定）
 *
 * 依据用户提供的参考图重新约定默认位置：
 * 标题横贯左上，PIP 占左下大块，成绩/PTT 信息在右侧中部，短评贴右下。
 * 注意 y 是「左上角」坐标，模块高度按实际文字块需求缩小。
 */
export const DEFAULT_LAYOUT: Layout = {
  // 标题：左上，横向贯穿大部分宽度
  trackInfo: { x: 0.03, y: 0.16, w: 0.72, h: 0.14 },
  // PIP：左下，约占画面 58% 宽
  pip: { x: 0.02, y: 0.33, w: 0.6, h: 0.62 },
  // 成绩/PTT：右侧中部，左缘与标题右半段接近
  score: { x: 0.66, y: 0.32, w: 0.31, h: 0.26 },
  // 短评：右下，紧接成绩下方
  comment: { x: 0.66, y: 0.62, w: 0.31, h: 0.22 }
}

export const DEFAULT_TRANSITION: TransitionSpec = {
  kind: 'fade',
  duration: 0.5
}

export const DEFAULT_VIDEO: VideoSpec = {
  width: OUTPUT_WIDTH,
  height: OUTPUT_HEIGHT,
  fps: OUTPUT_FPS,
  container: 'mp4',
  encoder: 'auto',
  crf: 18
}

export const DEFAULT_BACKGROUND: BackgroundSpec = {
  kind: 'gradient',
  from: '#141826',
  to: '#2a1f3d',
  angle: 135
}

export function createEntry(game: GameDefinition, index: number): Entry {
  const faults: Record<string, number> = {}
  for (const f of game.judgement.faults) faults[f] = 0
  return {
    id: `entry-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    title: '',
    difficulty: game.difficulties[game.difficulties.length - 1]?.code ?? '',
    constant: null,
    scoreRaw: '',
    score: null,
    accuracy: null,
    clearStatus: 'UNKNOWN',
    judgements: { top: 0, faults },
    materials: {
      background: { kind: 'gradient', from: '#141826', to: '#2a1f3d', angle: 135 }
    },
    timing: { pipStart: 0, bgmStart: 0, duration: 30 }
  }
}

export function createProject(game: GameDefinition): Project {
  return {
    fileVersion: PROJECT_FILE_VERSION,
    gameId: game.id,
    rankingPrefix: 'B',
    entries: [],
    timeline: [],
    layout: structuredClone(DEFAULT_LAYOUT),
    transition: { ...DEFAULT_TRANSITION },
    video: { ...DEFAULT_VIDEO },
    background: structuredClone(DEFAULT_BACKGROUND),
    fontScale: 1,
    moduleStyles: {}
  }
}

/** 按当前顺序生成排序编号（如 B21 / #21），1-based */
export function rankingLabel(project: Project, index: number): string {
  return `${project.rankingPrefix}${index + 1}`
}

/** 条目总时长（秒）—— 视频总时长 = 各条目时长之和（A-7） */
export function totalDuration(project: Project): number {
  const entries = new Map(project.entries.map((entry) => [entry.id, entry]))
  const timeline = project.timeline?.length
    ? project.timeline
    : project.entries.map((entry) => ({ id: `entry-item-${entry.id}`, kind: 'entry' as const, entryId: entry.id, gapAfter: 0 }))
  return timeline.reduce((sum, item) => {
    const duration = item.kind === 'entry'
      ? Math.max(0, entries.get(item.entryId)?.timing.duration ?? 0)
      : Math.max(0, item.duration)
    return sum + duration + Math.max(0, item.gapAfter ?? 0)
  }, 0)
}

/** 为旧工程补齐时间线，并把旧的单条解锁动画字段迁移为独立片段。 */
export function normalizeProjectTimeline(project: Project): Project {
  const entries = project.entries ?? []
  const current = Array.isArray(project.timeline) ? project.timeline : []
  if (current.length > 0) {
    const known = new Set(entries.map((entry) => entry.id))
    const filtered = current.filter((item) => item.kind === 'unlock' || known.has(item.entryId))
    const present = new Set(filtered.filter((item) => item.kind === 'entry').map((item) => item.entryId))
    for (const entry of entries) {
      if (!present.has(entry.id)) {
        filtered.push({ id: `entry-item-${entry.id}`, kind: 'entry', entryId: entry.id, gapAfter: 0.3 })
      }
    }
    return { ...project, timeline: filtered }
  }

  const timeline: TimelineItem[] = []
  for (const entry of entries) {
    timeline.push({ id: `entry-item-${entry.id}`, kind: 'entry', entryId: entry.id, gapAfter: 0.3 })
    if (entry.materials.unlockVideo) {
      timeline.push({
        id: `unlock-${entry.id}`,
        kind: 'unlock',
        video: entry.materials.unlockVideo,
        sourceStart: 0,
        duration: 5,
        keepAudio: false,
        gapAfter: 0.3
      })
    }
  }
  return { ...project, timeline }
}
