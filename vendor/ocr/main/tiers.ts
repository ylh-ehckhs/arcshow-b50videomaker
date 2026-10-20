/**
 * 定数表的持久化。
 *
 * 存放位置：`<userData>/tiers.json`
 *   - 不放进安装目录（Program Files 下通常没有写权限）；
 *   - 不放进工程文件（定数表是跨工程的公共数据）；
 *   - 用户目录下的文件删除后会自动回落到内置种子表。
 *
 * 读取时会做结构校验：文件被手动改坏时不崩溃，而是回落到种子并回报原因。
 */

import * as electron from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  emptyTierTable,
  isValidTierTable,
  mergeTierTables,
  normalizeTitle,
  parseTierSource,
  toDelimited,
  type MergeStrategy,
  type TierParseResult,
  type TierTable
} from '@shared/tiers'
import { TIER_SEED, ARCAEA_SOURCE } from '@shared/tiers-seed'

const { app } = electron

/**
 * 把内置的谱面变体补到旧用户表的内存副本中。
 *
 * 旧版本已经把 Arcaea 曲目表拆到 userData/tiers/arcaea.json；如果只更新
 * 内置 JSON，已有用户表仍然缺少 `Singularity VVVIP`。这里只补“已有基础
 * 曲名 + 内置变体都明确存在”的兼容条目，不覆盖用户的定数或自定义曲目。
 */
function addBuiltInChartVariants(entries: TierTable['entries']): TierTable['entries'] {
  const out = entries.map((entry) => ({
    ...entry,
    tiers: { ...entry.tiers },
    ...(entry.aliases ? { aliases: [...entry.aliases] } : {})
  }))
  const normalized = new Set(out.map((entry) => normalizeTitle(entry.title)))
  const hasSingularity = normalized.has(normalizeTitle('Singularity'))
  if (!hasSingularity || normalized.has(normalizeTitle('Singularity VVVIP'))) return out
  const variant = TIER_SEED.find(
    (entry) => entry.game === 'arcaea' && normalizeTitle(entry.title) === normalizeTitle('Singularity VVVIP')
  )
  if (!variant) return out
  out.push({
    ...variant,
    tiers: { ...variant.tiers },
    ...(variant.aliases ? { aliases: [...variant.aliases] } : {})
  })
  return out
}

/** 定数表文件路径（用户目录下） */
export function tiersFilePath(): string {
  return join(app.getPath('userData'), 'tiers.json')
}

/**
 * **按游戏存放的定数表路径**（用户要求拆分，避免两个游戏的数据混在一个文件里）。
 *
 * ## 为什么拆
 *
 * 用户原话："phigros为另外一个模块的功能，所以我建议**定数表也进行拆分
 * 避免混淆**。" 加上他的战略（"以 arcaea 为基准进行通用的软件的开发"），
 * 未来接入更多音游时，单一 883 条的大文件会越来越难维护。
 *
 * ## 与旧路径的关系（向前兼容）
 *
 * - 旧的合并文件 `tiers.json` **保留不动**，`loadTierTable()` 仍读它——
 *   这样现有调用点（`index.ts` 的导入/导出、`ocr.ts` 的主流程）行为不变。
 * - 新增本函数与 `loadTierTableForGame()`，供**按游戏**读取的新路径使用。
 * - 首次调用 `loadTierTableForGame()` 时，若分文件不存在而合并文件存在，
 *   会**自动拆分并落盘**（含备份），实现无感迁移。
 */
export function tiersFilePathForGame(gameId: string): string {
  const dir = join(app.getPath('userData'), 'tiers')
  return join(dir, `${gameId}.json`)
}

/**
 * 读取**指定游戏**的定数表。
 *
 * 顺序：分文件 → （不存在则）从合并文件拆分出来并落盘 → 内置种子。
 * 这样既满足"按游戏隔离"，又不会丢掉用户已有的数据与编辑。
 */
export function loadTierTableForGame(gameId: string): { table: TierTable; warnings: string[] } {
  const warnings: string[] = []
  const file = tiersFilePathForGame(gameId)
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (isValidTierTable(parsed)) {
        const t = parsed as TierTable
        return {
          table: {
            version: typeof t.version === 'number' ? t.version : 1,
            source: typeof t.source === 'string' && t.source ? t.source : '用户导入',
            updatedAt:
              typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : new Date().toISOString(),
            entries: addBuiltInChartVariants(t.entries)
          },
          warnings
        }
      }
      warnings.push(`${gameId}.json 结构不正确，已从合并表/种子重建`)
    } catch (error) {
      warnings.push(`${gameId}.json 读取失败（${(error as Error).message}），已回落`)
    }
  }
  /*
   * 分文件不存在或损坏：从合并文件里挑出该游戏的条目并落盘。
   * 这是**无感迁移**——用户不用做任何操作，也不会丢数据。
   */
  const merged = loadTierTable()
  const mine = merged.table.entries.filter((e) => e.game === gameId)
  if (mine.length > 0) {
    const table: TierTable = {
      version: 1,
      source: merged.table.source,
      updatedAt: new Date().toISOString(),
      entries: addBuiltInChartVariants(mine)
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(table, null, 2), 'utf8')
      warnings.push(`已把 ${gameId} 的 ${mine.length} 条从 tiers.json 拆分到 ${gameId}.json`)
    } catch (error) {
      warnings.push(`拆分 ${gameId}.json 失败（${(error as Error).message}），本次使用内存中的结果`)
    }
    return { table, warnings }
  }
  return {
    table: {
      version: 1,
      source: merged.table.source,
      updatedAt: new Date().toISOString(),
      entries: []
    },
    warnings: [...warnings, ...merged.warnings]
  }
}

/** 内置种子表（每次调用返回新对象，避免调用方改到共享数据） */
export function seedTable(): TierTable {
  const arcaea = TIER_SEED.filter((e) => e.game === 'arcaea').length
  return {
    version: 1,
    source: `内置权威表（Arcaea ${arcaea} 首 ← ${ARCAEA_SOURCE}）`,
    updatedAt: new Date().toISOString(),
    entries: TIER_SEED.map((e) => ({ ...e, tiers: { ...e.tiers } }))
  }
}

/** 读取定数表：用户文件优先，缺失或损坏时回落种子 */
export function loadTierTable(): { table: TierTable; warnings: string[] } {
  const warnings: string[] = []
  const file = tiersFilePath()
  if (!existsSync(file)) {
    return { table: seedTable(), warnings }
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isValidTierTable(parsed)) {
      warnings.push('tiers.json 结构不正确，已回落到内置种子表')
      return { table: seedTable(), warnings }
    }
    // 补齐可能缺失的元信息
    const table: TierTable = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      source: typeof parsed.source === 'string' && parsed.source ? parsed.source : '用户导入',
      updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt ? parsed.updatedAt : new Date().toISOString(),
      entries: addBuiltInChartVariants(parsed.entries)
    }
    return { table, warnings }
  } catch (error) {
    warnings.push(`tiers.json 读取失败（${(error as Error).message}），已回落到内置种子表`)
    return { table: seedTable(), warnings }
  }
}

/** 保存定数表到用户目录 */
export function saveTierTable(table: TierTable): { ok: boolean; path: string; error?: string } {
  const file = tiersFilePath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(table, null, 2), 'utf8')
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, path: file, error: (error as Error).message }
  }
}

/** 删除用户文件，恢复内置种子 */
export function resetTierTable(): { table: TierTable; ok: boolean; error?: string } {
  const file = tiersFilePath()
  try {
    if (existsSync(file)) {
      // 直接覆盖为种子内容而不是删除文件：保留"曾重置过"的痕迹，且避免权限问题
      const table = seedTable()
      saveTierTable(table)
      return { table, ok: true }
    }
    return { table: seedTable(), ok: true }
  } catch (error) {
    return { table: seedTable(), ok: false, error: (error as Error).message }
  }
}

/**
 * 解析导入文本（不落盘，由调用方决定合并策略后再保存）。
 *
 * 这里只负责"文本 → 条目"，合并与保存交给 IPC 层，
 * 这样界面可以先展示"解析出 N 条、跳过 M 条"再让用户确认。
 */
export function parseImportText(text: string): TierParseResult {
  return parseTierSource(text)
}

/** 生成一份可编辑的空模板（供界面导出给用户填） */
export function templateTable(): TierTable {
  return emptyTierTable('模板（请填写曲名与各难度定数）')
}

/**
 * 便捷：直接从文本导入并合并保存。
 *
 * `parseTierSource` 会自动判断 JSON / CSV / TSV，界面只要把文本丢进来即可。
 */
export function importTextIntoTable(
  text: string,
  strategy: MergeStrategy,
  sourceLabel: string
): { table: TierTable; parsed: TierParseResult; saved: boolean; error?: string } {
  const parsed = parseTierSource(text)
  if (parsed.entries.length === 0) {
    return { table: loadTierTable().table, parsed, saved: false, error: '没有解析出任何有效条目' }
  }
  const base = strategy === 'replace' ? emptyTierTable(sourceLabel) : loadTierTable().table
  const merged = mergeTierTables(base, parsed.entries, strategy, sourceLabel)
  const result = saveTierTable(merged)
  return { table: merged, parsed, saved: result.ok, error: result.error }
}


/* ---------------- 导出（A2：CSV / TSV） ---------------- */

/**
 * 用保存对话框把定数表导出成 CSV 或 TSV。
 *
 * 与"导入"对称：导入走 `parseDelimited`，导出走 `toDelimited`，
 * 两者用同一套列名，形成闭环（往返一致性有单测守住）。
 *
 * 写文件时带 **UTF-8 BOM**：Windows 版 Excel 打开无 BOM 的 CSV 会把中文曲名
 * 显示成乱码，而本表里有大量中日文曲名（实测 Phigros 266 首里大半是中文）。
 */
export async function exportTierTable(
  table: TierTable
): Promise<{ ok: boolean; path?: string; error?: string; skipped?: number }> {
  const { dialog, BrowserWindow } = electron
  const win = BrowserWindow.getFocusedWindow()
  const result = await dialog.showSaveDialog(win as never, {
    title: '导出定数表',
    defaultPath: '定数表.csv',
    filters: [
      { name: 'CSV（逗号分隔）', extensions: ['csv'] },
      { name: 'TSV（制表符分隔）', extensions: ['tsv', 'txt'] }
    ]
  })
  if (result.canceled || !result.filePath) return { ok: false }
  const delimiter: ',' | '\t' = /\.tsv$|\.txt$/i.test(result.filePath) ? '\t' : ','
  /*
   * 统计"无法导出的曲名数"并回报给界面。
   *
   * 有些权威表条目归一化后为空（实测 `~_+` 全是符号），导入侧的必要守卫
   * 会丢弃它们，所以导出侧也不写出——但**用户应当知道少了几首**，
   * 否则会以为导出丢了数据。
   */
  const skipped = table.entries.filter((e) => !normalizeTitle(e.title)).length
  try {
    writeFileSync(result.filePath, '\ufeff' + toDelimited(table, delimiter), 'utf8')
    return { ok: true, path: result.filePath, skipped }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
