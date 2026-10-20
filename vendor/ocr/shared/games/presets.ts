import type { GameDefinition } from './types'
import { ARCAEA } from './arcaea'
export { ARCAEA }

export const GAMES: GameDefinition[] = [ARCAEA]

const BY_ID = new Map(GAMES.map((g) => [g.id, g]))

export function getGame(id: string): GameDefinition | undefined {
  return BY_ID.get(id)
}

export function requireGame(id: string): GameDefinition {
  const game = BY_ID.get(id)
  if (!game) throw new Error(`未知游戏：${id}`)
  return game
}
