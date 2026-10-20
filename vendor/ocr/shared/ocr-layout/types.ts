export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface CardSlot {
  /** 从 1 开始的排名序号（按行优先） */
  index: number
  row: number
  col: number
  /** 整张卡片面板的矩形 */
  card: Rect
  /** 卡片内**文字区**（已排掉左侧封面图），OCR 应裁这块 */
  text: Rect
  /**
   * 需要分别 OCR 的附加区域（相对整图坐标）。
   *
   * 只有字段分散的版式才需要（Phigros：难度/定数在左下角，
   * 与右侧的曲名/分数不是同一块文字）。Arcaea 只有 `text` 一块。
   */
  extra?: Array<{ name: string; rect: Rect }>
}

export interface GridDetection {
  /** 检测到的版式族 */
  family:
    | 'arcaea-player-bests'
    | 'generic-grid'
    | (string & {})
  /** 行数与列数 */
  rows: number
  cols: number
  /** 行列步长（像素） */
  rowPitch: number
  colPitch: number
  /** 全部格位（行优先） */
  slots: CardSlot[]
  /** 检测置信度：区段数量与规整度 */
  confidence: number
  /** 供诊断的原始区段 */
  debug: {
    rowRuns: Array<[number, number]>
    colRuns: Array<[number, number]>
  }
}

export interface GrayImage {
  width: number
  height: number
  /** 长度 = width * height */
  data: Uint8Array
}

export interface AnchorCardSpec {
  width: number
  height: number
  dx: number
  dy: number
}

export interface ColumnOffset {
  dx?: number
  width?: number
}

export interface LayoutTemplate {
  family: GridDetection['family']
  projection?: 'brightness' | 'saturation'
  /**
   * **卡片相对背景的明暗极性**。
   *
   * 检测网格时靠"格中心的亮度 vs 格间的亮度"来判断模板是否对得上，
   * 而这个判据的**方向取决于卡与底的明暗关系**：
   *
   * | 取值 | 卡片 | 背景 | 判据 |
   * |---|---|---|---|
   * | `'bright'`（默认）| 亮 | 暗 | 格中心更亮 → 命中 |
   * | `'dark'` | 暗 | 亮 | 格中心更暗 → 命中 |
   *
   * 不写默认 `'bright'`，适用于当前 Arcaea Player Bests 版式 A。
   */
  polarity?: 'bright' | 'dark'
  /** Legacy compatibility fields retained for old callers; the active profile never sets them. */
  assumeGrid?: boolean
  assumeGridMaxAspect?: number
  textInset?: number
  extraRegions?: Record<string, { x: number; y: number; w: number; h: number }>
  cols: number
  rows: number
  /** 首列左边缘 / 图宽 */
  firstColX: number
  /** 列步长 / 图宽 */
  colPitch: number
  /** 列宽 / 图宽 */
  colWidth: number
  /** 首行上边缘 / 图高 */
  firstRowY: number
  /** 行步长 / 图高 */
  rowPitch: number
  /** 行高 / 图高 */
  rowHeight: number
}
