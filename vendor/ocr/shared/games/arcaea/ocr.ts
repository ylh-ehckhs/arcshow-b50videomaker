import type { LayoutTemplate } from '../../ocr-layout/types'
import type { CardFieldProfile } from '../../ocr-fields'
import type { OcrGameProfile } from '../ocr-types'

/** Player Bests 的字段比例；分开裁 F/L，避免压缩长行及右侧时间标。 */
export const ARCAEA_CARD_FIELDS: CardFieldProfile = {
  title: { x: -0.08, y: 0.03, w: 1.08, h: 0.25 },
  // 定数印在 Potential 标签后的左侧；与 PTT 带分开，避免把 12.x PTT 读成定数。
  constant: { x: 0.28, y: 0.54, w: 0.20, h: 0.25 },
  // 真值中有 3 位与 4 位小数；这里表示字段解析允许的最小位数。
  potential: { x: 0.35, y: 0.54, w: 0.58, h: 0.25, potentialDecimals: 3 },
  far: { x: 0.38, y: 0.72, w: 0.26, h: 0.28, ink: 'yellow', alternate: { x: 0.38, y: 0.77, w: 0.26, h: 0.23 } },
  lost: { x: 0.62, y: 0.72, w: 0.26, h: 0.28, ink: 'pink', alternate: { x: 0.62, y: 0.77, w: 0.26, h: 0.23 } }
}

export const ARCAEA_PLAYER_BESTS: LayoutTemplate = {
  family: 'arcaea-player-bests',
  projection: 'brightness',
  cols: 5,
  rows: 10,
  firstColX: 0.0729,
  colPitch: 0.1955,
  colWidth: 0.1234,
  firstRowY: 0.2502,
  rowPitch: 0.0713,
  rowHeight: 0.0569
}

export const ARCAEA_OCR_PROFILE: OcrGameProfile = {
  gameId: 'arcaea',
  projection: 'brightness',
  templates: [ARCAEA_PLAYER_BESTS],
  fields: ARCAEA_CARD_FIELDS,
  scoreRange: { min: 8_000_000, max: 10_002_221 },
  scorePattern: /^\D{0,2}\d{2}[.,:°'"]?\d{2,3}[.,:°'"]?\d{3}\D{0,2}$/
}
