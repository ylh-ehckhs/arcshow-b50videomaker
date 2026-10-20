import type { GameDefinition } from '../types'

export const ARCAEA: GameDefinition = {
  id: 'arcaea',
  name: 'Arcaea',
  difficulties: [
    { code: 'PST', order: 1 },
    { code: 'PRS', order: 2 },
    { code: 'FTR', order: 3 },
    {
      code: 'ETR',
      order: 4,
      note: '结算界面定数显示为 FTR 定数 +0.7（如 10+），公式使用真实定数'
    },
    { code: 'BYD', order: 5 }
  ],
  score: {
    max: 10_000_000,
    displaySeparator: "'",
    tolerantSeparators: ["'", ',', ' ', '，', '’', '＇']
  },
  composite: {
    label: 'Potential',
    decimals: 4,
    rounding: 'truncate',
    inputs: ['score', 'gradeBonus']
  },
  judgement: {
    top: 'Pure',
    faults: ['Far', 'Lost']
  },
  usesClearStatus: true,
  usesAccuracy: false
}
