/**
 * 定数表：曲名 + 难度 → 定数。
 *
 * 为什么需要它：
 *   - 手填定数是最容易出错、也最费事的环节（每张谱面都要查表）；
 *   - 后续的 OCR 识别必须靠它**交叉校验**——OCR 把 `10.7` 读成 `10.1` 时，
 *     只有定数表能发现并纠正。
 *
 * 设计要点：
 *   - 数据存 JSON，带 `version` / `source` / `updatedAt`，便于追溯来源与更新；
 *   - 支持三种导入源：JSON（完整结构）、CSV（带表头）、TSV（直接从 wiki 表格复制粘贴）；
 *   - 查表用**归一化标题**：全角转半角、去空格与常见标点、统一大小写，
 *     这样 OCR 少一个空格或标点错位也能匹配上。
 */

/** 一条曲目的定数记录：`tiers` 是「难度代号 → 定数」 */
export interface TierEntry {
  /** 曲名（原样保留，展示用） */
  title: string
  /**
   * 所属游戏 id（当前版本为 `arcaea`）。
   *
   * ⚠ 这个字段是必需的：**同名曲目在不同游戏里定数不同**
   * （实测 `Stasis` 在 Arcaea 是 FTR 10.8、在 Phigros 是 IN 15.3）。
   * 早期按"曲名 ≠ 重复"去重，把两条并成一条，跨游戏查表会污染结果。
   * 允许为空以兼容早期导出/手写的数据：空的条目在查表时**对任意游戏都参与匹配**。
   */
  game?: string
  /**
   * 曲目别名（常用叫法 / 中文译名 / 日文原名等），可多个。
   *
   * 为什么是数组而不是单个字符串：一首曲目常有多个常用叫法
   * （如 `Filament` → "灯丝"、"灯芯"），
   * 而别名越多，OCR 的模糊曲名匹配命中率越高。
   * 早期只存第一个，等于把补全到手的可用信息丢掉一半。
   *
   * ⚠ 兼容性：早期文件与手写数据用的是单数 `alias`（字符串）。
   * 解析时会自动转成 `aliases`，见各解析函数里的 `readAliases()`。
   */
  aliases?: string[]
  /** @deprecated 旧字段，仅为兼容旧文件而读取；写入时一律用 `aliases` */
  alias?: string
  /** 难度代号 → 定数，例如 { FTR: 10.7, BYD: 11.0 } */
  tiers: Record<string, number>
}

/**
 * 读取别名，兼容单数 `alias` 与复数 `aliases` 两种写法。
 *
 * 抽成函数是因为解析路径很多（多行粘贴、分隔符、JSON、Arcaea 行格式），
 * 每一处都手写一遍兼容逻辑容易漏。
 */
export function readAliases(obj: { alias?: string; aliases?: string[] }): string[] {
  const out: string[] = []
  if (Array.isArray(obj.aliases)) {
    for (const a of obj.aliases) if (typeof a === 'string' && a.trim()) out.push(a.trim())
  }
  if (typeof obj.alias === 'string' && obj.alias.trim()) out.push(obj.alias.trim())
  // 去重（旧文件可能两个字段都写了同一个值）
  return [...new Set(out)]
}

/** 定数表文件结构 */
export interface TierTable {
  /** 结构版本，便于将来迁移 */
  version: number
  /** 数据来源说明（内置种子 / 用户导入 / wiki） */
  source: string
  /** 最后更新时间（ISO 字符串） */
  updatedAt: string
  /** 曲目列表 */
  entries: TierEntry[]
}

/** 当前结构版本 */
export const TIERS_VERSION = 1

/** 内置种子表的数据来源说明 */
export const SEED_SOURCE = '内置种子（取自用户提供的 Arcaea / Phigros 长分表实测数据）'

/** 空表 */
export function emptyTierTable(source = ''): TierTable {
  return { version: TIERS_VERSION, source, updatedAt: new Date().toISOString(), entries: [] }
}

/** 难度代号白名单（用于从粘贴文本里识别哪一列是难度） */
export const KNOWN_DIFFICULTY_CODES = [
  'PST',
  'PRS',
  'FTR',
  'ETR',
  'BYD',
  'EZ',
  'HD',
  'IN',
  'AT',
  'SP',
  'LEGACY'
] as const

/**
 * 归一化曲名，用于查表匹配。
 *
 * 处理：全角→半角、去首尾空白、合并连续空白、去掉空格与常见分隔标点、转小写。
 * 注意**不做**音译或去括号内容——那会让不同曲目误撞（例如 `Song (Extended)`）。
 */
export function normalizeTitle(raw: string): string {
  if (!raw) return ''
  let s = raw.normalize('NFKC').replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0)-0x60))
  // 去掉零宽字符（wiki 复制常见）
  s = s.replace(/[\u200b-\u200f\ufeff]/g, '')
  s = s.trim().toLowerCase()
  // 去掉空白与常见分隔标点（保留字母数字与 CJK、希腊字母）
  s = s.replace(/[\s'"`~!@#$%^&*()+=[\]{};:,.?/\\|<>_\-–—·、。，；：？！“”‘’（）《》〈〉【】「」『』]/g, '')
  return s
}

/** 归一化难度代号：大写、去空白 */
export function normalizeDifficulty(raw: string): string {
  return (raw || '').normalize('NFKC').trim().toUpperCase().replace(/[\s[\]［］]/g, '')
}

/**
 * 归一化定数文本。
 *
 * 接受 `10.7` / `10,7` / `１４.３`（全角）/ `10.7 (11.0)`（取第一个数）。
 * 返回 null 表示不是合法定数。
 */
export function parseConstantText(raw: string): number | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).normalize('NFKC').replace(',', '.')
  const m = s.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const value = Number.parseFloat(m[0])
  if (!Number.isFinite(value)) return null
  // 合理区间：音游定数一般 1–20；超出范围视为误读
  if (value < 1 || value > 20) return null
  return Math.round(value * 10) / 10
}

/** 解析结果：解析出的记录 + 被跳过的行（便于界面提示） */
export interface TierParseResult {
  entries: TierEntry[]
  /** 被跳过的行及原因，供界面展示 */
  skipped: Array<{ line: string; reason: string }>
}

/**
 * 难度代号 → 列位置（Phigros 定数表用固定 4 列）。
 * 顺序即表中列序，不可随意调换。
 */
const PHIGROS_DIFF_COLUMNS = ['EZ', 'HD', 'IN', 'AT'] as const

/**
 * 解析**多行式**定数表（实测来源：Phigros 定数表 txt 导出）。
 *
 * 实测数据长这样（每个曲目占 3 行，第三行才是定数；字段用制表符分隔但**会粘连**）：
 *
 * ```
 * 曲目/曲目ID  曲师  画师  EZ  HD  IN  AT      ← 表头
 * Introduction                                 ← 第 1 行：曲名
 * Introduction                                 ← 第 2 行：曲名.曲目ID
 * -  L-sp4  1.0  -  -  -                       ← 第 3 行：定数
 * 瓷岁
 * 瓷岁.茶鸣拾贰律
 * 茶鸣拾贰律  茶鸣拾贰律  2.0  6.5  7.0  -
 * Desultory Signals
 * DesultorySignals.technoplanet
 * technoplanet  月光大刺剑  10.0  14.0  17.0  18.0
 * ```
 *
 * 难点（都在下面处理了）：
 *   - 定数行前面还有曲师/画师列，且**这两列可能粘连成"a || b"**；
 *   - 定数行开头可能是 `-`（没有曲师信息）；
 *   - 第 2 行是 `曲名.曲目ID`，不能用它当曲名（会带上 ID 后缀）。
 *
 * 判据：**以最后一行的末尾 4 个单元格为定数**，曲名取其上方第 3 行的首个单元格。
 */
export function parseMultilineTierSheet(text: string): TierParseResult {
  const skipped: Array<{ line: string; reason: string }> = []
  const allLines = text
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
  if (allLines.length === 0) return { entries: [], skipped }

  const rows: Array<{ title: string; alias?: string; difficulty: string; constant: number }> = []
  /** 收集最近的非空行（用于回溯曲名） */
  const recent: string[] = []

  for (const raw of allLines) {
    if (!raw.trim()) {
      recent.length = 0
      continue
    }
    // 表头行跳过
    if (/EZ\s*\t?\s*HD\s*\t?\s*IN/.test(raw)) continue

    const isDataRow = /^[\d\-.\s\|\S]*?\d+\.\d/.test(raw) && (raw.includes('\t') || /\s{2,}/.test(raw))
    if (!isDataRow) {
      recent.push(raw)
      if (recent.length > 4) recent.shift()
      continue
    }

    // 拆列：优先制表符，否则按 2+ 空格
    const cells = (raw.includes('\t') ? raw.split('\t') : raw.split(/\s{2,}/)).map((c) => c.trim())
    // 末尾 4 格是 EZ/HD/IN/AT
    if (cells.length < 4) {
      skipped.push({ line: raw, reason: '列数不足，找不到 4 个难度的定数' })
      recent.length = 0
      continue
    }
    const tierCells = cells.slice(-4)
    // 定数列必须全是"数字或短横线"，否则说明拆列拆错了（例如曲师名里带小数点）
    if (!tierCells.every((c) => c === '-' || /^\d{1,2}(\.\d)?$/.test(c))) {
      skipped.push({ line: raw, reason: '末 4 列不是合法的定数（可能是曲师名里含小数点导致拆列错误）' })
      recent.length = 0
      continue
    }

    // 曲名取"上方第 3 行"（曲名 / 曲名.曲目ID / 定数行）
    const titleLine = recent.length >= 3 ? recent[recent.length - 3] : recent[0]
    const idLine = recent.length >= 1 ? recent[recent.length - 1] : undefined
    if (!titleLine) {
      skipped.push({ line: raw, reason: '回溯不到曲名' })
      recent.length = 0
      continue
    }
    const title = titleLine.trim()
    // 外号取"曲名.曲目ID"去掉曲名前缀后的部分（通常是曲目 ID，用于搜索）
    let alias: string | undefined
    if (idLine && idLine !== title) {
      const suffix = idLine.startsWith(title) ? idLine.slice(title.length).replace(/^[.·\s]+/, '') : ''
      if (suffix && suffix.length >= 2) alias = suffix
    }

    PHIGROS_DIFF_COLUMNS.forEach((code, i) => {
      const cell = tierCells[i]
      if (cell === '-' || cell === '') return
      const value = parseConstantText(cell)
      if (value === null) return
      rows.push({ title, alias, difficulty: code, constant: value })
    })
    recent.length = 0
  }

  return { entries: groupEntries(rows), skipped }
}

/** Arcaea 定数表列序（PDF 表头：`曲目 PST PRS FTR BYD/INS ETR`） */
const ARCAEA_DIFF_COLUMNS = ['PST', 'PRS', 'FTR'] as const

/**
 * 第 4 列标为 INS 的曲目（用户明确指出的例外）。
 *
 * 用户的说明：**只有这几首有 INS 难度，其余第 4 列都是 BYD**。
 * 数据来源 Arcaea 中文 wiki。
 */
export const ARCAEA_INS_SONGS: readonly string[] = [
  'DREAD AREA',
  'Riven Pilgrimage',
  'Cataclysm Cry',
  'DEINOS PHAINEIN'
]

/** 判断某曲线名的第 4 列应记为 INS 还是 BYD */
export function arcaeaSlot4Code(title: string): 'INS' | 'BYD' {
  const key = title.trim().toLowerCase()
  return ARCAEA_INS_SONGS.some((s) => s.toLowerCase() === key) ? 'INS' : 'BYD'
}

/**
 * 解析**逐行式**定数表（实测来源：`Arcaea定数详表 - Arcaea中文维基.pdf` 提取的文本）。
 *
 * 实测格式：每行 `曲名 PST PRS FTR [第4列]`，例如
 *
 * ```
 * Testify 7.8 9.4 10.9 12.0        ← 有第 4 列（BYD/INS）
 * Genesis 2.0 5.5 8.2              ← 只有 3 列
 * Abstruse Dilemma 5.5 8.9 11.3
 * ```
 *
 * 实测统计（553 行）：374 行 3 值、178 行 4 值、**没有 5 值行**——
 * 因为 ETR 与 BYD 互斥（同一谱面不会两者兼有），PDF 把它们都放在第 4 列。
 *
 * ⚠ 第 4 列的代号判定：按用户说明，**只有 `ARCAEA_INS_SONGS` 里的 4 首是 INS**，
 * 其余一律记为 BYD。
 *
 * ⚠⚠ 但这个纯文本解析器**无法区分 BYD 与 ETR**，原因很关键：
 *   PDF 的表头是 `曲名 PST PRS FTR BYD/INS ETR` —— **BYD/INS 与 ETR 是两列**。
 *   只保留文本流时，两列之间的空格会丢失（实测 `Inverted World` 的 BYD 列是空的，
 *   于是 `... 9.5 10.7` 看起来像"第 4 列 = 10.7"，但那其实是 ETR）。
 *   实测共 110 条 ETR、61 条 BYD，纯文本下会全部误判为 BYD。
 *
 *   正确做法是**按列坐标提取**（用 pdf.js 的 `getTextContent()` 取每项的 x，
 *   再按表头实测的列位归类：PST≈296 / PRS≈333 / FTR≈369 / BYD-INS≈415 / ETR≈462）。
 *   内置数据 `src/shared/games/arcaea/tiers.json` 就是这样生成的。
 *
 *   本函数因此只作为"用户手动粘贴 Arcaea 文本表"的**兜底**：
 *   用户粘贴的场景里第 4 列通常是 BYD/INS（用户自己也说"别的曲目都是 BYD"），
 *   若要精确区分 ETR，请直接用导出的 JSON。
 */
export function parseArcaeaSheet(text: string): TierParseResult {
  const skipped: Array<{ line: string; reason: string }> = []
  const rows: Array<{ title: string; difficulty: string; constant: number }> = []

  for (const raw of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // 表头与页标记
    if (/^曲目\s/.test(line) || /^=====/.test(line)) continue
    // 必须以"数值结尾"才算数据行
    const m = line.match(/^(.*?)\s+((?:\d{1,2}\.\d\s*)+)$/)
    if (!m) continue
    const title = m[1].trim()
    const nums = m[2].trim().split(/\s+/).map((s) => Number.parseFloat(s))
    if (!title) {
      skipped.push({ line, reason: '找不到曲名' })
      continue
    }
    if (nums.length < 3) {
      skipped.push({ line, reason: `只有 ${nums.length} 个定数（至少需要 PST/PRS/FTR）` })
      continue
    }
    // 前 3 个是 PST/PRS/FTR
    ARCAEA_DIFF_COLUMNS.forEach((code, i) => {
      rows.push({ title, difficulty: code, constant: nums[i] })
    })
    // 第 4 个是 BYD 或 INS（ETR 也在此列，按用户说明归为 BYD 组）
    if (nums.length >= 4) {
      rows.push({ title, difficulty: arcaeaSlot4Code(title), constant: nums[3] })
    }
    if (nums.length > 4) {
      skipped.push({ line, reason: `出现 ${nums.length} 个定数（预期最多 4 个），多余的已忽略` })
    }
  }

  return { entries: groupEntries(rows), skipped }
}

/**
 * 解析全部格式（最终入口）。
 *
 * 判断顺序：
 *   JSON → 含制表符（多行式 / 单行 TSV）→ 形如 Arcaea 逐行式 → CSV。
 */
export function parseTierSource(text: string): TierParseResult {
  const trimmed = text.replace(/^\ufeff/, '').trim()
  if (!trimmed) return { entries: [], skipped: [{ line: '', reason: '内容为空' }] }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseTierJson(trimmed)
  if (trimmed.includes('\t')) {
    // 先试多行式：若它解析出的条目明显更多，说明就是这种格式
    const multi = parseMultilineTierSheet(trimmed)
    const single = parseDelimited(trimmed, '\t')
    if (multi.entries.length > single.entries.length) return multi
    return single
  }
  // 逐行式（Arcaea PDF 提取文本）：多行都以"数字 数字 数字"结尾
  const arc = parseArcaeaSheet(trimmed)
  if (arc.entries.length > 0) return arc
  return parseDelimited(trimmed, ',')
}

/** 把「一行一条」的解析结果按「游戏 + 曲名」合并（同一曲目的多个难度并到一起） */
function groupEntries(rows: Array<{ title: string; game?: string; alias?: string; difficulty: string; constant: number }>): TierEntry[] {
  const map = new Map<string, TierEntry>()
  for (const row of rows) {
    // key 含游戏：同名曲目在不同游戏里是两条记录
    const key = `${(row.game ?? '').toLowerCase()}\u0000${normalizeTitle(row.title)}`
    if (!normalizeTitle(row.title)) continue
    const existing = map.get(key)
    if (existing) {
      existing.tiers[normalizeDifficulty(row.difficulty)] = row.constant
      if (row.alias) existing.aliases = [...new Set([...readAliases(existing), row.alias])]
    } else {
      map.set(key, {
        title: row.title,
        ...(row.game ? { game: row.game } : {}),
        ...(row.alias ? { aliases: [row.alias] } : {}),
        tiers: { [normalizeDifficulty(row.difficulty)]: row.constant }
      })
    }
  }
  return [...map.values()]
}

/**
 * 解析 CSV / TSV 文本。
 *
 * 支持的列名（中英文皆可，顺序任意）：
 *   - 曲名：`title` / `曲名` / `歌名` / `name` / `song`
 *   - 难度：`difficulty` / `难度` / `diff` / `等级`
 *   - 定数：`constant` / `定数` / `rating` / `数值`
 *   - 游戏（可选）：`game` / `游戏`
 *   - 外号（可选）：`alias` / `外号`
 *
 * 没有表头时退化为「按列猜」：找出难度列（值是已知代号）、定数列（1–20 的数），
 * 其余第一列作为曲名。
 */
export function parseDelimited(text: string, delimiter: ',' | '\t'): TierParseResult {
  const skipped: Array<{ line: string; reason: string }> = []
  const lines = text
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return { entries: [], skipped }

  const splitRow = (line: string): string[] => {
    if (delimiter === '\t') return line.split('\t').map((c) => c.trim())
    // CSV：处理双引号包裹
    const cells: string[] = []
    let cur = ''
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"'
            i++
          } else inQuote = false
        } else cur += ch
      } else if (ch === '"') inQuote = true
      else if (ch === ',') {
        cells.push(cur.trim())
        cur = ''
      } else cur += ch
    }
    cells.push(cur.trim())
    return cells
  }

  const header = splitRow(lines[0]).map((c) => c.toLowerCase())
  const findCol = (names: string[]): number => header.findIndex((h) => names.some((n) => h === n || h.includes(n)))
  const colTitle = findCol(['title', '曲名', '歌名', 'name', 'song'])
  const colDiff = findCol(['difficulty', '难度', 'diff', '等级'])
  const colConst = findCol(['constant', '定数', 'rating', '数值'])
  const colAlias = findCol(['alias', '外号'])
  const colGame = findCol(['game', '游戏'])

  const hasHeader = colTitle >= 0 && colDiff >= 0 && colConst >= 0
  const rows: Array<{ title: string; game?: string; alias?: string; difficulty: string; constant: number }> = []

  const body = hasHeader ? lines.slice(1) : lines
  for (const line of body) {
    const cells = splitRow(line)
    let title = ''
    let game: string | undefined
    let alias: string | undefined
    let difficulty = ''
    let constant: number | null = null

    if (hasHeader) {
      title = cells[colTitle] ?? ''
      game = colGame >= 0 ? cells[colGame]?.toLowerCase() || undefined : undefined
      alias = colAlias >= 0 ? cells[colAlias] || undefined : undefined
      difficulty = cells[colDiff] ?? ''
      constant = parseConstantText(cells[colConst] ?? '')
    } else {
      // 无表头：按内容猜列
      const known = new Set<string>(KNOWN_DIFFICULTY_CODES)
      let diffIdx = -1
      let constIdx = -1
      cells.forEach((c, i) => {
        const code = normalizeDifficulty(c)
        if (diffIdx < 0 && known.has(code)) {
          diffIdx = i
          return
        }
        if (constIdx < 0 && parseConstantText(c) !== null) constIdx = i
      })
      if (diffIdx >= 0) difficulty = cells[diffIdx]
      if (constIdx >= 0) constant = parseConstantText(cells[constIdx])
      const titleIdx = cells.findIndex((_, i) => i !== diffIdx && i !== constIdx && cells[i].length > 0)
      if (titleIdx >= 0) title = cells[titleIdx]
    }

    if (!title) {
      skipped.push({ line, reason: '找不到曲名' })
      continue
    }
    const code = normalizeDifficulty(difficulty)
    if (!code) {
      skipped.push({ line, reason: '找不到难度代号' })
      continue
    }
    if (constant === null) {
      skipped.push({ line, reason: '定数无法识别或超出 1–20 合理区间' })
      continue
    }
    rows.push({ title, game, alias, difficulty: code, constant })
  }

  return { entries: groupEntries(rows), skipped }
}

/** 解析 JSON 文本（支持完整结构，也支持只给 entries 数组） */
export function parseTierJson(text: string): TierParseResult {
  const skipped: Array<{ line: string; reason: string }> = []
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ''))
  } catch (error) {
    return { entries: [], skipped: [{ line: text.slice(0, 80), reason: `JSON 解析失败：${(error as Error).message}` }] }
  }

  // 形态一：完整结构 { entries: [...] }；形态二：直接是数组
  let rawList: unknown[] | null = null
  if (Array.isArray(data)) {
    rawList = data as unknown[]
  } else if (data && typeof data === 'object') {
    const maybe = (data as { entries?: unknown }).entries
    if (Array.isArray(maybe)) rawList = maybe as unknown[]
  }
  if (!rawList) {
    return { entries: [], skipped: [{ line: '', reason: 'JSON 结构不认识（既不是数组，也没有 entries 字段）' }] }
  }

  const table: TierEntry[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object') {
      skipped.push({ line: JSON.stringify(item).slice(0, 60), reason: '不是对象' })
      continue
    }
    const obj = item as Record<string, unknown>
    const title = typeof obj.title === 'string' ? obj.title : ''
    if (!title) {
      skipped.push({ line: JSON.stringify(item).slice(0, 60), reason: '缺少 title' })
      continue
    }
    const tiersRaw = (obj.tiers ?? obj.constants ?? obj.difficulties) as Record<string, unknown> | undefined
    if (!tiersRaw || typeof tiersRaw !== 'object') {
      skipped.push({ line: title, reason: '缺少 tiers（难度→定数）' })
      continue
    }
    const tiers: Record<string, number> = {}
    for (const [k, v] of Object.entries(tiersRaw)) {
      const code = normalizeDifficulty(k)
      const value = typeof v === 'number' ? v : parseConstantText(String(v))
      if (!code || value === null) continue
      tiers[code] = value
    }
    if (Object.keys(tiers).length === 0) {
      skipped.push({ line: title, reason: 'tiers 里没有合法定数' })
      continue
    }
    /* 别名兼容单数 `alias`（旧文件）与复数 `aliases`（新格式） */
    const aliases = readAliases(obj as { alias?: string; aliases?: string[] })
    table.push({
      title,
      ...(typeof obj.game === 'string' && obj.game ? { game: obj.game.toLowerCase() } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      tiers
    })
  }
  return { entries: table, skipped }
}

/**
 * 把定数表导出成 CSV / TSV 文本。
 *
 * ## 格式必须能被自己的解析器读回
 *
 * `parseDelimited` 读的表头是 `title/difficulty/constant/alias/game`，
 * 所以导出用**同一套列名**（英文，避免不同工具的编码问题），
 * 形成"导出 → 重新导入"的闭环。**往返一致性有单测守住。**
 *
 * ## 为什么是"一行一个定数"的长表
 *
 * 一首曲目有多个难度（`FTR: 10.7, BYD: 11.0`），而 CSV 是二维表。
 * 选长表（每个难度占一行）而不是"难度作为列"的宽表，原因：
 *   - 与本项目解析器的能力一致（它按 `difficulty` 列逐行读）；
 *   - 不同游戏的难度代号不同（Arcaea 是 FTR、Phigros 是 IN），
 *     宽表会出现大量空列；
 *   - 用户在 Excel 里筛选/排序更方便。
 *
 * ## 转义
 *
 * 含逗号 / 双引号 / 换行的字段用双引号包裹、内部双引号翻倍（RFC 4180）。
 * 曲名里出现逗号并不罕见，所以转义必须做对。
 */
export function toDelimited(table: TierTable, delimiter: ',' | '\t' = ','): string {
  const escape = (v: string): string => {
    if (delimiter === '\t') {
      // TSV：制表符无法转义，直接换成空格
      return v.replace(/[\t\r\n]+/g, ' ')
    }
    if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
    return v
  }

  const header = ['title', 'game', 'difficulty', 'constant', 'alias']
  const lines: string[] = [header.join(delimiter)]

  /*
   * 排序：先游戏、再曲名。
   * 排序不影响解析正确性，但让导出文件在 Excel 里**可读、可比对**——
   * 导出主要就是给人看的。
   */
  const entries = [...table.entries].sort(
    (a, b) => (a.game ?? '').localeCompare(b.game ?? '') || a.title.localeCompare(b.title)
  )

  for (const e of entries) {
    /*
     * 归一化后为空的曲名（如权威表里的 `~_+`，全是符号）**不导出**。
     *
     * 原因：导入侧 `groupEntries` 有 `if (!normalizeTitle(row.title)) continue`，
     * 会静默丢弃这类曲名。那是**必要的**守卫（没有它，短标题会匹配一切，
     * 见 `normalizeTitle` 的注释），但导出侧必须与之保持一致——
     * 否则导出文件里有一行永远回不来，往返验证就成了假失败。
     * 与其让它静默消失，不如一开始就不写出去。
     */
    if (!normalizeTitle(e.title)) continue

    /*
     * 别名**逐行导出**（不是用顿号拼成一格）。
     *
     * 解析器一次只接受一个别名（`alias` 是单值字段），多别名用一行表达不了；
     * 而 `groupEntries` 会把同一曲目的多行合并、并集化别名数组，
     * 所以多写几行正好还原成数组。
     * 早期拼成"灯丝、灯芯"一格，导回后变成一个含顿号的长别名——
     * 那不是等价往返。
     */
    const aliases = readAliases(e)
    const aliasRows = aliases.length > 0 ? aliases : ['']
    // 难度代号排序，保证同一曲目的多行顺序稳定
    for (const code of Object.keys(e.tiers).sort()) {
      const value = e.tiers[code]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      for (const alias of aliasRows) {
        lines.push(
          [
            escape(e.title),
            escape(e.game ?? ''),
            escape(code),
            // 固定 1 位小数：与定数表显示一致，也避免 10.700000000000001
            escape(value.toFixed(1)),
            escape(alias)
          ].join(delimiter)
        )
      }
    }
  }
  return lines.join('\r\n') + '\r\n'
}

/** 合并策略 */
export type MergeStrategy = 'merge' | 'replace'

/**
 * 把导入结果并入现有表。
 *
 * - `merge`（默认）：同名曲目**按难度合并**，导入值覆盖旧的同难度值，其他难度保留；
 * - `replace`：完全替换为用户导入的内容。
 *
 * 返回新表（不修改入参）。
 */
export function mergeTierTables(
  base: TierTable,
  incoming: TierEntry[],
  strategy: MergeStrategy,
  source: string
): TierTable {
  const keyOf = (e: TierEntry): string => `${(e.game ?? '').toLowerCase()}\u0000${normalizeTitle(e.title)}`
  const entries =
    strategy === 'replace'
      ? incoming.map((e) => ({ ...e, tiers: { ...e.tiers } }))
      : (() => {
          const map = new Map<string, TierEntry>()
          for (const e of base.entries) {
            map.set(keyOf(e), { ...e, tiers: { ...e.tiers } })
          }
          for (const e of incoming) {
            const key = keyOf(e)
            if (!normalizeTitle(e.title)) continue
            const existing = map.get(key)
            if (existing) {
              Object.assign(existing.tiers, e.tiers)
              if (e.aliases || e.alias) {
            existing.aliases = [
              ...new Set([...(existing.aliases ?? []), ...readAliases(e)])
            ]
          }
            } else {
              map.set(key, { ...e, tiers: { ...e.tiers } })
            }
          }
          return [...map.values()]
        })()

  return {
    version: TIERS_VERSION,
    source,
    updatedAt: new Date().toISOString(),
    entries
  }
}

/**
 * 查定数。
 *
 * 匹配顺序：
 *   1. 游戏 + 曲名**同时**命中（最精确，避免同名跨游戏污染）；
 *   2. 条目未标注游戏 → 对任意游戏都算命中；
 *   3. 调用方没给 gameId → 退化为"按曲名第一个命中的条目"。
 *
 * 找不到返回 null（调用方决定是提示还是留空）。
 */
export function lookupConstant(
  table: TierTable,
  title: string,
  difficulty: string,
  gameId?: string
): number | null {
  const key = normalizeTitle(title)
  if (!key) return null
  const code = normalizeDifficulty(difficulty)
  if (!code) return null
  const wanted = (gameId ?? '').toLowerCase()

  let loose: number | null = null
  for (const entry of table.entries) {
    if (normalizeTitle(entry.title) !== key) continue
    const value = entry.tiers[code]
    if (typeof value !== 'number') continue
    const entryGame = (entry.game ?? '').toLowerCase()
    // 精确命中：游戏一致
    if (wanted && entryGame === wanted) return value
    // 条目未标游戏：对任意游戏都可见
    if (!entryGame) {
      if (wanted) return value
      loose = loose ?? value
    }
    // 没给 gameId：记下第一个候选
    if (!wanted) loose = loose ?? value
  }
  return loose
}

/** 判断某个条目的游戏是否与查询匹配（供搜索过滤用） */
function gameMatches(entryGame: string | undefined, wanted: string): boolean {
  if (!wanted) return true
  const g = (entryGame ?? '').toLowerCase()
  // 未标游戏的条目对所有游戏都可见（兼容旧数据）
  return !g || g === wanted
}

/** 按曲名（或外号）模糊搜索，供界面上的搜索框使用；`gameId` 用于过滤同一曲名 */
export function searchTiers(table: TierTable, query: string, limit = 30, gameId?: string): TierEntry[] {
  const wanted = (gameId ?? '').toLowerCase()
  const visible = table.entries.filter((e) => gameMatches(e.game, wanted))
  const q = normalizeTitle(query)
  if (!q) return visible.slice(0, limit)
  const scored: Array<{ entry: TierEntry; score: number; len: number }> = []
  for (const entry of visible) {
    const t = normalizeTitle(entry.title)
    const a = (entry.aliases ?? []).map(normalizeTitle).join(' ')
    let score = -1
    if (t === q || a === q) score = 0
    else if (t.startsWith(q) || a.startsWith(q)) score = 1
    else if (t.includes(q) || a.includes(q)) score = 2
    if (score >= 0) scored.push({ entry, score, len: Math.min(t.length || Infinity, a.length || Infinity) })
  }
  // 先按匹配质量，再按**匹配长度更短者优先**（同前缀时更短的曲名更接近查询），
  // 最后才按字母序保证稳定。曾经只按字母序，导致查 `sta` 时 `Stardust` 排在 `Stasis` 前。
  scored.sort((x, y) => x.score - y.score || x.len - y.len || x.entry.title.localeCompare(y.entry.title))
  return scored.slice(0, limit).map((s) => s.entry)
}

/** 统计：曲目数与各难度的记录条数，供界面展示 */
export function tierStats(table: TierTable): { songs: number; records: number; byDifficulty: Record<string, number> } {
  const byDifficulty: Record<string, number> = {}
  let records = 0
  for (const e of table.entries) {
    for (const code of Object.keys(e.tiers)) {
      byDifficulty[code] = (byDifficulty[code] ?? 0) + 1
      records++
    }
  }
  return { songs: table.entries.length, records, byDifficulty }
}

/** 校验表结构（读取用户文件时用，避免坏数据导致崩溃） */
export function isValidTierTable(value: unknown): value is TierTable {
  if (!value || typeof value !== 'object') return false
  const t = value as Partial<TierTable>
  return Array.isArray(t.entries) && t.entries.every((e) => e && typeof e.title === 'string' && e.tiers && typeof e.tiers === 'object')
}
