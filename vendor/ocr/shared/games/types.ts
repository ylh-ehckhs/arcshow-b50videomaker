/**
 * 各游戏配置的类型定义。
 *
 * 设计原则：新增游戏 = 新增一个 GameDefinition 常量 + 一个综合值计算函数，
 * 不需要改动 UI 与渲染层。
 */

/** 难度等级描述 */
export interface DifficultyLevel {
  /** 规范代号，统一大写，如 FTR / ETR / BYD / IN / AT */
  code: string
  /** 该难度在游戏内的顺序，用于排序与校验，数字越大越难 */
  order: number
  /**
   * 综合值计算时的定数修正说明（仅用于界面提示，不参与计算）。
   * 例如 Arcaea 的 ETR 在结算界面显示定数为 FTR 定数 +0.7，
   * 但综合值公式中使用的定数就是谱面真实定数本身。
   */
  note?: string
}

/** 分数显示与解析规则 */
export interface ScoreRules {
  /** 理论满分，用于分数反推准确率与合法性校验 */
  max: number
  /** 显示时的千分位分隔符，空字符串表示无分隔 */
  displaySeparator: string
  /** 解析时容错的额外分隔符 */
  tolerantSeparators: string[]
}

/** 综合能力值（Arcaea 的 Potential / Phigros 的 rks）展示规格 */
export interface CompositeSpec {
  /** 字段展示名，如 Potential / rks */
  label: string
  /** 小数位数 */
  decimals: number
  /**
   * 小数处理方式：
   * - 'truncate' 截断（Arcaea 实测为截断）
   * - 'round' 四舍五入
   */
  rounding: 'truncate' | 'round'
  /** 计算所需的输入量，决定校对界面显示哪些字段 */
  inputs: Array<'score' | 'accuracy' | 'gradeBonus'>
}

/** 判定计数的字段命名（各游戏叫法不同） */
export interface JudgementNaming {
  /** 最高判定的名称，如 Pure / Perfect。界面不渲染，仅用于推导通关状态 */
  top: string
  /** 失误判定列表（按严重程度递增），界面只渲染这些 */
  faults: string[]
}

export interface GameDefinition {
  /** 稳定 ID，用于工程文件与配置持久化 */
  id: string
  /** 展示名 */
  name: string
  /** 难度等级列表 */
  difficulties: DifficultyLevel[]
  /** 分数规则 */
  score: ScoreRules
  /** 综合值规格 */
  composite: CompositeSpec
  /** 判定命名 */
  judgement: JudgementNaming
  /**
   * 该游戏是否使用"通关状态奖励"（Arcaea 为 true：PM/FR/TC → +0.2，TL → +0）
   * 影响校对界面是否显示通关状态下拉框。
   */
  usesClearStatus: boolean
  /**
   * 该游戏是否要求准确率字段。
   * Arcaea 用不到（由分数计算）；Phigros 必需（可由分数反推）。
   */
  usesAccuracy: boolean
}
