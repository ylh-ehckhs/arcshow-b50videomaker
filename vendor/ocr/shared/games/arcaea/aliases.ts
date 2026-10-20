import data from './tiers.json'

// 官方搜索名和日文名来自仓库已有的 songlist.json、jp-names.json；不推测译名。
const aliases = new Map<string, readonly string[]>(
  data.entries.map((entry) => [entry.title, 'aliases' in entry ? entry.aliases ?? [] : []])
)

export function builtInArcaeaAliases(title: string): readonly string[] {
  return aliases.get(title) ?? []
}
