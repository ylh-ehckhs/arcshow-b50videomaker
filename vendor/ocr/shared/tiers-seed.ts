/**
 * 内置定数表。
 *
 * Arcaea 是**权威数据**（由用户提供、解析生成），不是手抄：
 *
 * | 游戏 | 来源 | 规模 |
 * |---|---|---|
 * | Arcaea | `Arcaea定数详表 - Arcaea中文维基.pdf`（arcaea 中文 wiki） | 548 首 |
 *
 * 生成产物在 `src/shared/games/arcaea/tiers.json`，
 * 重新生成的步骤见本文件末尾注释。
 *
 * ⚠ 历史教训：
 *   1. 这两个表最初是我从长分表卡面**手抄**的（Arcaea 11 首 / Phigros 8 首），
 *      Arcaea 更是把 BYD 定数当成了 FTR（`Inverted World` 的 FTR 其实是 9.5，
 *      卡面上那个 10.7 是 BYD）。**手抄数据不可靠，宁可用权威表。**
 *   2. `game` 字段必需：同名曲目在不同游戏定数不同
 *      （实测 `Stasis`：Arcaea FTR 10.8 / Phigros IN 15.3）。
 */

import type { TierEntry } from './tiers'
import arcaeaData from './games/arcaea/tiers.json'

/**
 * 把 JSON 数据文件的条目转成 TierEntry。
 *
 * JSON 导入时 TS 会把各条目的 `tiers` 推断成互不兼容的联合类型
 * （有的带 BYD、有的带 INS），所以这里显式收宽为 `Record<string, number>`。
 */
const toEntries = (data: unknown, game: string): TierEntry[] => {
  const entries = (data as { entries: Array<{ title: string; tiers: Record<string, number>; aliases?: string[] }> }).entries
  // 别名参与搜索与全局分配，不能在种子转换时丢掉。
  return entries.map((e) => ({ game, title: e.title, tiers: { ...e.tiers },
    ...(e.aliases?.length ? { aliases: [...e.aliases] } : {}) }))
}

/** Arcaea：权威表（Arcaea 中文 wiki，含 PST/PRS/FTR/BYD，4 首 INS） */
export const ARCAEA_SEED: TierEntry[] = toEntries(arcaeaData, 'arcaea')

/** 数据来源说明（供界面展示与文档引用） */
export const ARCAEA_SOURCE = arcaeaData.source

/**
 * 全部内置种子。
 *
 * 注意这里**不能**按曲名去重：`Stasis` 在 Arcaea 与 Phigros 里各有一条，
 * 靠 `game` 字段区分（查表时按"游戏 + 曲名"精确匹配）。
 */
export const TIER_SEED: TierEntry[] = [...ARCAEA_SEED]

/*
 * 重新生成数据文件的步骤（拿到新版定数表时执行）：
 *
 *   # 1) 打包解析模块（纯 TS，Node 不能直接跑）
 *   node node_modules/esbuild/bin/esbuild src/shared/tiers.ts \
 *     --bundle --platform=node --format=esm --outfile=_tiers-bundle.mjs
 *
 *   # 2) Arcaea：PDF 需要先转文本（装一次 unpdf，仅开发用，不进包体）
 *   npm i -D unpdf && node _pdf.mjs      # 用 unpdf 的 extractText 写出 _arcaea_pdf.txt
 *   node _genarc.mjs                     # parseTierSource(text) → arcaea-tiers.json
 *
 *   # 3) 清理临时文件 _tiers-bundle.mjs / _pdf.mjs / _gen*.mjs / _arcaea_pdf.txt
 *
 * 生成脚本只保留 `title` / `game` / `tiers` 三个字段，
 * 丢掉曲师、画师、曲目 ID 等对查表无用的列。
 */
