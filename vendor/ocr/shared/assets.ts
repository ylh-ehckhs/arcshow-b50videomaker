import type { Entry } from './project'
import { normalizeTitle } from './tiers'

export type AssetKind = 'video' | 'audio' | 'image'

export interface ScannedAsset {
  path: string
  name: string
  kind: AssetKind
}

export interface AssetMatch {
  pipVideo?: ScannedAsset
  bgmAudio?: ScannedAsset
  backgroundImage?: ScannedAsset
  score: number
}

const EXTENSIONS: Record<AssetKind, Set<string>> = {
  video: new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v']),
  audio: new Set(['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus']),
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])
}

export function assetKindForName(name: string): AssetKind | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  for (const kind of Object.keys(EXTENSIONS) as AssetKind[]) {
    if (EXTENSIONS[kind].has(ext)) return kind
  }
  return null
}

/** Normalize a filename while retaining spaces for the word-level fallback. */
export function normalizeAssetName(name: string): string {
  const withoutExt = name.replace(/\.[^.\\/]+$/, '')
  return withoutExt
    .replace(/[【\[].*?[】\]]/g, ' ')
    .replace(/[（(].*?[）)]/g, ' ')
    .replace(/[_|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function difficultyTerms(code: string): string[] {
  const key = code.trim().toUpperCase()
  const names: Record<string, string[]> = {
    PST: ['pst', 'past'],
    PRS: ['prs', 'present'],
    FTR: ['ftr', 'future'],
    ETR: ['etr', 'eternal'],
    BYD: ['byd', 'beyond'],
    INS: ['ins', 'infinite']
  }
  return names[key] ?? [key.toLowerCase()]
}

function titleScore(entry: Entry, assetName: string): number {
  const haystack = normalizeTitle(assetName)
  const titles = [entry.title, entry.alias].filter((value): value is string => !!value?.trim())
  let best = 0
  for (const title of titles) {
    const needle = normalizeTitle(title)
    if (!needle) continue
    if (haystack === needle) best = Math.max(best, 120)
    else if (haystack.includes(needle)) best = Math.max(best, 90)
    else {
      const words = title.toLowerCase().split(/\s+/).filter(Boolean)
      const hits = words.filter((word) => normalizeTitle(assetName).includes(normalizeTitle(word))).length
      if (words.length > 0 && hits / words.length >= 0.7) best = Math.max(best, 55)
    }
  }
  return best
}

function scoreAsset(entry: Entry, asset: ScannedAsset): number {
  const clean = normalizeAssetName(asset.name)
  const title = titleScore(entry, clean)
  if (title === 0) return 0
  const terms = difficultyTerms(entry.difficulty)
  // Keep the original filename for difficulty tags; normalizeAssetName strips
  // bracketed download labels such as `[Future 10.4]` from the title.
  const normalized = asset.name.toLowerCase()
  const hasDifficulty = terms.some((term) => new RegExp(`(?:^|[^a-z])${term}(?:$|[^a-z])`, 'i').test(normalized))
  return title + (hasDifficulty ? 30 : 0) + (asset.kind === 'image' ? 0 : 1)
}

/** Match local files to an entry. Existing fields remain the caller's responsibility. */
export function matchAssets(entry: Entry, assets: ScannedAsset[]): AssetMatch {
  const best: Partial<Record<AssetKind, { asset: ScannedAsset; score: number }>> = {}
  for (const asset of assets) {
    const score = scoreAsset(entry, asset)
    if (score <= 0) continue
    const current = best[asset.kind]
    if (!current || score > current.score) best[asset.kind] = { asset, score }
  }
  return {
    pipVideo: best.video?.asset,
    bgmAudio: best.audio?.asset,
    backgroundImage: best.image?.asset,
    score: Math.max(0, ...Object.values(best).map((item) => item?.score ?? 0))
  }
}

export function matchAllEntries(entries: Entry[], assets: ScannedAsset[]): Map<string, AssetMatch> {
  return new Map(entries.map((entry) => [entry.id, matchAssets(entry, assets)]))
}
