import type { Rect } from './ocr-layout'

export interface FieldBand extends Rect {
  ink?: 'yellow' | 'pink'
  alternate?: Rect
  /**
   * 该带里 **PTT 的最少小数位数**（只对 `potential` 带有意义，缺省 4）。
   *
   * 两种版式的卡面精度不同：
   *   - 第三方 bot 的分表印 **3–4 位**（`Potential 10.9 > 12.6306 NC`）
   *   - **官方订阅功能**的分表至少印 **2 位**（`POTENTIAL 11.87`）
   *
   * 读取侧必须按版式声明最小位数，不能把某一张卡的显示精度当成全局常量。
   */
  potentialDecimals?: number
}

export interface CardFieldProfile {
  title: FieldBand
  /** Arcaea A 卡片中印刷定数的独立字段带。 */
  constant?: FieldBand
  potential: FieldBand
  /**
   * 判定数带（Far / Lost）。
   *
   * **可选**：并非所有版式都印判定数。Arcaea 官方订阅查分功能的分表
   * （竖卡）卡面上**没有** `P/F/L` 行，所以那两个带对它没有意义，
   * 留空即可（按用户要求，卡面没有的数据转为"待用户补充项"）。
   */
  far?: FieldBand
  lost?: FieldBand
}

/** 字段位置相对卡片文字区定义，只在图像边界裁剪，不混用参考分辨率。 */
export function fieldRect(card: Rect, band: FieldBand, width: number, height: number): Rect {
  const x = Math.max(0, Math.round(card.x + card.w * band.x))
  const y = Math.max(0, Math.round(card.y + card.h * band.y))
  const right = Math.min(width, Math.round(card.x + card.w * (band.x + band.w)))
  const bottom = Math.min(height, Math.round(card.y + card.h * (band.y + band.h)))
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) }
}
