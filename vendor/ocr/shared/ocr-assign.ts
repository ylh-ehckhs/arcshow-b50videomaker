import { similarity } from './ocr-validate'
import type { TierEntry, TierTable } from './tiers'

/**
 * 跨格**联合**曲名分配（全局最优）。
 *
 * ## 为什么需要（实测结论）
 *
 * Phigros 的曲名匹配瓶颈**不是裁剪几何**——实测对比：
 *
 * | 配置 | 曲名 | 定数 |
 * |---|---|---|
 * | 宽框（跨卡，单格能看到多个候选）| **32/36** | **33/36** |
 * | 精确窄框（几何正确，单格只剩一个候选）| 27/36 | 29/36 |
 *
 * 宽框更好，是因为它让**打分器在同一格里看到多个候选**，从而有机会选对。
 * 但逐格独立决策仍有一个根本缺陷：**无法利用全局约束**——
 * 最明显的就是"同一首曲目不该同时出现在两格"。
 * 实测 Phigros 有 `#35`/`#36` 都读成 `Cthugga`／`Cthugha`（同一首），
 * 逐格决策会**两格都判成同一首**，而全局分配会把它分开。
 *
 * ## 做法：带权二部图最优匹配（Kuhn–Munkres）
 *
 * 左边 = 各格，右边 = 定数表候选曲目，边权 = 该格读到该曲名的**可信度**：
 *
 * ```
 * 权重 = 曲名相似度
 *      + 卡面定数与候选定数一致？ +0.5 : 0
 *      + 该候选只在这一格的候选池里出现？ +0.3 : 0   ← 利用"曲目不重复"
 * ```
 *
 * 用匈牙利算法求**总权重最大**的分配。这样某一格的错误候选会被
 * "另一格更像它"这一点压下去，而不是各自为政。
 *
 * ## 保守性
 *
 * 只对**候选池非空**的格做分配；没有任何候选的格保持原样。
 * 分配结果若比逐格独立选择更差（总权重更低）则退回逐格结果——
 * 保证"联合分配不会让结果变坏"（有单测守着）。
 */
export interface AssignInput {
  /** 格的标识（调用方给的稳定 id） */
  id: number
  /** 该格的全部曲名候选（按分数降序） */
  candidates: Array<{ text: string; score: number }>
  /** 卡面定数（可选；Phigros 的卡面有，Arcaea 版式 B 没有） */
  constant?: number | null
  /**
   * 该格的分数（可选）。
   *
   * 用于**抑制重复分配**：**分数不同的两格不可能是同一首歌**
   * （同一首歌在同一张分表里只会出现一次，分数必然相同）。
   *
   * 实测动机：Phigros 补全定数表后，宽框配置出现 7 组同名重复
   * （`#2`/`#3` 都成 `cryout`、`#5`/`#6` 都成 `Stasis`…，涉及 14/36 格），
   * 而那些格**分数都不同**——正是这条约束能排除的。
   */
  score?: number | null
  /**
   * 该格**卡面读到的**定数（可选，用于消重的第二判据）。
   *
   * ⚠ 与 `constant` 的区别：`constant` 是用于**排序/加成**的卡面定数；
   * 这个是**消重专用**，调用方应当只在"卡面确实读到了定数"时才传。
   * Phigros 的卡面**不显示定数**，所以那里不传。
   *
   * 用途：分数相同的两格若卡面定数不同，同样说明是两首歌
   * （实测 `#1`/`#10` 都读成 `GOODTEK`、分数都是 1000000，
   * 但 `GOODTEK` 的 IN 是 14.3、`Stasis` 的 AT 是 16.7，定数能区分它们）。
   */
  cardConstant?: number | null
  /**
   * **禁选曲名**：这批格不允许被分配到这些曲名上。
   *
   * 用途：只对"重复的几格"做重解时，要避免把其中某格推给
   * **别人（这一组之外的格）已经占着**的曲名——那只是把重复挪了个地方。
   *
   * 调用方负责算出这个集合（见 `src/main/ocr.ts` 的"拆重复"一段）。
   */
  bannedTitles?: string[]
}

export interface AssignResult {
  /** id → 分配到的曲名（未分配则 null） */
  byId: Map<number, string | null>
  /** 该次分配的总权重，供调用方比较是否比逐格更好 */
  totalWeight: number
}

/**
 * 判断一组同名卡是否有可靠证据表明它们是不同谱面。
 *
 * Arcaea 的同一曲名允许 FTR/BYD 同时出现在 B50。重复拆分只能针对
 * 同一谱面重复，否则会把合法的不同难度改配成别的曲目。
 */
export function hasDistinctChartVariants(
  cards: Array<{
    difficulty?: string | null
    constant?: number | null
    /** Arcaea 官方版式 B 右上角等级（如 `10+` / `11`）。 */
    chartLevel?: string | null
  }>,
  entry: TierEntry,
  tolerance = 0.051
): boolean {
  const variants = new Set<string>()
  const chartLevels = new Set<string>()
  for (const card of cards) {
    if (card.chartLevel) chartLevels.add(card.chartLevel.trim().toUpperCase())
    if (card.difficulty && entry.tiers[card.difficulty] !== undefined) {
      variants.add(card.difficulty)
      continue
    }
    if (card.constant === null || card.constant === undefined) continue
    const hits = Object.entries(entry.tiers).filter(([, value]) => Math.abs(value - card.constant!) <= tolerance)
    // 一个定数可能对应多个难度；只有唯一命中时才可作为谱面证据。
    if (hits.length === 1) variants.add(hits[0][0])
  }
  /*
   * 版式 B 不印 FTR/BYD 代号和定数，但右上角等级仍能区分两张同名卡。
   * 只要等级 OCR 读成了两个不同值，就足以阻止重复拆分；宁可保留一组
   * 待复核的重复，也不能把合法的 FTR/BYD 改成另一首相似曲名。
   */
  return variants.size >= 2 || chartLevels.size >= 2
}

/** 单条边的权重 */
function edgeWeight(
  candidateText: string,
  entry: TierEntry,
  constant: number | null | undefined,
  appearCount: number
): number {
  let w = similarity(candidateText, entry.title)
  // 别名也算命中
  for (const a of entry.aliases ?? []) {
    const s = similarity(candidateText, a)
    if (s > w) w = s
  }
  /*
   * 定数一致加成：卡面定数与候选曲目的任一难度定数相符时加 0.5。
   * 这是很强的信号（同一首曲目在不同难度下定数不同），
   * 但不足以单独决定——所以是"加成"而不是"过滤器"。
   */
  if (constant !== null && constant !== undefined) {
    const hit = Object.values(entry.tiers).some((v) => Math.abs(v - constant) <= 0.051)
    if (hit) w += 0.5
  }
  /*
   * 唯一性加成：该候选只出现在**这一格**的候选池里时加 0.3。
   * 这利用"一首曲目只应出现一次"的全局约束——
   * 若两格都读到同一个曲名，它就不该同时拿到这份加成。
   */
  // 低相似度文本不能靠“只出现一格”被硬抬过匹配阈值。
  // 否则诸如 `Smguanyvw` 这样的噪声会被唯一性奖励误配成某首曲目。
  if (appearCount === 1 && w >= 0.5) w += 0.3
  return w
}

/**
 * Kuhn–Munkres（匈牙利）算法的 O(n³) 实现，求**最大权**完全匹配。
 *
 * 输入是 `n × m` 权重矩阵（n = 格数，m = 候选曲目数）。
 * 若 m < n 会补零列；返回每行匹配到的列索引（-1 表示未匹配）。
 *
 * 这里用经典的"势函数 + 增广路"写法，对矩形矩阵同样有效。
 */
export function hungarianMax(weights: number[][]): number[] {
  const n = weights.length
  if (n === 0) return []
  /**
   * **真实列数**。矩阵会被补成方阵（列数 < 行数时补零列），
   * 补出来的列是"虚拟列"，匹配到它的行应当视为**未匹配**。
   *
   * 实测这个细节必须处理：不记录真实列数时，
   * 3 行 2 列会返回 3 个匹配（第三行"匹配"到了虚拟列），
   * 于是调用方会以为每格都找到了曲目。
   */
  const realCols = weights[0]?.length ?? 0
  const m = Math.max(realCols, n)
  // 转成"最小化"：取负；补零列使矩阵为方阵
  const a: number[][] = []
  for (let i = 0; i < n; i++) {
    const row: number[] = []
    for (let j = 0; j < m; j++) row.push(-(weights[i]?.[j] ?? 0))
    a.push(row)
  }
  const INF = Number.POSITIVE_INFINITY
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(m + 1).fill(0)
  const p = new Array<number>(m + 1).fill(0) // p[j] = 匹配到列 j 的行
  const way = new Array<number>(m + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(m + 1).fill(INF)
    const used = new Array<boolean>(m + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }

  const result = new Array<number>(n).fill(-1)
  for (let j = 1; j <= m; j++) {
    if (p[j] > 0) {
      const col = j - 1
      // 匹配到虚拟列（补出来的零权重列）视为未匹配
      result[p[j] - 1] = col < realCols ? col : -1
    }
  }
  return result
}

/**
 * 做一次跨格联合分配。
 *
 * @param cards 各格的候选池（见 `AssignInput`）
 * @param table 定数表（候选曲目来源）
 * @param gameId 限定游戏
 */
export function assignTitlesGlobally(
  cards: AssignInput[],
  table: TierTable,
  gameId?: string,
  /**
   * 候选曲目上限。定数表可能有 500+ 首，直接建 36×812 的矩阵虽然可行
   * （匈牙利是 O(n³)，n=812 约 5 亿次，太慢），
   * 所以先按"最高相似度"预筛，只保留每格最可能的若干首。
   */
  maxEntries = 60
): AssignResult {
  const byId = new Map<number, string | null>()
  if (cards.length === 0) return { byId, totalWeight: 0 }

  const pool = table.entries.filter((e) => !gameId || !e.game || e.game === gameId)

  // 每个 (格, 候选曲目) 的"预筛权重"，用于挑出真正有机会胜出的候选曲目
  const perCardBest = cards.map((c) => {
    const best = new Map<string, number>()
    for (const e of pool) {
      let w = 0
      for (const cand of c.candidates) {
        const v = similarity(cand.text, e.title)
        if (v > w) w = v
        for (const al of e.aliases ?? []) {
          const va = similarity(cand.text, al)
          if (va > w) w = va
        }
      }
      /*
       * ⚠ 预筛必须用**与最终权重一致的口径**，不能只看纯相似度。
       *
       * 实测踩坑：只看相似度时，`Cthugha`（相似度 0.9）被排在前 60 之外——
       * 定数表里相似度更高的条目很多（本例有 300+ 首相似度 > 0.9），
       * 但它们的**定数不符**，最终权重反而低。
       * 于是最优解被预筛砍掉，分配出来的结果不如逐格决策。
       *
       * 这里把"定数一致 +0.5"也计入预筛（唯一性 +0.3 与具体配对有关，
       * 在预筛阶段无法确定，所以不计——它是相对均匀的小项）。
       */
      const cv = c.constant
      if (cv !== null && cv !== undefined) {
        const hit = Object.values(e.tiers).some((v) => Math.abs(v - cv) <= 0.051)
        if (hit) w += 0.5
      }
      best.set(e.title, w)
    }
    return best
  })

  /*
   * 预筛：把所有格子的候选曲目按"跨格最高相似度"排序，取前 `maxEntries` 首。
   * 这样既控制了矩阵规模，又不会漏掉任何一格里高度匹配的曲目。
   */
  const globalBest = new Map<string, number>()
  for (const best of perCardBest) {
    for (const [title, s] of best) {
      const cur = globalBest.get(title) ?? 0
      if (s > cur) globalBest.set(title, s)
    }
  }
  const entries = [...globalBest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(maxEntries, cards.length))
    .map(([title]) => pool.find((e) => e.title === title))
    .filter((e): e is TierEntry => Boolean(e))

  if (entries.length === 0) {
    for (const c of cards) byId.set(c.id, null)
    return { byId, totalWeight: 0 }
  }

  /*
   * 候选出现次数：用于"唯一性加成"。
   * 统计每个候选文本出现在多少格的候选池里。
   */
  const appear = new Map<string, number>()
  for (const c of cards) {
    for (const cand of c.candidates) {
      appear.set(cand.text, (appear.get(cand.text) ?? 0) + 1)
    }
  }

  // 建权重矩阵
  const weights: number[][] = []
  for (let i = 0; i < cards.length; i++) {
    /*
     * 禁选曲名：把对应列的权重压成 -Infinity，
     * 等于"这一格无论如何都不选它"。用 -Infinity 而不是 0，
     * 是为了让它即使其它列权重也很低时仍不选（0 可能被当成合法选择）。
     */
    const banned = new Set((cards[i].bannedTitles ?? []).map((t) => t))
    const row: number[] = []
    for (const e of entries) {
      if (banned.has(e.title)) {
        row.push(-Infinity)
        continue
      }
      let w = -Infinity
      for (const cand of cards[i].candidates) {
        const v = edgeWeight(cand.text, e, cards[i].constant, appear.get(cand.text) ?? 1)
        if (v > w) w = v
      }
      row.push(w === -Infinity ? 0 : w)
    }
    weights.push(row)
  }

  /**
   * 把权重矩阵按"禁用集合"求解一次，返回每行选中的列（低于阈值记 -1）。
   *
   * `banned` 是"该行禁用哪些列"，用于迭代消重（见下）。
   */
  const solve = (banned: Map<number, Set<number>>): { picks: number[]; total: number } => {
    const w = weights.map((row, i) => {
      const b = banned.get(i)
      if (!b || b.size === 0) return row
      return row.map((v, j) => (b.has(j) ? -Infinity : v))
    })
    const asg = hungarianMax(w)
    const picks: number[] = []
    let tot = 0
    for (let i = 0; i < cards.length; i++) {
      const j = asg[i]
      const v = j >= 0 ? w[i][j] : 0
      if (j >= 0 && v > 0.5) {
        picks.push(j)
        tot += v
      } else {
        picks.push(-1)
      }
    }
    return { picks, total: tot }
  }

  /*
   * ---------------- 迭代消重：分数不同的两格不可能是同一首歌 ----------------
   *
   * ## 为什么不能直接写进权重矩阵
   *
   * 匈牙利算法的边权是**行 × 列**的（"第 i 格取第 j 首"的收益），
   * 而"两格不能同曲"是**行与行之间**的约束，无法用单个元素表达。
   *
   * ## 做法：发现违规就禁用、重解
   *
   * 解完之后扫描：若两格分到同一首、**且它们的分数不同**（说明确实是两首不同的歌），
   * 就把"权重较低的那一格"禁用该首，重新求解。
   * 重复直到没有违规，或达到迭代上限。
   *
   * 分数相同的两格**不处理**——它们可能是真的同名（罕见），
   * 也可能是同一张卡被读了两次；这时没有可靠依据判断，宁可不猜。
   */
  const banned = new Map<number, Set<number>>()
  let best = solve(banned)
  const MAX_ROUNDS = 8
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 按曲名分组，找出违规
    const groups = new Map<number, number[]>()
    best.picks.forEach((j, i) => {
      if (j < 0) return
      if (!groups.has(j)) groups.set(j, [])
      groups.get(j)!.push(i)
    })
    let changed = false
    for (const [j, rows] of groups) {
      if (rows.length < 2) continue
      /*
       * 把同组里分数不同的行拆开：保留"这一首对它的权重最高"的那行，
       * 其余行禁用这一首。权重相同时保留行号小的，保证确定性。
       */
      const scored = rows.map((i) => ({ i, w: weights[i][j], s: cards[i].score ?? null }))
      /*
       * 两条独立的"它们是两首歌"判据：
       *   ① **分数不同**（同一首歌在同一张表里只会出现一次，分数必然相同）；
       *   ② **卡面定数不同**（同一首歌在该难度下定数固定；
       *      实测 `#1`/`#10` 都读成 `GOODTEK`、分数都是 1000000，
       *      但一个定数 14.3（GOODTEK IN）、一个 16.7（Stasis AT），能区分）。
       *
       * 两条都不成立（分数与定数都相同）时**不拆**——没有可靠依据，
       * 强行拆解会把对的改错。
       */
      const distinctScores = new Set(scored.map((x) => x.s))
      const consts = new Set(rows.map((i) => cards[i].cardConstant ?? null))
      const constsKnown = [...consts].filter((v) => v !== null).length >= 2
      if (distinctScores.size < 2 && !constsKnown) continue
      scored.sort((a, b) => b.w - a.w || a.i - b.i)
      for (const x of scored.slice(1)) {
        if (!banned.has(x.i)) banned.set(x.i, new Set())
        banned.get(x.i)!.add(j)
        changed = true
      }
    }
    if (!changed) break
    best = solve(banned)
  }

  const assign = best.picks
  let total = 0
  for (let i = 0; i < cards.length; i++) {
    const j = assign[i]
    /*
     * 阈值：相似度太低时不如不给答案——交给上层标复核。
     * 0.5 与 `validateCandidate` 的子集内阈值一致。
     */
    const w = j >= 0 ? weights[i][j] : 0
    if (j >= 0 && w > 0.5) {
      byId.set(cards[i].id, entries[j].title)
      total += w
    } else {
      byId.set(cards[i].id, null)
    }
  }
  return { byId, totalWeight: total }
}

/**
 * 计算"逐格独立选第一名"的总权重，用于与联合分配比较。
 *
 * 联合分配只在**不更差**时才被采用（见单测"不会让结果变坏"）。
 */
export function independentTotalWeight(
  cards: AssignInput[],
  table: TierTable,
  gameId?: string
): number {
  const pool = table.entries.filter((e) => !gameId || !e.game || e.game === gameId)
  let total = 0
  for (const c of cards) {
    let best = 0
    for (const cand of c.candidates) {
      for (const e of pool) {
        let s = similarity(cand.text, e.title)
        for (const al of e.aliases ?? []) {
          const v = similarity(cand.text, al)
          if (v > s) s = v
        }
        if (s > best) best = s
      }
    }
    total += best
  }
  return total
}
