import type { AnchorCardSpec, ColumnOffset, GrayImage, GridDetection, LayoutTemplate } from '../ocr-layout/types'
import type { CardFieldProfile } from '../ocr-fields'

export interface OcrGameProfile {
  gameId: string
  projection: 'brightness' | 'saturation'
  templates: LayoutTemplate[]
  fields?: CardFieldProfile
  fieldsByFamily?: Record<string, CardFieldProfile>
  /**
   * **按版式族给不同的字段比例**。
   *
   * Arcaea 有两条查分途径，卡片样式差别很大（见 `games/arcaea/ocr.ts`）：
   *   - 第三方 bot → 横卡，字段分散在卡内
   *   - 官方订阅   → 竖卡，字段位置完全不同，且**卡面没有判定数行**
   *
   * 两者的 `CardFieldProfile` 不能共用，所以除默认的 `fields` 外，
   * 再按 `family` 提供覆盖表；查不到时回落 `fields`。
   */
  detectBands?: (image: GrayImage, width: number, height: number, debug: GridDetection['debug']) => GridDetection | null
  minimumTextWidth?: number
  scoreRange: { min: number; max: number }
  scorePattern: RegExp
  anchor?: {
    family: GridDetection['family']
    card: AnchorCardSpec
    columns: number
    clampRight: boolean
    columnOffsets?: ColumnOffset[]
    referenceWidth?: number
  }
}
