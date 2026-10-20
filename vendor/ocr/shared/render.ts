/**
 * 渲染与导出任务的数据结构。
 *
 * 渲染管线（对应需求 9.5 的两条路径）：
 *   - 静态层（背景/曲目信息/成绩/短评）→ 用 Chromium 渲染一次，导出 PNG
 *   - 每个条目 → ffmpeg 把 [背景图 + 文字层 + PIP 视频 + BGM 音频] 合成一张 1080p60 片段
 *   - 全部条目 → 按转场设置拼接为最终视频
 *
 * 分层素材导出（F-9.7/F-9.9）：只导出背景、曲目信息、成绩、短评四层 PNG，
 * 不含 PIP，背景层也不预留 PIP 占位。
 */

import type { BackgroundSpec, Entry, Layout, Project } from './project'
import type { DesignLayers } from './design'

/** 单个条目的渲染素材（渲染进程计算好的绝对路径） */
export interface EntryRenderSpec {
  entryId: string
  /** 各文字层的内容（由渲染进程生成，离屏窗口照此绘制） */
  layers: DesignLayers
  /** 版面（归一化） */
  layout: Layout
  /** 背景图（媒体服务 URL，可选） */
  backgroundImageUrl?: string
  /** 素材路径 */
  pipVideo?: string
  bgmAudio?: string
  /** 时间设置 */
  pipStart: number
  bgmStart: number
  duration: number
}

export interface TimelineRenderItem {
  id: string
  kind: 'entry' | 'unlock'
  entryId?: string
  video?: string
  sourceStart?: number
  duration: number
  keepAudio?: boolean
  gapAfter: number
}

/** ffmpeg 可用的硬件编码器探测结果 */
export type HardwareEncoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | null

export interface ExportRequest {
  project: Project
  /** 每个条目的渲染规格 */
  entries: EntryRenderSpec[]
  /** 时间线顺序；缺失时按 entries 顺序导出 */
  timeline?: TimelineRenderItem[]
  /** 输出文件路径 */
  outputPath: string
  /** 转场 */
  transition: Project['transition']
  /** 视频规格 */
  video: Project['video']
  /** 工作目录（存放中间文件） */
  workDir: string
  /** 是否只导出分层素材而不合成视频 */
  layersOnly: boolean
}

export interface ExportResult {
  ok: boolean
  outputPath?: string
  /** 分层素材输出目录 */
  layersDir?: string
  error?: string
  /** 各阶段耗时（毫秒） */
  timings: Record<string, number>
  /** 生成的中间文件数量 */
  artifactCount: number
}

/** 渲染单张静态层 PNG 的请求（渲染进程内使用） */
export interface LayerRenderRequest {
  entry: Entry
  /** 排序编号展示文本，如 B21 */
  ranking: string
  layout: Layout
  background: BackgroundSpec
  /** 是否隐藏 PIP 占位（分层导出时不显示） */
  showPip: boolean
}
