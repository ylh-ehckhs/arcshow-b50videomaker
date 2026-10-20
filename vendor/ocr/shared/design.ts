/**
 * 设计稿（design）结构。
 *
 * 渲染进程负责把条目数据加工成"可绘制的设计稿"，离屏渲染窗口只负责
 * 把设计稿画成像素。这样所有业务逻辑留在渲染进程，绘制层保持无脑，
 * 导出时的成图必然与界面预览一致。
 */

import type { BackgroundSpec, Judgements, Layout, TransitionSpec } from './project'

/** 要绘制哪几层 */
export type RenderTarget = 'composite' | 'background' | 'trackInfo' | 'score' | 'comment' | 'pip'

/** 一行文本（成绩模块由多行组成） */
export interface DesignLine {
  text: string
  /** 相对字号倍率 */
  scale?: number
  /** 颜色 */
  color?: string
  /** 字重 */
  weight?: number
  /** 透明度 */
  opacity?: number
  /**
   * 宽度自适应：文本宽度超过模块可用宽度时自动缩小字号。
   * 分数、曲名、综合值这类"必须完整显示在一行"的内容应开启。
   */
  fit?: 'shrink'
  /**
   * 自动换行：文本宽度超过模块可用宽度时按字号自动折行，而不是缩字号。
   * 短评这类"内容可能较长、需要完整展示"的正文应开启。
   * 与 fit 互斥，同时给出时 fit（缩字号）优先。
   */
  wrap?: boolean
  /** 该行的额外左边距（px，基于 1080p 画布），用于缩进 */
  indent?: number
}

/** 一个文字模块的设计 */
export interface DesignPanel {
  /** 模块标题（不渲染，仅调试用） */
  lines: DesignLine[]
  /** 面板背景样式 */
  panel?: {
    /** 背景色（可含 alpha） */
    background?: string
    /** 边框色 */
    border?: string
    /** 圆角（px，基于 1080p 画布） */
    radius?: number
    /** 内边距 */
    padding?: number
    /** 竖向内边距（覆盖 padding 的上下值，用于缩小上下留白） */
    paddingY?: number
  }
  /** 文本对齐 */
  align?: 'left' | 'center' | 'right'
  /** 字体族（CSS font-family），未设置时用默认字体栈 */
  fontFamily?: string
  /**
   * 模块内文字的整体垂直对齐。
   * 'top' 能避免内容较多时被上下留白挤在中间（短评默认用它）。
   */
  verticalAlign?: 'center' | 'top'
}

/** 面板内容集合 */
export interface DesignLayers {
  trackInfo: DesignPanel
  score: DesignPanel
  comment: DesignPanel | null
  /** 原始数据（离屏窗口绘制判定行时可能需要） */
  judgements?: Judgements
}

export interface RenderDesign {
  /** 条目序号（0-based），仅用于调试与文件命名 */
  entryIndex: number
  entryId: string
  /** 要绘制哪些层；缺省为 composite */
  targets?: RenderTarget[]
  /** 版面（归一化坐标） */
  layout: Layout
  /**
   * 只渲染画面的某个矩形区域（视频像素坐标）。
   *
   * 为什么需要：文字层在 ffmpeg 里是"叠加层"，而 Chromium 截图出来的 PNG
   * 是**不透明**的全画幅图。若按全画幅叠加到 (0,0)，就会把 PIP 与背景整个盖住
   * （表现为导出视频全黑）。因此文字层必须**只截取模块自身范围**，再叠加到对应坐标。
   */
  crop?: { x: number; y: number; width: number; height: number }
  /** 背景规格 */
  background: BackgroundSpec
  /** 背景图（已由渲染进程解析成媒体服务 URL） */
  backgroundImageUrl?: string
  /** 文字层内容 */
  layers: DesignLayers
  /** 画布尺寸 */
  video: { width: number; height: number }
  /** 转场（composite 模式下用于绘制遮罩预览） */
  transition?: TransitionSpec
  /** 是否输出透明背景（分层素材导出用） */
  transparent?: boolean
  /** PIP 预览用的媒体 URL（仅界面预览使用，导出时由 ffmpeg 负责 PIP） */
  pipPreviewUrl?: string
  /** 是否在界面上显示 PIP 占位框 */
  showPipGuide?: boolean
  /** 全局字号倍率 */
  fontScale?: number
}
