/**
 * OCR 识别结果与定数表的交叉校验。
 *
 * 为什么必须有这一层：
 *   OCR 在卡面小字上会稳定地出几类错——千位分隔符误读、封面图字符混入曲名、
 *   定数与 PTT 粘连。单靠正则纠错有上限；而**定数表是可信的第三方数据**，
 *   用它反查可以：
 *     1. 把 OCR 读歪的曲名匹配回真实曲名（模糊匹配）；
 *     2. 发现并纠正定数误读（`10.7` 读成 `10.1` 这类）；
 *     3. 用公式反算 PTT 并与卡面值比对，交叉验证整条记录是否自洽。
 *
 * 本模块是纯函数，不依赖 Electron / DOM。
 */

import { arcaeaSinglePotential } from './formulas/arcaea'
import { normalizeTitle, type TierEntry, type TierTable } from './tiers'
import type { ClearStatus } from './project'
import type { EntryCandidate } from './ocr'
import { builtInArcaeaAliases } from './games/arcaea/aliases'

/** 编辑距离（Levenshtein），用于曲名模糊匹配 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/** 归一化后的相似度 0–1（1 表示完全相同） */
export function similarity(
  a: string,
  b: string,
  opts?: { containmentRatio?: number }
): number {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (!x && !y) return 1
  if (x === y) return 1
  const maxLen = Math.max(x.length, y.length)
  if (maxLen === 0) return 1
  const edit = 1 - levenshtein(x, y) / maxLen
  let prefixScore = edit
  const short = x.length <= y.length ? x : y
  const long = x.length <= y.length ? y : x
  // 卡面会用省略号截断长标题。仅在长前缀一致时比较可见部分，且永不算精确命中。
  if (short.length >= 8 && short.length / long.length >= 0.5 && short.slice(0, 6) === long.slice(0, 6)) {
    const visible = 1 - levenshtein(short, long.slice(0, short.length)) / short.length
    if (visible >= 0.75) prefixScore = Math.max(edit, Math.min(0.9, visible * 0.9))
  }
  /*
   * 除编辑距离外还要看**包含关系**。
   *
   * 实测 `ZlRingedGene` ↔ `Ringed Genesis`：OCR 既混入了封面图前缀，
   * 又把尾部截断了（`Gene` 缺 `sis`），编辑距离只有 0.36，
   * 但它完整包含了曲名的主干 `ringedgene`（长度比 12/14 ≈ 0.86）。
   *
   * ⚠ 但包含关系**不能无条件采信**，门槛设低了会出假阳性：
   *   - 权威表里有极短曲名（`In`、`~_+`、`996`），会被任意长曲名"包含"，
   *     于是 `In` 与 `Inverted World` 相似度算成 1、所有曲名都匹配到它。
   *   - 实测另一个坑：门槛 0.5 时 `ARCA` ↔ `Arcahv`（长度比 4/6 ≈ 0.67）
   *     被判为完全包含、相似度 **1.0**，于是长分表页头 `ARCA` 被当成
   *     真实曲目 `Arcahv` 写入——**这是最危险的那类错误：静默写错数据**。
   *
   * 因此要求：被包含方长度 ≥3，且**占较长串 ≥70%**，否则退回编辑距离。
   * 0.7 这个门槛同时满足两边：合法的 `ZlRingedGene`（0.86）通过，
   * 假阳性的 `ARCA`（0.67）被挡下。
   */
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x
  const ratio = (opts?.containmentRatio ?? 0.7)
  const containedEligible = shorter.length >= 3 && shorter.length / longer.length >= ratio
  if (containedEligible) {
    /*
     * ## ⚠ 包含关系**不能判成 1.0**（2026-04 修正）
     *
     * 原实现是 `longer.includes(shorter) ? 1 : ...`，即"只要包含就满分"。
     * 它的意图是救 `ZlRingedGene` ↔ `Ringed Genesis`（OCR 混入封面前缀
     * 又截断了尾部），但代价极高：
     *
     * ```
     * similarity("heriruth", "Sheriruth") = 1.0000   ← 只丢了首字母 S
     * similarity("ZANA",     "IZANA")     = 1.0000   ← 只丢了首字母 I
     * ```
     *
     * 用户实测由此**静默写错了大量曲名**（`heriruth`→Sheriruth 被当成
     * 100% 匹配、直接标"可入库"）。这是最危险的那类错误。
     *
     * 现在改为：包含关系只给**上限 0.9 的加成**，实际值按覆盖率算。
     * 于是"差一个字母"的匹配会落到 0.8x–0.9，**低于"无需复核"的门槛**
     * （`< 0.999` 会写进 `notes` 提示校正、`< 0.7` 直接标复核），
     * 由人确认——而不是假装 100% 确定。
     */
    const shorterIsContained = longer.includes(shorter)
    const coverage = shorterIsContained
      ? shorter.length / longer.length
      : longestCommonSubstringRatio(x, y)
    const capped = Math.min(0.9, coverage)
    return Math.max(prefixScore, capped)
  }
  return prefixScore
}

/** 最长公共子串长度占较短串的比例（0–1） */
function longestCommonSubstringRatio(a: string, b: string): number {
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length === 0) return 0
  let best = 0
  // 动态规划求最长公共子串
  let prev = new Array<number>(longer.length + 1).fill(0)
  for (let i = 1; i <= shorter.length; i++) {
    const cur = new Array<number>(longer.length + 1).fill(0)
    for (let j = 1; j <= longer.length; j++) {
      if (shorter[i - 1] === longer[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best / shorter.length
}

/** 曲名匹配结果 */
export interface TitleMatch {
  /** 匹配到的定数表曲名（未匹配到时为 null） */
  title: string | null
  /** 相似度 0–1 */
  score: number
  /** 匹配到的条目所属游戏 */
  game?: string
}

/**
 * 候选收窄：用卡面上的**定数**筛出"可能是这首"的子集。
 *
 * 为什么有效：Arcaea 定数表的 545 首里，每个具体定数值（如 10.7）
 * 只对应很少一部分曲目。而卡面定数的 OCR 准确率很高（实测 50 张卡 49 张正确），
 * 所以拿它做前置筛选能显著提高曲名模糊匹配的命中率。
 *
 * 实测例子（`arcaea分表01.jpg`）：`1VURBD` 本该是 `MVURBD`，
 * 在全部 545 首里相似度不够；但卡面定数是 10.6，
 * 只有少数曲目在某个难度上有 10.6，在这个子集里就容易胜出。
 *
 * ⚠ 返回空数组表示"没有可用约束"，调用方必须回退到全表匹配——
 * 否则一旦定数读错，真曲目会被排除在外，匹配直接失败。
 */
export function buildTitleShortlist(
  table: TierTable,
  constant: number | null,
  gameId?: string,
  tolerance = 0.051
): TierEntry[] {
  if (constant === null || !Number.isFinite(constant)) return []
  const out: TierEntry[] = []
  for (const entry of table.entries) {
    if (gameId && entry.game && entry.game !== gameId) continue
    const tiers = entry.tiers as Record<string, number> | undefined
    if (!tiers) continue
    for (const value of Object.values(tiers)) {
      if (typeof value === 'number' && Math.abs(value - constant) <= tolerance) {
        out.push(entry)
        break
      }
    }
  }
  return out
}

/** 解析阶段保留的定数候选；旧结果没有该字段时回退到单值。 */
function constantValues(candidate: EntryCandidate): number[] {
  const values = [
    ...(candidate.constantCandidates ?? []).map((item) => item.value),
    ...(candidate.constant === null ? [] : [candidate.constant])
  ]
  return [...new Set(values.filter((value) => Number.isFinite(value)))]
}

/** 几何定数带比整卡文本 OCR 更可靠；存在唯一几何读数时忽略粘连出来的次级数值。 */
function preferredConstantValues(candidate: EntryCandidate): number[] {
  const geometry = [...new Set(
    (candidate.constantCandidates ?? [])
      .filter((item) => item.source.startsWith('geometry:'))
      .map((item) => item.value)
      .filter((value) => Number.isFinite(value))
  )]
  return geometry.length === 1 ? geometry : constantValues(candidate)
}

function shortlistForConstants(table: TierTable, candidate: EntryCandidate, gameId: string): TierEntry[] {
  const merged = new Map<string, TierEntry>()
  for (const value of preferredConstantValues(candidate)) {
    for (const entry of buildTitleShortlist(table, value, gameId)) merged.set(entry.title, entry)
  }
  return [...merged.values()]
}

/**
 * 在定数表里找最接近的曲名。
 *
 * `minScore` 默认 0.7：低于这个值就不认，避免把错得离谱的识别结果硬套到某首曲目上
 * （那比"没匹配到"更危险——会静默写入错误数据）。
 *
 * `pool` 是可选的**候选子集**（见 `buildTitleShortlist`）。给了子集就在子集里选，
 * 这样同样的 OCR 噪声更容易被正确曲目压过其他曲目。
 *
 * `opts.containmentRatio` 可放宽包含关系的长度比例门槛（默认 0.7）。
 *
 * ## 为什么需要放宽（实测）
 *
 * 版式 B 的卡面图会**遮挡曲名左侧**，导致 `Ai Drew` 被读成 `Drew`。
 * `Drew`(4) / `AiDrew`(6) = **66.7%**，刚好低于 0.7 门槛 → 匹配失败。
 * 而 0.7 这个门槛本身是为了挡 `ARCA`↔`Arcahv`（也是 66.7%）那种假阳性，
 * 不能全局下调。
 *
 * 安全的放宽方式：**只在候选已被定数收窄到少数几首时**才降门槛。
 * 例如 `Drew` 配上已知定数 11.9 后，候选只剩 `Ai Drew`（相似的其他曲目定数不符），
 * 此时 66.7% 的包含关系是可信的——因为"错的那几首"已经被定数排除了。
 * 调用方（`validateCandidate`）在 `shortlist` 足够小时传 `containmentRatio: 0.6`。
 */
export function matchTitle(
  table: TierTable,
  raw: string,
  gameId?: string,
  minScore = 0.7,
  pool?: TierEntry[],
  opts?: { containmentRatio?: number }
): TitleMatch {
  const best: TitleMatch = { title: null, score: 0 }
  let runnerUp = 0
  if (!raw || !normalizeTitle(raw)) return best
  // 子集为空时退回全表：没有约束不等于"没有候选"
  const candidates = pool && pool.length > 0 ? pool : table.entries
  for (const entry of candidates) {
    // 标了游戏且与当前游戏不符的条目跳过
    if (gameId && entry.game && entry.game !== gameId) continue
    /*
     * 别名可以有多个（定数表 JSON 里可以是数组，中文译名等都能放进去）。
     * 别名越多，OCR 噪声再大也越可能命中——这是提高匹配率最直接的手段之一。
     */
    let s = similarity(raw, entry.title, opts)
    // 旧用户表也能使用新增官方别名，无须覆盖用户的定数文件。
    const builtIn = (entry.game ?? gameId) === 'arcaea' ? builtInArcaeaAliases(entry.title) : []
    for (const a of [...(entry.aliases ?? []), ...builtIn]) {
      const sa = similarity(raw, a, opts)
      if (sa > s) s = sa
    }
    if (s > best.score) {
      if (entry.title !== best.title) runnerUp = best.score
      best.score = s
      best.title = entry.title
      best.game = entry.game
    } else if (entry.title !== best.title) {
      runnerUp = Math.max(runnerUp, s)
    }
  }
  // 截断名或模糊名无法区分两个近似候选时交给人工，不按表中顺序猜。
  const ambiguous = runnerUp >= minScore && best.score - runnerUp < 0.03
  return best.score >= minScore && !ambiguous ? best : { title: null, score: best.score }
}

/**
 * 用**卡面 PTT 反推候选定数**，据此收窄曲名候选。
 *
 * ## 为什么需要（实测）
 *
 * 版式 B（`arcaea分表04-不同样式.png`）有两个特点叠加：
 *   1. 卡面**不显示定数**（所以 `buildTitleShortlist` 用不了）；
 *   2. 卡面图会**遮挡曲名左侧**，`Ai Drew` 被读成 `Drew`。
 *
 * `Drew`(4) / `AiDrew`(6) = 66.7%，低于包含关系的 0.7 门槛 → 匹配失败。
 * 但卡面**有 PTT**（`11.62`）和分数（`9963448`），由公式
 * `PTT = 定数 + 1 + (分数−9,800,000)/200,000 + bonus` 可反推出定数 ≈ 11.4，
 * 于是候选只剩定数在 11.4 附近的曲目——`Ai Drew` 就在其中，错的那几首被排除。
 *
 * ## 为什么只作为"收窄"而不直接写值
 *
 * PTT 只显示 2 位小数，反推出的定数有 ±0.01 级误差，**不足以直接当答案**。
 * 它的价值在于**缩小候选集**，最终仍由曲名相似度决定选哪一首。
 *
 * @param statusBonus 通关奖励（PM/FR/TC → 0.2，其余 0）。不传则两种都试，
 *   取候选并集——因为卡面状态字母可能没读到。
 */
export function buildTitleShortlistFromPotential(
  table: TierTable,
  score: number | null,
  potential: number | null,
  gameId?: string,
  tolerance = 0.02
): TierEntry[] {
  if (score === null || potential === null) return []
  const out: TierEntry[] = []
  /**
   * 由公式反解定数：`constant = PTT − 1 − (score−9.8e6)/200000 − bonus`
   * （分数 ≥ 9,800,000 的常见档；低于该档时用另一段公式）。
   */
  const invert = (bonus: number): number => {
    if (score >= 10_000_000) return potential - 2 - bonus
    if (score >= 9_800_000) return potential - 1 - (score - 9_800_000) / 200_000 - bonus
    return potential - (score - 9_500_000) / 300_000 - bonus
  }
  // 通关奖励不确定（可能读到也可能没读到），两种都收，宁可宽一点
  const guesses = [invert(0), invert(0.2)]
  for (const entry of table.entries) {
    if (gameId && entry.game && entry.game !== gameId) continue
    const hit = Object.values(entry.tiers).some((v) =>
      guesses.some((g) => Math.abs(v - g) <= tolerance)
    )
    if (hit) out.push(entry)
  }
  return out
}

/** 单个字段的校验结论 */
export interface FieldCheck {
  /** OCR 原始值 */
  ocr: number | null
  /** 经定数表校正后的值（未校正时等于 ocr） */
  value: number | null
  /** 定数表里的期望值 */
  expected: number | null
  status: 'ok' | 'corrected' | 'missing' | 'unknown' | 'mismatch'
  note: string
}

/**
 * 用**卡面分数 + 综合值（PTT）反推难度**。
 *
 * 原理：把卡面分数代进每个难度的定数，算出"无奖励时的 PTT"。
 * 与卡面 PTT 相差 0（无奖励）或正好 0.2（PM/FR/TC 奖励）的那个难度就是真实难度。
 *
 * ⚠ 这个反推此前被写在"有 OCR 定数"的分支里，于是**没有定数但有 PTT** 的卡片
 * 完全用不上它——实测 #11（Judgement）明明有 PTT 12.4098 与分数，
 * 却被判"这张图没有定数与综合值可用于反推难度"（自相矛盾的提示）。
 * 抽成独立函数后，只要有 `score + potential` 就能反推，与定数是否读到无关。
 *
 * 多解时取**定数最高**的难度：玩家在打分表时通常打的是该曲的最高难度，
 * 且定数值更高的候选更"吃"分数，更容易吻合。
 */
  /**
   * 用 **分数 + PTT** 反推难度。
   *
   * 原理：把卡面分数代进每个难度的定数，算出"无奖励时的 PTT"。
   * 与卡面 PTT 相差 0（无奖励）或正好 0.2（PM/FR/TC 奖励）的那个难度就是真实难度。
   *
   * ⚠ 这个反推此前被写在"有 OCR 定数"的分支里，于是**没有定数但有 PTT** 的卡片
   * 完全用不上它——实测 #11（Judgement）明明有 PTT 12.4098 与分数，
   * 却被判"这张图没有定数与综合值可用于反推难度"（自相矛盾的提示）。
   * 抽成独立函数后，只要有 `score + potential` 就能反推，与定数是否读到无关。
   *
   * 多解时取**定数最高**的难度：玩家在打分表时通常打的是该曲的最高难度，
   * 且定数值更高的候选更"吃"分数，更容易吻合。
   *
   * ## 多候选分数：用自洽性裁决，而不是取第一个
   *
   * 分隔符丢失时分数会有多种读法（见 `extractScore` 的 `ambiguous`）。
   * 实测 `#1 Ringed Genesis` 的块 `@9:9181094`：
   *   - `9918094` + FTR 10.8 → base 12.3905，与卡面 PTT 12.39 差 **0.0005** ✅
   *   - `9181094` + FTR 10.8 → base  9.7370，差 **2.6530** ❌
   *
   * 所以必须把候选一起试，并**返回选中的分数**，让调用方用它覆盖原值——
   * 否则分数会停留在错误的第一个读法上（实测就是这样）。
   */
  export interface ScoreResolution {
    code: string
    value: number
    /** 实际参与反推并自洽的那个分数（可能与传入的 `score` 不同） */
    score: number
  }

  export function inferDifficultyFromPotential(
  tiers: Record<string, number>,
  score: number | null,
  potential: number | null,
  /**
   * 分数的**其他可能读法**（分隔符丢失时的多义候选）。
   *
   * 实测 `#1 Ringed Genesis` 的块是 `@9:9181094`——少了第二个分隔符
   * （正常应像 `@9:918:094`），归一化后是 `99181094`，
   * 裁首位得 `9181094`、裁末位得 `9918094`，**两者都在合法区间内**。
   *
   * 光看数字无法区分，但用 PTT 可以：
   *   - `9918094` + FTR 10.8 → base 12.3905，与卡面 PTT 12.39 差 **0.0005** ✅
   *   - `9181094` + FTR 10.8 → base  9.7370，差 **2.6530** ❌
   *
   * 所以这里**对所有候选一起求解**，取能自洽的那个。
   */
  scoreAlternatives?: number[]
): ScoreResolution | null {
  if (potential === null) return null
  const scores = [score, ...(scoreAlternatives ?? [])].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v)
  )
  if (scores.length === 0) return null
  /*
   * 按候选分数 × 难度求解。**候选分数就是多义的，所以必须一起试**——
   * 只试第一个会拿到错误的那一半（见上面 Ringed Genesis 的实测）。
   */
  for (const sc of scores) {
    const hits: Array<{ code: string; value: number }> = []
    for (const [code, dict] of Object.entries(tiers)) {
      const base = arcaeaSinglePotential({ score: sc, constant: dict, clearStatus: 'TL' }).value
      const delta = potential - base
      // 允许 0（无奖励）与 0.2（PM/FR/TC）
      if (Math.abs(delta) <= 0.011 || Math.abs(delta - 0.2) <= 0.011) hits.push({ code, value: dict })
    }
    if (hits.length > 0) {
      hits.sort((a, b) => b.value - a.value)
      return { code: hits[0].code, value: hits[0].value, score: sc }
    }
  }
  return null
}

/**
 * 用**定数**反推难度：哪个难度的定数等于卡面定数。
 *
 * 与上一条互补——有的卡面能读出定数但 PTT 读错/缺失，有的反过来。
 * 两条都用不上时才放弃。
 */
export function inferDifficultyFromConstant(
  tiers: Record<string, number>,
  constant: number | null
): { code: string; value: number } | null {
  if (constant === null) return null
  const hits = Object.entries(tiers).filter(([, v]) => Math.abs(v - constant) <= CONST_TOLERANCE)
  if (hits.length === 0) return null
  /*
   * 多个难度定数相同时（实测存在）取**规范顺序里更难的**那个。
   * 不要按定数值排序——那样等于没排序，会退回 Object.entries 的原始顺序
   * （即 PST，最简单的那个）。
   */
  hits.sort((a, b) => DIFFICULTY_RANK.indexOf(b[0]) - DIFFICULTY_RANK.indexOf(a[0]))
  return { code: hits[0][0], value: hits[0][1] }
}

/** Arcaea 难度代号，按难度从低到高（用于"同定数时取更难的那个"） */
const DIFFICULTY_RANK = ['PST', 'PRS', 'FTR', 'ETR', 'BYD']

/** 一条记录的完整校验结果 */
export interface ValidateResult {
  candidate: EntryCandidate
  /** 匹配到的定数表曲名（null = 没匹配上，需要人工确认曲名） */
  matchedTitle: string | null
  titleScore: number
  /** 从该卡 OCR 曲名候选映射出的可选定数表曲名，当前匹配项排在首位。 */
  titleOptions: Array<{ title: string; constantCompatible: boolean | null }>
  /** 难度（若候选里没有明确的难度，则由定数表反推） */
  difficulty: string | null
  /** 最终采用的通关状态（可能由 PTT 反推得到） */
  clearStatus: string | null
  constant: FieldCheck
  potential: FieldCheck
  /** 整条记录是否需要人工复核 */
  review: boolean
  /** 需要人工注意的问题（会导致 review = true） */
  reasons: string[]
  /**
   * 信息性说明：记录做过哪些"可信的自动补全"（例如难度由 PTT 反推、
   * 曲名由模糊匹配校正）。**不会**触发 review。
   *
   * 为什么要把两者分开：早期把"由 PTT 反推为 ETR 10.7"这类结论也塞进 reasons，
   * 结果 50 张卡里 45 张被判"需复核"，复核队列失去意义——
   * 真正需要人看的只有"曲名没匹配上""定数读错且无法推断"这类问题。
   */
  notes: string[]
}

/** 定数比较容差：一位小数，允许 ±0.05 的浮点误差 */
const CONST_TOLERANCE = 0.051

function buildTitleOptions(
  table: TierTable,
  candidate: EntryCandidate,
  gameId: string,
  selectedTitle: string | null
): Array<{ title: string; constantCompatible: boolean | null }> {
  const ocrTitles = [...(candidate.titleCandidates ?? [])]
  if (candidate.title && !ocrTitles.some((item) => item.text === candidate.title)) {
    ocrTitles.unshift({ text: candidate.title, score: 1 })
  }
  if (ocrTitles.length === 0 && candidate.title) ocrTitles.push({ text: candidate.title, score: 1 })

  const constants = preferredConstantValues(candidate)
  const ranked = new Map<string, { score: number; constantCompatible: boolean | null }>()
  const constantMatch = (entry: TierEntry): boolean | null => {
    if (constants.length === 0) return null
    return Object.values(entry.tiers as Record<string, number>).some((value) =>
      constants.some((constant) => Math.abs(value - constant) <= CONST_TOLERANCE)
    )
  }
  for (const ocr of ocrTitles) {
    if (!ocr.text || ocr.score < 0.5) continue
    for (const entry of table.entries) {
      if (gameId && entry.game && entry.game !== gameId) continue
      let titleScore = similarity(ocr.text, entry.title)
      const builtIn = (entry.game ?? gameId) === 'arcaea' ? builtInArcaeaAliases(entry.title) : []
      for (const alias of [...(entry.aliases ?? []), ...builtIn]) {
        titleScore = Math.max(titleScore, similarity(ocr.text, alias))
      }
      if (titleScore < 0.6) continue

      const score = titleScore * 0.75 + Math.min(1, ocr.score) * 0.25
      const previous = ranked.get(entry.title)
      if (!previous || score > previous.score) {
        ranked.set(entry.title, { score, constantCompatible: constantMatch(entry) })
      }
    }
  }

  const alternatives = [...ranked.entries()]
    .filter(([title]) => title !== selectedTitle)
    .sort((a, b) => {
      const aMatch = a[1].constantCompatible === true ? 1 : 0
      const bMatch = b[1].constantCompatible === true ? 1 : 0
      return bMatch - aMatch || b[1].score - a[1].score
    })
    .slice(0, 5)
    .map(([title, option]) => ({ title, constantCompatible: option.constantCompatible }))

  const selectedEntry = selectedTitle
    ? table.entries.find((item) => item.title === selectedTitle && (!gameId || !item.game || item.game === gameId))
    : undefined
  return [
    ...(selectedTitle
      ? [{ title: selectedTitle, constantCompatible: selectedEntry ? constantMatch(selectedEntry) : false }]
      : []),
    ...alternatives
  ]
}

/**
 * Arcaea 通关状态及其奖励（与公式实现保持一致）。
 * 用于"由 PTT 反推通关状态"。
 */
const ARCAEA_CLEAR_STATUSES: ReadonlyArray<{ code: ClearStatus; bonus: number }> = [
  { code: 'PM', bonus: 0.2 },
  { code: 'FR', bonus: 0.2 },
  { code: 'TC', bonus: 0.2 },
  /*
   * ⚠ `NC` / `HC` 与 `TC` **同档**（同一档的不同世代写法），
   * 都必须给 +0.2 奖励，否则卡面写着 `NC` 的格子会被算成无奖励，
   * PTT 反而差 0.2。用户标注素材里大量卡片是 `NC`。
   */
  { code: 'NC', bonus: 0.2 },
  { code: 'HC', bonus: 0.2 },
  { code: 'TL', bonus: 0 }
]

/**
 * 由卡面 PTT 反推通关状态。
 *
 * 为什么需要：卡面同时有"通关状态"（PM/FR/TC/TL/NC）与"评级"（EX/AA/…），
 * OCR 很容易只读出其中一个，而**奖励值（+0.2 与否）直接决定 PTT**。
 *
 * 实测：`Inverted World` 9'958'701 / 定数 10.7，卡面 PTT 12.6935。
 * 若只按 NC（无奖励）算得 12.4935，**差正好 0.2**；按 FR 算得 12.6935 —— 一致。
 * 所以用"哪个状态能让公式结果对齐卡面 PTT"来反推，比正则猜更可靠。
 *
 * 返回所有能对齐的状态；多于一个时无法区分（例如 PTT 恰好相同）。
 */
export function inferClearStatus(
  score: number,
  constant: number,
  potential: number,
  tolerance = 0.0005
): ClearStatus[] {
  const hits: ClearStatus[] = []
  for (const { code } of ARCAEA_CLEAR_STATUSES) {
    const value = arcaeaSinglePotential({ score, constant, clearStatus: code }).value
    if (Math.abs(value - potential) <= tolerance) hits.push(code)
  }
  return hits
}

/**
 * 校验一条 OCR 候选。
 *
 * `knownDifficulty` 可以传入（例如从卡片上单独识别的难度代号）；
 * 没有时尝试用定数表反推：定数与哪个难度的值吻合就取哪个。
 */
export function validateCandidate(
  table: TierTable,
  candidate: EntryCandidate,
  gameId: string,
  knownDifficulty?: string,
  /**
   * @deprecated 自 2026-04 移除本地公式校验后**不再使用**。
   *
   * 它原本用于"PTT 与公式比对的容差"（按卡面显示精度取半格）。
   * 公式校验已整体移除，所以这个参数没有作用了；保留形参只是为了
   * 不破坏既有调用方（`src/main/ocr.ts` 与多个测试都还在传）。
   */
  _minPotentialDecimals = 4
): ValidateResult {
  const reasons: string[] = []
  /** 可信的自动补全说明（不触发复核） */
  const notes: string[] = []


  /*
   * 1) 曲名匹配——**先用卡面定数收窄候选，并优先在子集里取胜**。
   *
   * 为什么：实测 `arcaea分表01.jpg` 有 14/50 张卡的曲名识别不出来
   * （相似度只有 33–68%）。但这些卡片上的**定数**读得很准（49/50），
   * 而某个具体定数值只对应定数表里很少一部分曲目，
   * 在这个子集里做模糊匹配，正确的曲目就容易胜出。
   *
   * ⚠ 阈值必须分开设（踩过的坑）：
   * 子集内用 **0.5**、全表用 0.7。
   *
   * 为什么子集内能低到 0.5：子集是按"定数完全相等"筛出来的，
   * 通常只剩十几首（实测定数 10.7 只有 14 首），多一层强约束，
   * 放宽纯文字相似度是安全的。而全表有 545 首，阈值必须严。
   *
   * 实测：`王恋ROMANCE` 与正确曲目 `KYOREN ROMANCE` 的相似度只有 **0.538**
   * （汉字"恋"对应的 KYOREN 完全没读出来，公共部分只剩 `ROMANCE`），
   * 全表里 `Romance Wars` 反而有 0.778 从而胜出——但它的定数最高只有 7.8，
   * 与卡面 10.7 矛盾。所以**必须让定数约束优先于单纯的字面相似度**。
   * 低于 0.7 的子集匹配会被标为"需核对"，避免宽松阈值带来静默错误。
   *
   * 更关键的是**优先取子集结果**，不能拿子集结果与全表结果比相似度：
   * 实测 `王恋ROMANCE` 在子集里正确匹配 `KYOREN ROMANCE`（FTR 10.7），
   * 但全表里 `Romance Wars`（FTR 只有 7.8）相似度更高（78%）从而胜出——
   * 它之所以能进子集，是因为它在 **Phigros** 表里恰好也有 10.7 的难度，
   * 而子集构建是按 `entry.game` 过滤的，Phigros 条目在跨游戏检索时不会排除。
   * 所以判据改为：**子集里有结果就用子集的结果**（定数是更强的证据）。
   *
   * 安全兜底：定数缺失时子集为空，直接走全表；
   * 子集内匹配失败也回退全表重试一次——
   * **不能因为定数读错就把真曲目排除掉**。
   */
  const trustedConstants = preferredConstantValues(candidate)
  const ocrConstant = trustedConstants.length === 1 ? trustedConstants[0] : candidate.constant
  let shortlist = shortlistForConstants(table, candidate, gameId)
  /*
   * 卡面**没有定数**时（实测版式 B 就是这样），改用**PTT 反推**来收窄候选。
   * 见 `buildTitleShortlistFromPotential` 的注释。
   */
  if (shortlist.length === 0 && candidate.potential !== null) {
    shortlist = buildTitleShortlistFromPotential(
      table,
      candidate.score,
      candidate.potential,
      gameId
    )
    if (shortlist.length > 0) {
      notes.push(
        `卡面无定数，按 PTT ${candidate.potential} 反推把曲名候选收窄到 ${shortlist.length} 首`
      )
    }
  }
  const useShortlist = shortlist.length > 0 && shortlist.length < table.entries.length
  /*
   * 候选已经很窄时（≤4 首）放宽"包含关系"的长度比例门槛。
   *
   * 实测需要：版式 B 的卡面图**遮挡曲名左侧**，`Ai Drew` 被读成 `Drew`——
   * `Drew`(4)/`AiDrew`(6) = 66.7%，刚好低于默认 0.7 门槛。
   * 门槛本身为挡 `ARCA`↔`Arcahv`（也是 66.7%）而设，不能全局下调；
   * 但候选只剩几首时，"错的那几首"已被定数排除，66.7% 的包含是可信的。
   */
  const relaxed = shortlist.length > 0 && shortlist.length <= 4
  const ratioOpt = relaxed ? { containmentRatio: 0.6 } : undefined
  let match = useShortlist
    ? matchTitle(table, candidate.title, gameId, 0.7, shortlist, ratioOpt)
    : matchTitle(table, candidate.title, gameId, 0.7, undefined, ratioOpt)
  let usedShortlist = useShortlist && match.title !== null
  let matchedCandidateTitle = candidate.title
  if (!match.title && useShortlist && candidate.titleCandidates?.length) {
    const titleCandidates = [...candidate.titleCandidates]
    if (!titleCandidates.some((item) => item.text === candidate.title)) {
      titleCandidates.unshift({ text: candidate.title, score: 1 })
    }
    for (const titleCandidate of titleCandidates) {
      if (!titleCandidate.text || titleCandidate.text === candidate.title) continue
      const alternate = matchTitle(
        table,
        titleCandidate.text,
        gameId,
        0.6,
        shortlist,
        ratioOpt
      )
      if (alternate.title) {
        match = alternate
        usedShortlist = true
        matchedCandidateTitle = titleCandidate.text
        notes.push(
          `结合定数候选与备用曲名「${titleCandidate.text}」匹配到「${alternate.title}」`
        )
        break
      }
    }
  }
  if (!match.title && useShortlist) {
    // 子集里没找到（或分数不够）→ 全表再试一次
    const full = matchTitle(table, candidate.title, gameId)
    if (full.title) {
      match = full
      usedShortlist = false
      notes.push('卡面定数与匹配到的曲目不一致，可能是定数读错，请核对')
    }
  }
  if (!match.title) {
    reasons.push(`曲名未匹配到定数表（最接近相似度 ${(match.score * 100).toFixed(0)}%）`)
  } else if (usedShortlist && match.score < 0.7) {
    /*
     * 子集内用了放宽阈值（0.5）才匹配上的，相似度偏低。
     * 定数约束虽然很强，但宽松阈值理论上仍可能选错，所以标为需复核。
     */
    reasons.push(
      /*
       * 收窄依据要分两种情形，否则文案会出现 `undefined`：
       *   - 卡面**读到**定数 → 用 `candidate.constant`
       *   - 卡面**没有**定数（版式 B）→ 收窄依据是 `buildTitleShortlistFromPotential`
       *     用 `分数 + PTT` 反推出的定数，而 `candidate.constant` 是 `null`。
       *
       * 实测 `#30 Ai Drew` 的提示曾显示"按定数 undefined 收窄到 99 首"——
       * 匹配结果是对的，只是文案 bug。
       */
      `曲名由「${matchedCandidateTitle}」按${
        ocrConstant !== null && ocrConstant !== undefined
          ? `卡面定数 ${ocrConstant.toFixed(1)}`
          : `PTT ${candidate.potential ?? '?'} 反推`
      }收窄到 ${shortlist.length} 首后匹配为「${match.title}」，但相似度仅 ${(match.score * 100).toFixed(0)}%，请核对`
    )
  } else if (match.score < 0.999) {
    const how = usedShortlist ? `（按卡面定数 ${candidate.constant?.toFixed(1)} 收窄到 ${shortlist.length} 首后匹配，相似度 ${(match.score * 100).toFixed(0)}%）` : `（相似度 ${(match.score * 100).toFixed(0)}%）`
    notes.push(`曲名由「${matchedCandidateTitle}」校正为「${match.title}」${how}`)
  }

  // 2) 取该曲目的定数表记录
  const entry = match.title ? table.entries.find((e) => e.title === match.title && (!gameId || !e.game || e.game === gameId)) : undefined
  const tiers = entry ? entry.tiers : {}

  /*
   * 定数优先：曲名确定后，用该曲目的定数表反查全部 OCR 候选。
   * 只有唯一一个定数值命中才接受；候选冲突或全部不命中都保留复核，
   * 不拿 PTT、分数或“最高难度”填补定数。
   */
  let resolvedConstant = ocrConstant
  let potentialResolution: { code: string; value: number } | null = null
  const tableConstantHits = preferredConstantValues(candidate).filter((value) =>
    Object.values(tiers).some((expected) => Math.abs(expected - value) <= CONST_TOLERANCE)
  )
  const uniqueHits = [...new Set(tableConstantHits)]
  if (Object.keys(tiers).length > 0 && uniqueHits.length === 1) {
    resolvedConstant = uniqueHits[0]
    candidate.constant = resolvedConstant
    if (ocrConstant !== resolvedConstant) notes.push(`定数候选 ${resolvedConstant.toFixed(1)} 与「${match.title}」定数表一致`)
  } else if (Object.keys(tiers).length > 0 && uniqueHits.length > 1) {
    resolvedConstant = null
    candidate.constant = null
    reasons.push('识别到多个互相冲突的定数候选，请复核')
  } else if (Object.keys(tiers).length > 0 && constantValues(candidate).length > 0) {
    // 解析器明确收集到候选、但候选不在该曲目定数表内时，视为误读并留空。
    // 没有候选数组的旧调用仍保留原始值，兼容手工/历史结果。
    if (candidate.constantCandidates?.length) {
      resolvedConstant = null
      candidate.constant = null
      reasons.push('定数候选与匹配曲目的定数表不一致，请复核')
    } else {
      resolvedConstant = ocrConstant
    }
  }

  /*
   * 定数 OCR 缺失或明显误读时，用“已匹配曲目 + 分数 + PTT”在该曲目的定数表内
   * 做第二次查询。这里不是把 PTT 当定数，也不是猜最高难度：只有公式唯一命中某个
   * 表内谱面才接受；否则继续留空进入复核。
   */
  if (Object.keys(tiers).length > 0 && resolvedConstant === null && candidate.constantCandidates?.length) {
    const inferred = inferDifficultyFromPotential(tiers, candidate.score, candidate.potential)
    if (inferred) {
      potentialResolution = inferred
      resolvedConstant = inferred.value
      notes.push(`定数 OCR 缺失，按曲目定数表与分数/PTT 查询到 ${inferred.code} ${inferred.value.toFixed(1)}`)
    }
  }

  // 3) 定数校验
  const constant: FieldCheck = {
    ocr: ocrConstant,
    value: resolvedConstant,
    expected: null,
    status: 'unknown',
    note: ''
  }

  let difficulty = knownDifficulty ?? potentialResolution?.code ?? null
  /** 最终采用的通关状态（可能由 PTT 反推修正），供调用方写入条目 */
  let usedStatusOut: string | null = candidate.grade ?? null

  if (Object.keys(tiers).length > 0) {
    if (difficulty && tiers[difficulty] !== undefined) {
      constant.expected = tiers[difficulty]
      if (constant.ocr === null && potentialResolution) {
        constant.status = 'corrected'
        constant.note = `定数由分数/PTT查询校正为 ${tiers[difficulty].toFixed(1)}`
      } else if (constant.ocr === null) {
        constant.status = 'missing'
        constant.note = 'OCR 未识别到定数，保留为空并需要复核'
        reasons.push(constant.note)
      } else if (Math.abs(constant.ocr - tiers[difficulty]) <= CONST_TOLERANCE) {
        constant.status = 'ok'
        constant.note = '与定数表一致'
      } else {
        constant.status = 'corrected'
        constant.note = `定数由 ${constant.ocr.toFixed(1)} 校正为 ${tiers[difficulty].toFixed(1)}（定数表）`
        if (!potentialResolution) reasons.push(constant.note)
      }
    } else if (resolvedConstant !== null) {
      /*
       * 没给难度，但**卡面读到了定数** → 直接用定数在表里定位难度。
       *
       * 这是**纯查表**，不含任何公式推算。
       *
       * ⚠ 2026-04 按用户决定，已**移除全部本地公式校验**：
       * 原先这里用"分数 + PTT 反推难度"（`inferDifficultyFromPotential`）
       * 与"用定数一致性校验"，但它们反复产生假阳性
       * （实测把读错的分数判成"可直接入库"）。
       * 现在只做：读卡面数值 + 查定数表 + 低置信标复核。
       */
      const inferred = inferDifficultyFromConstant(tiers, resolvedConstant)
      const hit = inferred ? ([inferred.code, inferred.value] as const) : undefined
      if (hit) {
        difficulty = hit[0]
        constant.expected = hit[1]
        constant.value = hit[1]
        constant.status = 'ok'
        constant.note = `定数 ${resolvedConstant.toFixed(1)} 对应到 ${hit[0]}`
        notes.push(constant.note)
      } else {
        constant.status = 'mismatch'
        constant.note = `定数 ${resolvedConstant.toFixed(1)} 与定数表各难度都不符，无法确定难度，请复核`
        reasons.push(constant.note)
      }
    } else {
      constant.status = 'missing'
      constant.note = '卡面没有识别到定数，无法判定难度，保留为空并需要复核'
      reasons.push(constant.note)
    }
  } else if (constant.ocr !== null) {
    constant.status = 'unknown'
    constant.note = '定数表里没有这首曲目，无法校验'
    reasons.push(constant.note)
  } else {
    constant.status = 'missing'
    constant.note = '定数缺失'
    reasons.push(constant.note)
  }

  /*
   * 4) PTT：**只记录卡面读到的值，不做任何公式校验**。
   *
   * ⚠ 2026-04 按用户决定移除了全部本地公式校验。
   * 这里原本会：
   *   - 用 arcaeaSinglePotential 按定数反算 PTT 并与卡面对比；
   *   - 用 PTT 反推通关状态（inferClearStatus）；
   *   - 不一致时标 mismatch 并要求复核。
   *
   * 移除原因：这些推算反复产生**假阳性**——实测把读错的分数判成
   * "可直接入库"（分数 9918109 配 FTR 10.8 恰好自洽，但该格真实分数
   * 是 09'918'094）。既然分数本身可能读错，基于它的推算就不可信。
   *
   * 现在的原则：**只读取分表上的数值 + 查定数表 + 低置信标复核**。
   * 卡面没印定数（如 Arcaea 版式 B）时难度判不出来 → 标复核由人确认。
   */
  const potential: FieldCheck = {
    ocr: candidate.potential,
    value: candidate.potential,
    expected: null,
    status: candidate.potential !== null ? 'ok' : 'missing',
    note: candidate.potential !== null ? '按卡面读到的值记录（不做公式校验）' : '未识别到 PTT'
  }


  // 5) 汇总是否需要复核
  /*
   * ⚠ 2026-04 新增最后一条：**曲名相似度不足必须标复核**。
   *
   * 用户实测发现"没有标需要复核的很多出现了识别错误"——
   * 根因是这里的判据**只看 `reasons`，不看曲名相似度**。
   * 于是 `heriruth` → `Sheriruth`（相似度 0.889）、
   * `ZANA` → `IZANA`（0.800）这类"猜出来"的匹配
   * 会被当作**完全确定**直接标"可入库"，静默写错曲名。
   *
   * 现在：只有相似度接近 1（`>= 0.999`，即归一化后完全一致）
   * 才不需要复核；其余一律进复核队列由人确认。
   * 这与"宁可标复核也不静默写错"的原则一致。
   */
  const TITLE_CERTAIN = 0.999
  const review =
    reasons.length > 0 ||
    match.title === null ||
    match.score < TITLE_CERTAIN ||
    constant.status === 'missing' ||
    constant.status === 'unknown' ||
    potential.status === 'mismatch'

  return {
    candidate,
    matchedTitle: match.title,
    titleScore: match.score,
    titleOptions: buildTitleOptions(table, candidate, gameId, match.title),
    difficulty,
    clearStatus: usedStatusOut,
    constant,
    potential,
    review,
    reasons,
    notes
  }
}
