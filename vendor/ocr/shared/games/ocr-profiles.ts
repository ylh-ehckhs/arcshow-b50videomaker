import type { OcrGameProfile } from './ocr-types'
import { ARCAEA_OCR_PROFILE } from './arcaea/ocr'
export type { OcrGameProfile } from './ocr-types'

export const OCR_PROFILES: OcrGameProfile[] = [ARCAEA_OCR_PROFILE]

export function getOcrProfile(gameId: string): OcrGameProfile {
  const profile = OCR_PROFILES.find((item) => item.gameId === gameId)
  if (!profile) throw new Error(`未配置游戏 OCR：${gameId}`)
  return profile
}
