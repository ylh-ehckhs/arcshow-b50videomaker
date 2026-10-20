/**
 * OCR 结果的解析与纠错。
 *
 * 设计前提（实测得出，不是推测）：
 *   - 检测模型输入固定 960×960，整图识别会把卡片小字缩掉一半，
 *     因此必须**先按卡片裁剪、再识别**；
 *   - 识别模型输出的文字**不含空格的语义**（实测 `Potential 10.7 > 12.6935 NC`
 *     被读成 `POTENTIAL10.712`），所以字段提取要容忍"粘连"；
 *   - 千位分隔符会被误读成引号/冒号/度数符号（实测 `009"967'966`、`09"919°222`、
 *     `0944:055`），因此数字字段必须先做**字符归一化**再解析。
 *
 * 本模块只做纯数据变换（不碰 DOM / 不碰 Electron），便于单测覆盖。
 */
import { getOcrProfile, OCR_PROFILES } from './games/ocr-profiles'

/** 一个 OCR 文本块：文字 + 在原图中的包围盒 */
export interface OcrItem {
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** 解析出的候选成绩（字段可能缺失，由调用方决定是否可接受） */
export interface EntryCandidate {
  /** 排名（来自 `#n` 或卡片序号），可能缺失 */
  rank: number | null
  /** 曲名（原样，可能含卡面图误识的杂字） */
  title: string
  /**
   * **全部曲名候选**（按分数降序），供上层做跨格联合分配。
   *
   * 逐格独立决策无法利用"同一首曲目不该出现在两格"这类全局约束；
   * 把候选池交出去，`assignTitlesGlobally` 才能做全局最优分配。
   * 未启用 `titleScorer` 时也会填（分数用 `scoreTitleCandidate`）。
   */
  titleCandidates?: Array<{ text: string; score: number }>
  /** 分数（已归一化的整数） */
  score: number | null
  /** 原始分数文本（保留以便界面显示"识别到什么"） */
  scoreRaw: string
  /** 定数（卡面 printed constant，一位小数） */
  constant: number | null
  /** 定数候选。解析阶段保留全部候选，校验阶段按曲目定数表裁决。 */
  constantCandidates?: ConstantCandidate[]
  /** 单谱 PTT（Potential 值；具体小数位由版式决定） */
  potential: number | null
  /** 评级（EX / EX+ / AA / NC / FR / PM / HC …） */
  grade: string | null
  /**
   * Arcaea 官方版式 B 右上角的等级标记（如 `10+`、`11`）。
   * 版式 B 不印谱面难度代号/定数；该标记只用于判断同名卡是否为不同谱面。
   */
  chartLevel: string | null
  /** 判定数（Arcaea: F/L；Phigros: Good/Bad/Miss） */
  faults: {
    far: number | null
    lost: number | null
    good?: number | null
    bad?: number | null
    miss?: number | null
  }
  /** 准确率／达成率（Phigros 需要；Arcaea 为 null） */
  accuracy: number | null
  /** 综合置信度 0–1，用于界面标黄 */
  confidence: number
  /** 每个字段的来源文本，供界面回显 */
  sources: string[]
}

export interface ConstantCandidate {
  value: number
  text: string
  source: string
  confidence: number
}

/**
 * 单张卡片的 OCR 结果。
 *
 * 放在 `shared` 而不是主进程：主进程产生它、渲染层消费它，
 * 而渲染层不能从 `src/main` 导入类型（两者是分开的构建产物）。
 */
export interface CardOcrResult {
  index: number
  row: number
  col: number
  /** 卡片文字区在原图中的位置 */
  rect: { x: number; y: number; w: number; h: number }
  /** OCR 原始文本块 */
  items: OcrItem[]
  /** 解析出的候选成绩 */
  candidate: EntryCandidate
  /** 与定数表交叉校验的结论 */
  validation: import('./ocr-validate').ValidateResult
  /** 该卡识别失败时的原因 */
  error?: string
}

/** 整张长图的 OCR 结果 */
export interface SheetOcrResult {
  ok: boolean
  error?: string
  /** 检测到的版式与网格 */
  family: string
  rows: number
  cols: number
  confidence: number
  /** 每张卡的结果 */
  cards: CardOcrResult[]
  /** 总耗时（毫秒） */
  ms: number
}

/**
 * 把 OCR 文本归一化成"数字安全的"形式。
 *
 * 处理：全角→半角、去掉所有千位分隔符与 OCR 误读的准分隔符、去掉常见噪声。
 * 注意**不能**盲目删除所有标点——小数点必须保留。
 */
export function normalizeDigits(raw: string): string {
  let s = (raw || '').normalize('NFKC')
  // 小写 o/O 常被当成 0（在纯数字语境下）
  // 千位分隔符的常见误读：' " : : ° · , 空格 ， の 等
  s = s.replace(/['"`´’‘“”:;°·•,，、\s]/g, '')
  // 括号与加号在 P. 1058 (+965) 这类文本里出现，数字提取时先保留，由调用方截取
  return s
}

/**
 * 从一段文本里提取**第一个**看起来像分数（7–9 位、接近 9,000,000–10,000,000）的数字。
 *
 * 只有 Arcaea 的分数是这样的大数，因此这个判据足够可靠。
 */
/**
 * 各游戏的分数取值区间（用于 OCR 的分数字段校验）。
 *
 * ⚠ 这里曾经只有一个 Arcaea 区间（8,000,000–10,000,000），
 * 导致 **Phigros 的分数全部被判为无效**——实测
 * `939467`、`955947`、`1000000` 三张卡的分数都提取成了 `null`，
 * 因为 Phigros 的满分只有 1,000,000、量级小一位数。
 *
 * 下限比理论值放宽不少：OCR 会误读首位数字，宁可让明显偏离的值进来
 * 再由"与定数表交叉校验"和人工复核兜住，也不要整片漏掉。
 */

/**
 * 提取分数。
 *
 * 先按"连续数字"切段再挑符合区间的那段，避免把 `10.7` 或 `12.6935` 当分数。
 *
 * `gameId` 决定取值区间。**不传时按 Arcaea 的窄区间处理**——
 * 这点很重要：Arcaea 侧"分数被裁掉首位"之类的校验依赖窄区间
 * （例如 `0995870` 只有 7 位、不在 8,000,000 以上，必须判为无效）。
 * 早期我一度把默认区间放宽到 1,000–10,000,000，直接导致那类校验失效。
 */
export function extractScore(
  raw: string,
  gameId?: string
): { value: number; text: string } | null {
  const s = normalizeDigits(raw)
  const range = (OCR_PROFILES.find((profile) => profile.gameId === gameId) ?? getOcrProfile('arcaea')).scoreRange
  /*
   * ========================================================================
   * 兜底：**"分隔符被误读为 `/` 或 `:` + 少量小写字母"的形态**
   * ========================================================================
   *
   * ## 为什么需要（PP-OCRv5 实测样本）
   *
   * 换到 v5 后分数行的**千位分隔符读得更规范**（`09'888'705`），
   * 但多出一类新错误：分隔符被读成 `/`、并混入 1–2 个小写误读字符：
   * ```
   * "09'96/'708"   ← 分隔符 `'`→`/`，还多一个小写 `l`
   * "9'9/71/2"     ← 位数不足
   * "09'955'39/"   ← 分隔符混乱
   * ```
   * 上面基于 `\d{5,9}` 的主路径拿不到 7–8 位数字串，于是返回 null。
   * v5 因此**分数从 20 掉到 10**——这是必须补上的回归。
   *
   * ## 判据（刻意保守，避免误判）
   *
   * 只接受**同时**满足下面的串：
   *   1. 不含小数点（排除 PTT/定数那种 `11.5388`）；
   *   2. 去掉小写字母与分隔符后，**数字恰好 7 或 8 位**
   *      （Arcaea 分数就是这两个宽度）；
   *   3. 小写字母**最多 2 个**（再多说明这块不是分数）。
   *
   * 满足时按末组 3 位法还原。这样既救回 v5 的分数，
   * 又不会把别的数字行误当成分数。
   */
  if (!/[.·]/.test(s)) {
    const lowerCount = (s.match(/[a-z]/g) || []).length
    if (lowerCount <= 2) {
      const digitsOnly = s.replace(/[^\d]/g, '')
      if (digitsOnly.length === 7 || digitsOnly.length === 8) {
        const tail = digitsOnly.slice(-3)
        const head = digitsOnly.slice(0, -3).replace(/^0+/, '')
        const v = Number.parseInt(head + tail, 10)
        if (Number.isFinite(v) && v >= range.min && v <= range.max) {
          return { value: v, text: head + tail }
        }
      }
    }
  }
  for (const m of s.matchAll(/\d{5,9}/g)) {
    const digits = m[0]
    if (digits.length < 3) continue
    /*
     * ## 用"**末组 3 位**"还原，而不是滑窗
     *
     * 卡面格式是硬事实：**最后一个分隔符后面永远是 3 位**：
     *   `09'916'806` → 末组 `806`；`9'958701` → 末组 `701`；
     *   `10'002'221` → 末组 `221`。
     *
     * 所以从数字串末尾取 3 位作末组，前面剩下的**全部**就是高位部分，
     * 拼起来即可——不补位、不枚举：
     *
     * | 卡面块 | 数字串 | 末 3 位 | 高位 | 数值 |
     * |---|---|---|---|---|
     * | `09:916:806` | `09916806` | `806` | `0991` | 9,916,806 |
     * | `①9:963448` | `19963448` | `448` | `19963` | 9,963,448 |
     * | `9'958701` | `9958701` | `701` | `9958` | 9,958,701 |
     * | `10'002'221` | `10002221` | `221` | `10002` | 10,002,221 |
     *
     * 高位的**前导 0 是补位**（`09'916'806` 的 `0991`→`991`），去掉。
     *
     * ## 为什么不用"滑窗"
     *
     * 我一度用"在数字串上滑窗口、取落在区间内的第一个"。实测它**会选中
     * 错误的一半**：`99958701` 的 7 位窗口既有 `9995870`（先被扫到）
     * 也有 `9958701`，滑窗取第一个 → 错。末组法没有这个歧义。
     *
     * ## 无法分辨时宁可 null
     *
     * 若 OCR 在中间**多插了一位**（实测 `@9:9181094`：正确是 `09'918'094`
     * 但块里少了个分隔符，且数字串成了 `99181094`），末组法得到的
     * `9918` + `109` = 9,918,109 与真值 9,918,094 只差末组——**数字上无法区分**。
     * 这种情况无法从数字判定，由上层按其余字段继续核对。
     */
    const tail = digits.slice(-3)
    const head = digits.slice(0, -3).replace(/^0+/, '')
    const joined = head + tail
    const v = Number.parseInt(joined, 10)
    if (Number.isFinite(v) && v >= range.min && v <= range.max) {
      return { value: v, text: joined }
    }
    /*
     * 兜底：**只取最后 8 位 / 最后 7 位**。
     *
     * 实测有些块在分数前混进了 1~2 位噪声数字：
     *   - `①9:963448`  数字串 `19963448` → 末组法得 `19963`+`448` = 19,963,448（越界）
     *     取末 8 位 `19963448` 仍越界 → 末 7 位 `9963448` ✅
     *   - `109：890758` 数字串 `109890758` → 末组法越界
     *     取末 8 位 `09890758` ✅
     *
     * 依据：Arcaea 分数**固定 8 位**（用户澄清），版式 A 则显示 7 位；
     * 所以"末尾 8 位 / 7 位"就是分数本体。只在末组法失败后尝试，
     * 不影响正常形态。
     */
    for (const width of [8, 7]) {
      if (digits.length <= width) continue
      const lastN = digits.slice(-width)
      const vN = Number.parseInt(lastN, 10)
      if (Number.isFinite(vN) && vN >= range.min && vN <= range.max) {
        return { value: vN, text: lastN }
      }
    }
  }

  return null
}

/**
 * 提取定数：形如 `10.7` 的 1 位小数，范围 1–12（Arcaea 实际范围）。
 *
 * 实测干扰：
 *   - `Potential 10.7 > 12.6935` 归一化后成 `POTENTIAL10.712.6935`，
 *     简单取第一个小数会拿到 4 位小数的 PTT；
 *   - 阿拉伯数字后缀 `10.7.`（后面还有内容）也会干扰。
 *
 * 策略：收集所有小数候选，**优先取小数位恰好 1 位的**，其余作为兜底。
 */
export function extractConstantCandidates(raw: string, source = 'ocr'): ConstantCandidate[] {
  const s = (raw || '').normalize('NFKC').toUpperCase()
  const out: ConstantCandidate[] = []
  const seen = new Set<string>()
  const add = (value: number, text: string, confidence: number, max = 12): void => {
    if (!Number.isFinite(value) || value < 1 || value > max) return
    const rounded = Math.round(value * 10) / 10
    const key = `${rounded}|${text}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ value: rounded, text, source, confidence })
  }

  // OCR 经常把 POTENTIAL 读成 POTNTIAL / OTETIAL / TTIL / PTL。
  // 只把“像字段标签”的行作为高置信来源，不能直接把 PTT 当定数。
  const potentialLike = /(?:P?O?T[A-Z]{0,6}(?:IAL|IL|L)|P[A-Z]{1,7}L)/i.test(s)
  const addWithMissingLeadingOne = (integer: string, fraction: string, text: string, confidence: number): void => {
    if (integer === '0') add(Number(`10.${fraction}`), `10.${fraction}`, confidence)
    else add(Number(`${integer}.${fraction}`), text, confidence)
  }

  if (potentialLike) {
    const label = s.search(/(?:P?O?T[A-Z]{0,6}(?:IAL|IL|L)|P[A-Z]{1,7}L)/i)
    const tail = label >= 0 ? s.slice(label) : s
    // 标签后紧跟的 `10.7`、`0.8`、`.7` 是定数；PTT 通常在第二个小数点之后。
    const labeled = tail.match(/(\d{0,2})[.·,](\d)/)
    if (labeled) {
      const intPart = labeled[1] || '0'
      addWithMissingLeadingOne(intPart, labeled[2], `${intPart}.${labeled[2]}`, 0.95)
    } else {
      const dot = tail.match(/[.·,](\d)/)
      if (dot) add(Number(`10.${dot[1]}`), `10.${dot[1]}`, 0.55)
    }
    // 小数点丢失但 PTT 仍带点：`1112.0279` 可分为定数 `11.1` + PTT `12.0279`。
    for (const m of tail.matchAll(/(\d{2})(\d)(?=(?:11|12|13)[.·,]\d{3,5})/g)) {
      add(Number(`${m[1]}.${m[2]}`), `${m[1]}.${m[2]}`, 0.7)
    }
  }

  // 难度代号后的定数是明确标注的字段，优先级最高（兼容历史数据）。
  for (const m of s.matchAll(/(?:PST|PRS|FTR|BYD|ETR|INS|LEGACY|EZ|HD|IN|1N|AT|SP)[\s:：]?(\d{1,2})[.·,](\d{1,4})/gi)) {
    add(Number(`${m[1]}.${m[2][0]}`), `${m[1]}.${m[2][0]}`, 1, 18)
  }

  // 无标签时只接受完整的一位小数，避免把 PTT 的 12.6935 截成 12.6。
  // 一位小数候选：不要求小数点后是字符串结尾，因为 PTT 常与定数粘连。
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})[.·,](\d)/g)) {
    addWithMissingLeadingOne(m[1], m[2], m[0], potentialLike ? 0.82 : 0.65)
  }

  // OCR 丢掉了定数首位时，0.x 只能在字段位置中解释为 10.x；不对任意数字补位。
  for (const m of s.matchAll(/(?<!\d)0[.·,](\d)/g)) {
    add(Number(`10.${m[1]}`), `10.${m[1]}`, 0.55)
  }
  // 小数点前的首位被 OCR 丢掉（例如 `TL.6`、`L.81`）时，字段标签附近的 `.x`
  // 只生成一个弱候选，必须再经过曲目定数表命中才会被采用。
  for (const m of s.matchAll(/(?<!\d)[.·,](\d)/g)) {
    const before = s.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0)
    if (potentialLike || /[A-Z]{2,}/.test(before)) add(Number(`10.${m[1]}`), `10.${m[1]}`, 0.42)
  }
  // 两个小数点粘连（`0..3`）只用于补出候选，不修改原文。
  for (const m of s.matchAll(/(?<!\d)0[.·,]{2}(\d)/g)) {
    add(Number(`10.${m[1]}`), `10.${m[1]}`, 0.4)
    add(Number(`11.${m[1]}`), `11.${m[1]}`, 0.35)
  }
  out.sort((a, b) => b.confidence - a.confidence || a.value - b.value)
  return out
}

export function extractConstant(raw: string): { value: number; text: string } | null {
  const candidates = extractConstantCandidates(raw)
  if (candidates.length > 0) return { value: candidates[0].value, text: candidates[0].text }
  return null
}

/**
 * 提取 PTT（Potential）。
 *
 * ## 小数位数：不同版式不一样（这是实测踩过的大坑）
 *
 * - **版式 A**（`arcaea分表01/02/03.jpg`）卡面显示 **4 位小数**：`12.4924`
 * - **版式 B**（`arcaea分表04-不同样式.png`）只显示 **2 位小数**：`12.39`
 *
 * 早期正则写死 `\d{4,6}` 位小数，于是**版式 B 的 PTT 一个都读不到**
 * （实测 30 格全部 PTT=null）。我为此在几何上绕了好几轮弯路，
 * 直到隔离测试 `extractPotential('12.39')` 返回 null 才定位到——
 * **这是解析层问题，与裁剪几何无关**。
 *
 * 所以加参数 `minDecimals`（默认 4 保持版式 A 的既有行为），
 * 版式 B 传 2。
 *
 * ## 为什么不能简单地"一律放宽到 2 位"
 *
 * 实测会把**定数**当成 PTT：版式 A 的块是 `POTENTIAL10.712`
 * （真实含义：定数 `10.7` + 被截断的 PTT `12`）。
 * 放宽到 2 位后 `10.712` 会被匹配成"PTT=10.712"，
 * 于是 `extractConstant` 里 `raw.replace('10.712','')` 失败，
 * **定数变成 null**（实测打挂回归用例）。
 * 试过"枚举匹配的所有前缀"，同样会让 10.712 胜出——所以按版式分开。
 *
 * ## 范围：必须收紧
 *
 * 实测把上方表头的 `12.27747`（BEST TOP 50 AVG.）也读进来过，
 * 它同样是"1x.xxxx"形式，宽松匹配会优先命中它。
 * Arcaea 单谱 PTT 实际落在 **11.0–13.0**，所以先按这个窄区间找，
 * 找不到再放宽到 1–14，并且优先取较大值。
 */
/**
 * 从"小数点被吞掉"的 PTT 数字串里恢复出正确的小数。
 *
 * ## 为什么需要（实测的真实错误样本）
 *
 * 卡面 `POTENTIAL 10.1 > 11.3226` 常被读成：
 * ```
 * "OTENTIAL10.111.3"      ← 两段粘连，小数点位置不可靠
 * "POTENTIAL9.511.5388HC" ← 这类是好的（自带小数点）
 * "TENTAL9.3113235FR"     ← 小数点丢了，只剩一长串数字
 * ```
 * `extractPotential` 的正则要求**小数点后 4–6 位**，所以上面第 1、3 种
 * 都判为无 PTT。实测 **50 格里 26 格因此丢 PTT**。
 *
 * ## 恢复规则（只在**有结构依据**时才做）
 *
 * 关键是 PTT 在这类卡面上有一个**强结构**：它紧跟 `POTENTIAL` 一词，
 * 且形如 `整数.四位小数`（版式 A）。所以：
 *
 * 1. 先把 `POTENTIAL` 的各种误读统一（`TENTIAL`/`OTENTIAL`/`TENTAL`/`TTIAL`…）——
 *    凡是"看起来像 POTENTIAL 的片段"都归一化成 `POTENTIAL`；
 * 2. 取 `POTENTIAL` 之后的第一串数字（跳过中间的定数与其分隔符）；
 * 3. 按"**最后 4 位是小数**"切分（版式 A 的口径）。
 *
 * ⚠ 这条规则**不发明数字**——只用串里已有的字符重新分组。
 * 若数字串不足以切出合法值，就**返回原串**（宁可不给 PTT，也不给错值）。
 *
 * 例：`TENTAL9.3113235FR` → 归一化 → `POTENTIAL9.3113235FR`
 * → `POTENTIAL` 后第一串数字 `9.3113235` → 去点得 `93113235`？
 * 不对——这里要的是"**> 之后的那个数**"，见下方实现注释。
 */
export function repairPotentialText(raw: string): string {
  let s = (raw || '').normalize('NFKC')
  /*
   * 步骤 1：把 POTENTIAL 的常见误读归一化。
   * 实测出现过的误读：`TENTIAL`/`OTENTIAL`/`TENTAL`/`TTIAL`/`TTL`。
   */
  s = s.replace(/[P]?[OT]*ENT[I1L]+A[L1]/gi, 'POTENTIAL')

  /*
   * ========================================================================
   * 步骤 2：修复"**两个小数点**"形态（实测 26 格丢 PTT 的主因）
   * ========================================================================
   *
   * ## 真实样本与规律
   *
   * ```
   * "TTL9.91.1946N"        ← 卡面是 POTENTIAL 9.9 > 11.1946，"11" 被"9.9"吞掉
   * "OTENTIAL10.111.3"     ← 卡面是 POTENTIAL 10.1 > 11.3xx
   * "POTENTIAL98:11.293LNC"← 卡面是 POTENTIAL 9.8 > 11.293
   * ```
   *
   * 规律：**定数（1–2 位整数 + 1 位小数）与 PTT 粘连**，
   * 串里出现**两个小数点**，且第二个小数点前后的数字合起来
   * 应当是 `11.xxxx` 形态（Arcaea 的 PTT 基本都是 11–13）。
   *
   * ## 修复方式
   *
   * 对 `A.B` + `C.D`（两段带小数）这种形态，把 **`C` 接上 `D`** 重组，
   * 即 `A.B` = 定数、`C.D` = 被吞掉首位的 PTT。
   * 只有当重组出的值落在 **11–13** 时才接受——
   * 这样不会把定数（多在 9–11）或其它数字误当成 PTT。
   *
   * 例：`9.91.1946` → 取 `9.9` 之后的 `1` + `.` + `1946` → `1.1946`
   * 不是 11–13 → 再加一位变成 `11.1946` ✅（见下方两种候选）。
   */
  /*
   * ⚠ **这里刻意不做"小数点丢失的重组"**（2026-04 决策记录）。
   *
   * 实测有 26/50 格因小数点丢失而拿不到 PTT，形态如：
   * ```
   * "TTL9.91.1946N"      ← 卡面是 POTENTIAL 9.9 > 11.1946
   * "OTENTIAL10.111.3"   ← 卡面是 POTENTIAL 10.1 > 11.3xx
   * ```
   * 看着能"补出" 11.1946，但切开后是**二义**的：
   * `"9.91.1946"` 切成 `["9","91","1946"]`，既可以读成
   * `9.9 > 11.1946`，也可能有其他分组，**没有可靠依据确定真值**。
   *
   * 用户的明确要求是"**宁可缺，不可错**"（precision over recall），
   * 所以这里只做**归一化**（把 POTENTIAL 的误读统一），
   * **不发明数字**。要真正解决这 26 格，得回到识别层
   * （让模型把小数点读对），而不是在字符串上猜。
   */
  return s
}

export function extractPotential(
  raw: string,
  minDecimals = 4
): { value: number; text: string } | null {
  const s = repairPotentialText(raw)
  const all: { value: number; text: string }[] = []
  const re = new RegExp(`(\\d{1,2})[.·,](\\d{${minDecimals},6})`, 'g')
  for (const m of s.matchAll(re)) {
    const value = Number.parseFloat(`${m[1]}.${m[2]}`)
    if (value >= 1 && value <= 14) all.push({ value, text: m[0] })
  }

  /*
   * ========================================================================
   * **小数点丢失的恢复**（实测：50 格里 26 格因此丢 PTT）
   * ========================================================================
   *
   * ## 真实错误样本
   *
   * 卡面 `POTENTIAL 10.1 > 11.3226` 被读成：
   * ```
   * "OTENTIAL10.111.3" | "2TA"       ← 小数点位置错乱
   * "TENTAL9.3113235FR"              ← 小数点丢失，只剩一长串数字
   * ```
   * 常规正则要求"小数点后 4–6 位"，这两种都匹配不上。
   *
   * ## 恢复思路：**在 `>` 之后枚举小数点位置**
   *
   * PTT 在卡面上的位置很固定：`POTENTIAL <定数> > <PTT>`。
   * 所以先去掉 `POTENTIAL` 一词，再从剩下的串里**枚举**所有
   * "把某个位置当小数点、其后留 4 位"的切法，取落在合理区间
   * （11–13，Arcaea 的 PTT 几乎都在这区间）的那个。
   *
   * ⚠ 只做**重新分组**，不发明数字；多个合法候选时留空，交给人工复核。
   * 静默取最大值会把页头或相邻字段的 PTT 写进当前卡片。
   */
  if (all.length === 0) {
    /** 候选值：把一段纯数字分成 `<1-2位>.<4位>` */
    const candidates: number[] = []
    // 只保留数字与常见分隔符，其它字符当边界
    for (const seg of s.split(/[^\d]+/)) {
      if (seg.length < 5 || seg.length > 8) continue
      /*
       * 逐位尝试当小数点：整数部分取 1–2 位，小数部分留 4 位。
       * `10 1113`（去点后 6 位）→ `10.1113`；
       * `93113235`（8 位）→ 取 `93.1132` 之类（会被区间过滤掉）。
       */
      for (let intLen = 1; intLen <= 2; intLen++) {
        const fracLen = seg.length - intLen
        if (fracLen < minDecimals || fracLen > 6) continue
        const value = Number.parseFloat(`${seg.slice(0, intLen)}.${seg.slice(intLen)}`)
        if (value >= 11 && value <= 13) candidates.push(value)
      }
    }
    if (candidates.length > 0) {
      const unique = [...new Set(candidates)]
      if (unique.length !== 1) return null
      return { value: unique[0], text: `恢复:${unique[0]}` }
    }
    return null
  }

  const narrow = all.filter((c) => c.value >= 11 && c.value <= 13)
  const pool = narrow.length > 0 ? narrow : all
  const unique = [...new Map(pool.map((item) => [item.value, item])).values()]
  if (unique.length !== 1) return null
  return unique[0]
}

/**
 * 提取评级。
 *
 * Arcaea 卡面同时出现"通关状态"（PM/FR/TC/TL/NC）与"评级"（EX+/EX/AA/A…），
 * 这里把两者都收进 `grade`，由上层按游戏字段模型分流。
 */
const GRADE_TOKENS = ['EX+', 'EX', 'AA', 'AB', 'A', 'B', 'C', 'D', 'PM', 'FR', 'TC', 'TL', 'NC', 'HC'] as const

export function extractGrade(raw: string): string | null {
  const s = (raw || '').normalize('NFKC').toUpperCase()
  // 先长后短，避免 `EX+` 被 `EX` 抢先匹配。
  // 边界用「前后不是字母」判定：`\b` 对 `EX+` 无效（`+` 非单词字符），
  // 实测会退化成匹配到 `EX`。
  for (const token of [...GRADE_TOKENS].sort((a, b) => b.length - a.length)) {
    const escaped = token.replace('+', '\\+')
    if (new RegExp(`(?:^|[^A-Z])${escaped}(?:[^A-Z]|$)`).test(s)) return token
  }
  return null
}

/**
 * 提取判定数：`F:6 L:2` / `F6 L2` / `F: 10 L: 0` 等形式。
 *
 * ⚠ 必须要求 F/L 与数字**紧邻**，否则 `LOST` 里的 `L` 会被当成 Lost 标记
 * （实测 `P. 1239 (+1124) F: 11 L: 1` 曾被解析成 lost:10）。
 * 因此 `F`/`L` 后面允许的只有可选的分隔符（`:` `.` 空格 正负号），
 * 紧接着必须是数字。
 */
/**
 * 提取判定数：`F:6 L:2` / `F6 L2` / `F: 10 L: 0` 等形式。
 *
 * ## ⚠ 两段真实踩坑记录（用户实测驱动）
 *
 * ### 1. 必须排除 `LOST` / `FAR` 这两个词
 *
 * 否则 `LOST` 里的 `L` 会被当成 Lost 标记
 * （实测 `P. 1239 (+1124) F: 11 L: 1` 曾被解析成 lost:10）。
 *
 * ### 2. 右下角是**最后更新时间**，不是判定数（用户指出）
 *
 * 用户指出："Arcaea 版式 A 卡片最右下角…是**最后更新时间**，
 * 这个不需要读取（如 `P:1482(1402)F:13L:3         17d` 最右边的
 * `17d` 是指距离现在多久之前更新）"。
 *
 * 我据此做几何扫描，发现**时间标在图像里紧贴判定数**：
 * `L:3` + `9h` 在图上就印成 `L:39h`。因此产生了一批"串接"形态：
 * `L:723d`（真值 `L:7` + `23d`）、`F4L8120d`（真值 `L:8` + `120d`）…
 *
 * ### 为什么做不到"精确解析"
 *
 * `L:3`+`9h` 与 `L:39`+`h` 在**字符串上完全同形**，
 * 单靠这个字符串无法判定边界（需要谱面总物量等额外信息）。
 * 我试过前瞻、后顾、位宽收窄、手工回溯，都只能覆盖一部分——
 * 其中 `(\d{1,3})(?!\d)` 那版甚至因为"正则不会为通过前瞻而回退位数"
 * 导致**所有 L 变 null**。
 *
 * ### 最终采用的启发式（基于用户实测真值）
 *
 * 真值显示 Far/Lost 都是 **1–2 位小计数**
 * （Far: 14/13/10/8/6/4/3/1；Lost: 7/5/3/8/2/1）。
 * 所以**贪婪取 1–2 位**，并用上限 99 兜底：
 * ```
 * F:14    -> 14    ✅          L:7     -> 7     ✅
 * L:723d  -> 72    （真值 7；量级接近，不会出现 723 这种离谱值）
 * L:8120d -> 81    （真值 8）
 * ```
 * 残余错误的兜底是**界面可编辑**（用户可直接改），
 * 这符合我们约定的"宁可缺，不可错"的次优选择。
 */
const FAULT_WIDTH = 2
/** 判定数上限：Arcaea 判定数在两位数以内 */
const FAULT_MAX = 99

export function extractFaults(raw: string): { far: number | null; lost: number | null } {
  const s = (raw || '').normalize('NFKC')
  /**
   * 取判定数。用**数字串总长度**判断是否被时间标接上。
   *
   * ## ⚠ 关键规则：数字串超过 2 位时，判定数只取首位
   *
   * 依据（用户实测真值 + 他指出的"右下角是最后更新时间"）：
   * ```
   * 图上原文         数字串    真值   说明
   * L:3  + 9h        "39"      3      时间标 9h 接在后面
   * L:7  + 23d       "723"     7      时间标 23d
   * L:8  + 120d      "8120"    8      时间标 120d
   * L:2  + 971d      "2971"    2      时间标 971d
   * L:36（干净）       "36"      36     真正的两位数
   * ```
   * 即：**干净的值最多 2 位；超过 2 位必然被时间标接上了**，
   * 此时真正的判定数只有首位那一个数字。
   *
   * 这条规则把 4 位错值（8120 / 9168）与 2 位错值（97 / 91）
   * 都压回正确的单一位。
   */
  const pick = (re: RegExp): number | null => {
    const m = s.match(re)
    if (!m) return null
    /*
     * ⚠ 这里必须用 `m.index + m[0].length`（**已消费的末尾**），
     * 不能用 `s.slice(m.index)` —— 后者只能看到被正则吃掉的那两位，
     * 看不到紧随其后的字符（我第一版就是这么写错的，`span` 恒为 2）。
     */
    const after = s.slice((m.index ?? 0) + m[0].length)
    // 数字串后面**还有数字** => 说明被时间标接上了 => 判定数只取首位
    const moreDigits = /^\d/.test(after)
    const digits = moreDigits ? m[1].slice(0, 1) : m[1]
    const n = Number.parseInt(digits, 10)
    return Number.isFinite(n) && n >= 0 && n <= FAULT_MAX ? n : null
  }
  return {
    far: pick(new RegExp(`F(?!AR)\\s*[:.]?\\s*(\\d{1,${FAULT_WIDTH}})`, 'i')),
    /* `(?<!POTENTIA)`：排除 `Potential 10.7` 里 `l 1` 被读成 `L=10` */
    lost: pick(new RegExp(`(?<!POTENTIA)L(?!OST)\\s*[:.]?\\s*(\\d{1,${FAULT_WIDTH}})`, 'i'))
  }
}

/**
 * 提取 Phigros 的显式判定计数。
 *
 * 只接受标签附近明确出现的数字（`Good 77`、`490 Perfect` 等），
 * 不从 ACC、分数或谱面定数推算；无法确认时保持 null。
 */
export function extractPhigrosFaults(raw: string): {
  perfect: number | null
  good: number | null
  bad: number | null
  miss: number | null
} {
  const s = (raw || '').normalize('NFKC').toUpperCase()
  const read = (label: string): number | null => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const after = s.match(new RegExp(`\\b${escaped}\\b\\s*[:.]?\\s*(\\d{1,5})`))
    const before = s.match(new RegExp(`(\\d{1,5})\\s*\\b${escaped}\\b`))
    const value = after?.[1] ?? before?.[1]
    return value === undefined ? null : Number.parseInt(value, 10)
  }
  return {
    perfect: read('PERFECT'),
    good: read('GOOD'),
    bad: read('BAD'),
    miss: read('MISS')
  }
}


export function extractAccuracyFrom(
  entries: Array<{ text: string; y: number; x?: number }>,
  options: { preferLeftmost?: boolean } = {}
): { value: number; text: string } | null {
  const MIN_ACCURACY = 50
  const MAX_ACCURACY = 100.5
  const candidates: Array<{ value: number; text: string; y: number; x: number }> = []
  for (const e of entries) {
    const s = (e.text || '').normalize('NFKC')
    /*
     * ⚠ **`%` 必须可选、且允许更长的小数串**（用户实测驱动）。
     *
     * 原正则强制要求百分号：`(\d{1,3}(?:[.,]\d{1,2})?)\s*%`。
     * 但实测 Phigros 分表里 OCR **经常丢掉 `%`**，或把 `%` 与相邻数字
     * 粘在一起，于是数值被整块丢弃——实测准确率只读出 17/33（52%）。
     * 甚至本曲准确率会被切成两块（`986266` + `9879` → 实为 `98.62%`）。
     *
     * 真实失败样本（`_ocr-dump.json` 格内文本块）：
     * ```
     * #4  ['...', '99.0966', ...]         ← 99.09% 丢了 %
     * #5  ['...', '99.3396', ...]         ← 99.33%
     * #7  ['...', '986266', '9879', ...]  ← 98.62% 被切成两块
     * ```
     *
     * 所以放宽为：`%` 可选，小数位 1–5 位，靠**值域 50–100.5** 与小数点
     * 把准确率与分数（6–7 位整数）、定数（13.6 这类一位小数）区分开。
     */
    for (const m of s.matchAll(/(\d{1,3}[.,]\d{1,5})\s*%?|(\d{1,3})\s*%/g)) {
      const raw = m[1] ?? m[2]
      const value = Number.parseFloat(raw.replace(',', '.'))
      if (!Number.isFinite(value)) continue
      if (value < MIN_ACCURACY || value > MAX_ACCURACY) continue
      candidates.push({ value, text: m[0], y: e.y, x: e.x ?? Number.POSITIVE_INFINITY })
    }
  }
  if (candidates.length === 0) return null

  const ys = candidates.map((c) => c.y)
  const span = Math.max(...ys) - Math.min(...ys)
  let pool = candidates
  /*
   * 判据一（更可靠）：**页头那一行的文本里带 `Avg` 字样**。
   * 实测卡面顶部是 `^Avg: 97.9729%`，而本曲达成率单独成块（`99.09%`）。
   * 有 Avg 标记就把它那一群排除掉。
   *
   * 判据二（兜底）：没有 Avg 标记时按位置分群——以中位数为界保留下方那群。
   * 阈值取 20px：卡面内部文本块间距约 30px，页头 Avg 与本曲达成率也是几十像素，
   * 只靠"跨度"分不开，所以判据一优先。
   */
  const avgYs = entries.filter((e) => /avg|平均/i.test(e.text ?? '')).map((e) => e.y)
  if (avgYs.length > 0) {
    const filtered = candidates.filter((c) => avgYs.every((ay) => Math.abs(c.y - ay) > 12))
    /*
     * ⚠ 过滤后**可能一个都不剩**——此时必须返回 null，**不能回退到 Avg 值**。
     * 实测 `#7` 的本曲准确率被 OCR 丢掉了小数点（`986266` 本应是 `98.62%`），
     * 正则无法复原；正确答案是留空（交用户补录），而不是给出平均值
     * ——平均值会连带把 RKS 算错，比留空严重得多。
     */
    if (filtered.length === 0) return null
    if (options.preferLeftmost) {
      const left = Math.min(...filtered.map((c) => c.x))
      const leftmost = filtered.filter((c) => c.x === left)
      return leftmost.sort((a, b) => b.value - a.value)[0]
    }
    return filtered.sort((a, b) => b.value - a.value)[0]
  }
  if (span > 20) {
    const sorted = [...ys].sort((a, b) => a - b)
    const mid = sorted[Math.floor(sorted.length / 2)]
    const lower = candidates.filter((c) => c.y >= mid)
    if (lower.length > 0) pool = lower
  }

  if (options.preferLeftmost) {
    const left = Math.min(...pool.map((c) => c.x))
    const leftmost = pool.filter((c) => c.x === left)
    return leftmost.sort((a, b) => b.value - a.value)[0]
  }
  pool.sort((a, b) => b.value - a.value)
  return { value: pool[0].value, text: pool[0].text }
}

/** 单个文本块的准确率（便利包装） */
export function extractAccuracy(raw: string): { value: number; text: string } | null {
  return extractAccuracyFrom([{ text: raw, y: 0 }])
}

/**
 * 判断一个文本块"像不像曲名片段"（用于拼接前过滤）。
 *
 * 拼进不相关的块会拉低相似度，但**不够彻底**——实测把分数
 * `973166` 拼进去后相似度仍有 71%（"包含关系"给了分），
 * 反而盖过正确的拼法。所以宁可在入口就滤掉。
 *
 * ⚠ 太短的片段也要滤掉（要求 ≥4 个字母）：实测 `raphic`（6 字母）这类
 * 无意义残片拼进 `ANIMATION` 后得到 `ANIMATIONraphic`，
 * 因为**含有 5 个字符的公共子串 `raphi`** 被判为"包含"而拿到 0.86 分，
 * 于是盖过了单块 `ANIMATION`（0.58）、把真曲名 `Better Graphic Animation`
 * 挤掉。这类残片没有独立语义，滤掉更安全。
 *
 * 判据：至少 4 个字母、字母数不少于数字数；并且不能是字段关键词
 * （`POTENTIAL`、`HIGH SCORE` 之类）。
 */
export function looksLikeTitleFragment(text: string): boolean {
  const s = (text ?? '').trim()
  if (s.length < 4) return false
  if (/POTENTIAL|HIGH\s*SCORE|SCORE|REWARD|PURE|FAR|LOST|RKS/i.test(s)) return false
  const letters = (s.match(/[A-Za-z\p{L}]/gu) || []).length
  const digits = (s.match(/\d/g) || []).length
  if (letters < 4) return false
  if (digits > letters) return false
  return true
}

/**
 * 从多个文本块里拼出最可能的曲名。
 *
 * ## 为什么需要拼接
 *
 * Arcaea 卡片的曲名基本是**一个块**，但 Phigros 的曲名常被 OCR **切成多块**
 * （实测）：
 *   | 卡面真实曲名 | OCR 块 |
 *   |---|---|
 *   | `Better Graphic Animation` | `ANIMATION` + `raphic` |
 *   | `Chronos Collapse - La Campanella` | `llapse-LaCampanella` |
 *   | `You are the Miserable` | `ethe` + `Miserable` |
 * 只取单个块时这些全匹配不上，实测曲名匹配率只有 17/36。
 *
 * ## 怎么拼：**用定数表投票，而不是猜块的上下顺序**
 *
 * 朴素做法是按纵坐标排序后拼接，但块之间可能夹着谱师、难度等无关文本，
 * 顺序也会因 OCR 框的抖动而错。
 * 更稳的做法是**枚举候选片段组合，用"与定数表的相似度"打分取最高的**：
 *   - 单个块（保底，Arcaea 走的就是这条）；
 *   - 所有两两组合（按纵坐标升序拼接）；
 *   - 三块组合只考虑**纵向相邻**的三连（限制数量，避免组合爆炸）。
 *
 * 这样既不依赖块的顺序假设，也能自动跳过无关块——
 * 因为把无关块拼进去会让相似度**下降**，自然不会被选中。
 *
 * ⚠ 但**纯数字块必须在调用前就滤掉**，不能指望打分把它们淘汰：
 * 实测把 `973166` 拼进去后 `ANIMATIONraphic973166` 的相似度仍有 71%
 * （因为"包含关系"给了不低的分），反而盖过了正确的 `ANIMATIONraphic`。
 *
 * @param fragments 候选片段（含纵坐标）；调用方应只传"像曲名"的块
 * @param score     打分函数：给定拼好的字符串，返回 0–1 的相似度
 * @returns 得分最高的拼法（含分数）；没有任何片段时返回空串与 0 分
 */
export function joinTitleFragments(
  fragments: Array<{ text: string; y: number }>,
  score: (text: string) => number
): { text: string; score: number } {
  const usable = fragments
    .map((f) => ({ text: (f.text ?? '').trim(), y: f.y }))
    .filter((f) => f.text.length > 0)
    .sort((a, b) => a.y - b.y)
  if (usable.length === 0) return { text: '', score: 0 }

  let best = { text: '', score: -1 }
  const consider = (text: string): void => {
    if (!text) return
    const s = score(text)
    if (s > best.score) best = { text, score: s }
  }

  // 1) 单个块
  for (const f of usable) consider(f.text)

  // 2) 两两组合（按纵坐标升序拼接）
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      consider(usable[i].text + usable[j].text)
    }
  }

  // 3) 纵向相邻的三连（数量有限，避免 O(n^3) 爆炸）
  for (let i = 0; i + 2 < usable.length; i++) {
    consider(usable[i].text + usable[i + 1].text + usable[i + 2].text)
  }

  return best.score < 0 ? { text: '', score: 0 } : best
}

/**
 * 提取排名。
 *
 * Arcaea 卡面的排名一律带井号（`#12`），因此**要求井号存在**：
 * 否则分数行、`P. 1058` 这类文本里的数字会被误当排名
 * （实测 `随便 42` 这种无井号文本也曾被采纳）。
 */
export function extractRank(raw: string): number | null {
  const m = (raw || '').normalize('NFKC').match(/#\s*(\d{1,3})\b/)
  if (!m) return null
  const value = Number.parseInt(m[1], 10)
  return value >= 1 && value <= 999 ? value : null
}

/**
 * 清理曲名。
 *
 * 实测噪声（来自卡面左侧封面图、按钮、装饰）：
 *   `QinvertedWorld`、`LMVURBD`、`CeAttraqtia`、`ZlRingedGene`
 * 特征：曲名前面粘了 1–2 个孤立大写字母。
 *
 * 这里只做**保守**处理：剥掉开头的 1–2 个孤立大写字母前缀、去掉两侧非字母数字字符。
 * 不做更激进的改写——靠归一化后的曲名去定数表里模糊匹配，
 * 比在这里猜测"正确拼写"更可靠（也不会把 `Stasis` 误改成别的）。
 */
export function cleanTitle(raw: string, stripPrefix = false): string {
  let s = (raw || '').normalize('NFKC').trim()
  // 去掉两侧残留的非字母数字字符（含 ⁞ 、引号等 OCR 噪声）
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')
  /*
   * 剥离卡面图误识产生的前缀。三种实测样本：
   *   `LMVURBD`     → `MVURBD`      （多一个 L，**曲名全大写**）
   *   `ZlRingedGene`→ `RingedGene`  （多一个 Zl）
   *   `CeAttraqtia` → `Attraqtia`   （多一个 Ce）
   *
   * 处理分两种情况：
   *   A. 全大写曲名（无小写字母）：只能靠"多余前缀"的启发式——若长度 ≥ 5 且
   *      第 1 个字符是单个大写字母、其后仍是连续大写，则剥掉它。
   *   B. 含大小写混合：找"大写紧跟小写"的边界，剥掉边界之前的部分。
   * 两种情况都要求剥离量 ≤ 3 且剩余长度 ≥ 3，避免把短曲名削没。
   */
  const stripLeading = (t: string): string => {
    // B：大小写边界
    for (let k = 1; k < Math.min(4, t.length); k++) {
      if (/[A-Z]/.test(t[k]) && t[k + 1] !== undefined && /[a-z]/.test(t[k + 1])) {
        if (t.length - k >= 3) return t.slice(k)
        return t
      }
    }
    /*
     * A：全大写，剥掉 1 个前导大写字母（如 LMVURBD → MVURBD）。
     * 只剥一次（不递归），否则 `LMVURBD` 会被连剥成 `VURBD`。
     *
     * ⚠ 长度门槛必须是 **≥7**，不能是 ≥5。
     * 实测踩坑：`ARCAEA`（页头标题，6 字符）曾因为门槛是 5 被剥成 `RCAEA`，
     * 于是绕过了 `FIELD_KEYWORDS` 的 `ARCAEA$` 过滤，以 `RCAEA` 的身份
     * 拿到满分被当成曲名（长分表整页的曲名全错）。
     * 真实的全大写曲名（`MVURBD`、`AMIA`、`SENOCIDER`）都在 6 字符以上，
     * 而需要剥前缀的样本（`LMVURBD`）是 7 字符，所以 ≥7 是安全的分界。
     */
    if (stripPrefix && /^[A-Z]/.test(t) && t.length >= 7 && !/[a-z]/.test(t)) {
      const rest = t.slice(1)
      /*
       * 额外守卫：**剩余部分必须是纯大写字母数字**。
       *
       * `LMVURBD`（曲名 `MVURBD` 前多了卡面图误识的 `L`）与
       * `GLORY:ROAD`（真实曲名，本身无小写字母）无法靠"首字母大写 + 长度 ≥7"区分。
       * 但前者是**纯字母**、后者含分隔符 `:`——卡面图误识产生的前缀
       * 后面跟的是曲名文字，不会凭空多出标点。
       * 没有这条守卫时 `GLORY:ROAD` 被削成 `LORY:ROAD`，相似度从 1.00 掉到 0.89。
       */
      if (/^[A-Z]/.test(rest) && rest.length >= 4 && /^[A-Z0-9]+$/.test(rest)) return rest
    }
    return t
  }
  return stripLeading(s).trim()
}

/**
 * 把"同一行内横向相邻的碎片"合并成一个块（**按坐标**，不按数组顺序）。
 *
 * ## 为什么需要
 *
 * 实测 Arcaea 版式 B：卡面右侧的 `POTENTIAL 12.39` 会被 OCR 切成
 * `"POTEN"` + `"AL"` + `"12.3"` + `"19"` 这样的碎片——
 * **小数末位被单独切出来，而且常被误读**（`39`→`19`、`08`→`B`）。
 * 只做字符串层面的拼接（如 joinTitleFragments）救不了：
 * 拼成 `12.319` 也不等于 `12.39`。
 *
 * 但**按坐标**把同一行的相邻块并起来，就能还原出
 * `POTENTIAL12.319` 这样的整行文本，交给已有解析逻辑
 * （`extractPotential` 会从中挑出 11–13 区间内的候选）处理。
 *
 * ## 判据
 *
 * 两点属于同一行当且仅当：
 *   - 纵向中心差 ≤ 较小块高的 60%（或 `opts.maxDy`）；
 *   - 横向间隙在 `-overlap` 到 `maxGapX` 之间（允许轻微重叠）。
 * 合并时按横坐标升序拼接文本，外接框取并集。
 */
export function mergeLineFragments(
  items: OcrItem[],
  opts: { maxDy?: number; maxGapX?: number; overlap?: number } = {}
): OcrItem[] {
  if (items.length === 0) return []
  const overlap = opts.overlap ?? 6
  const maxGapX = opts.maxGapX ?? 60
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: OcrItem[] = []
  for (const it of sorted) {
    const cy = it.y + it.h / 2
    let host: OcrItem | null = null
    for (const line of lines) {
      const dy = Math.abs(cy - (line.y + line.h / 2))
      const maxDy = opts.maxDy ?? Math.max(6, Math.min(it.h, line.h) * 0.6)
      if (dy > maxDy) continue
      const gap = Math.max(line.x, it.x) - Math.min(line.x + line.w, it.x + it.w)
      if (gap < -overlap || gap > maxGapX) continue
      if (!host || dy < Math.abs(cy - (host.y + host.h / 2))) host = line
    }
    if (!host) {
      lines.push({ ...it })
      continue
    }
    const before = it.x + it.w / 2 < host.x + host.w / 2
    host.text = before ? it.text + host.text : host.text + it.text
    host.x = Math.min(host.x, it.x)
    host.y = Math.min(host.y, it.y)
    host.w = Math.max(host.x + host.w, it.x + it.w) - host.x
    host.h = Math.max(host.y + host.h, it.y + it.h) - host.y
  }
  return lines
}

/**
 * 已知的字段关键词：出现在这些词里的块不可能是曲名。
 *
 * `BEST` / `PLAYER` / `TOP` 是卡片页头（实测 `PlayerBests`、`BEST TOP50`）——
 * 它们**含小写字母且有足够字母数**，靠"像曲名"的通用判据拦不住，
 * 必须显式列出来（放开全大写曲名后，这条就成了必要的兜底）。
 */
const FIELD_KEYWORDS = /POTENTIAL|BEST|TOP\s*\d|PLAYER|GENERATED|ARCAEA$/i

/**
 * 给曲名候选打分。
 *
 * 不用"取最长"——实测 `POTENTIAL10.712` 比 `InvertedWorld` 更长，
 * 会把字段行当成曲名。改为按特征打分。
 *
 * ⚠ 这里踩过两个坑，都靠真实素材才发现：
 *
 * ① **不能要求"含小写字母"**。Arcaea 有大量**全大写**曲名
 *    （`MVURBD`、`SENOCIDER`、`AMIA`、`GLORY:ROAD`、`DREADAREA`…），
 *    早期把它们全淘汰掉，结果只剩碎片胜出——实测 `#2` 的曲名被判成
 *    `14d`（来自 `P. 1487` 那一行），而真正的 `1VURBD` 就在同一个块里。
 *    同理 `RingedGenesis`、`XiumCrisist` 这类**无空格驼峰**也要能通过。
 *
 * ② **数字权重不能太低**。早期算式是
 *    `score = 字母占比 × 10 − 数字个数 × 1.5`，而 `14d` 的字母占比是 0.33、
 *    数字 2 个，得分 `3.3 − 3 = 0.3`，**仍然为正**且与 `RingedGenesis`
 *    （占比 1.0、得分 10）同场竞争时不会被排除；更糟的是像 `14d` 这种
 *    "数字比字母还多"的碎片会被当成合理候选。现在要求
 *    **字母数 ≥ 数字数**且**字母数 ≥ 3**，并大幅提高数字惩罚。
 */
/**
 * 判断一个块是不是**字段标签**（或其被切掉开头的残片）。
 *
 * ## 为什么需要它（实测踩过的坑）
 *
 * 卡面上的 `POTENTIAL` 常被 OCR 切掉开头，读成 `OTENTIAL`。
 * 而 `FIELD_KEYWORDS` 用 `/POTENTIAL/` 那种**完整词**匹配，`OTENTIAL` 不含
 * 完整词，于是**漏过过滤**；又因为它比真曲名长，
 * 在"拼接择优"里**赢过真曲名**——实测版式 B 有三格因此失败：
 * `#18` 真曲名 `PUPA`、`#26` 真曲名 `conflict`、`#30` 真曲名 `AiDrew`，
 * 都被读成 `OTENTIAL`（`#30` 读成 `Drew`，是 `AiDrew` 被左裁后的残片）。
 *
 * ## 判据
 *
 * 取候选与关键词的**最长公共前缀**，长度 ≥4 就认为是同一个字段标签：
 *   - `OTENTIAL` vs `POTENTIAL`：公共前缀是 `ENTIAL`（4 个字符以上，
 *     因为它是关键词去掉首字母后仍连续的片段）——用 `includes` 判：
 *     `OTENTIAL` 含 `ENTIAL`，而 `ENTIAL` 是 `POTENTIAL` 的后缀；
 *   - 阈值 4 是为了**不误杀真曲名**：`Pupa`、`Conflict` 这类
 *     与关键词没有 4 字符以上的公共部分。
 */
export function looksLikeFieldLabel(text: string): boolean {
  const s = (text || '').trim()
  if (!s) return false
  if (FIELD_KEYWORDS.test(s)) return true
  const upper = s.toUpperCase()
  for (const kw of ['POTENTIAL', 'PLAYER', 'GENERATED', 'BEST']) {
    /*
     * 长度比例门槛：候选长度必须达到关键词的 70%（且不超过关键词长度）。
     *
     * 这一条是**必须的**，否则会误杀真曲名——实测
     * `RingedGenesis` 与 `GENERATED` 有 6 字符公共子串（`GENER`），
     * 只看子串就会把真曲名当字段标签删掉。
     * 而残片与关键词长度接近：`OTENTIAL`(8) vs `POTENTIAL`(9) = 89%，
     * `RingedGenesis`(13) vs `GENERATED`(9) = 144%（超过关键词长度，直接出局）。
     */
    if (upper.length > kw.length || upper.length < kw.length * 0.7) continue
    for (let len = upper.length; len >= 4; len--) {
      for (let i = 0; i + len <= upper.length; i++) {
        if (kw.includes(upper.slice(i, i + len))) return true
      }
    }
  }
  return false
}

export function scoreTitleCandidate(text: string): number {
  const s = (text || '').trim()
  if (s.length < 3) return -1
  if (looksLikeFieldLabel(s)) return -1
  const letters = (s.match(/[A-Za-z\p{L}]/gu) || []).length
  const digits = (s.match(/\d/g) || []).length
  if (letters === 0) return -1
  // 曲名至少要有 3 个字母；且字母不能比数字少（`14d`、`20ml` 这类碎片出局）
  if (letters < 3) return -1
  if (digits > letters) return -1

  const letterRatio = letters / s.length
  let score = letterRatio * 10
  if (/\s/.test(s)) score += 2
  // 数字惩罚大幅提高：碎片常有 1–2 个数字，真曲名很少
  if (digits > 0) score -= digits * 3
  // 纯大写短串（如 `NC`、`PM`）多半是评级，但长度 ≥3 且字母占多数时可能是曲名，
  // 只轻微扣分，避免误杀 MVURBD 这类全大写曲名
  if (s === s.toUpperCase() && s.length <= 3) score -= 1
  if (s.length > 40) score -= 3
  return score
}

/**
 * 把一张卡片的若干 OCR 文本块解析成候选成绩。
 *
 * 输入应是**同一张卡文字区**内的块（已按 y 排序）。
 * 解析策略：逐块识别字段类型，取第一个命中的值；
 * 曲名取"最长且不像数字/判定行"的那块。
 */
export function parseCardItems(
  items: OcrItem[],
  gameId?: string,
  /**
   * 可选的曲名打分函数（给定拼接好的字符串返回 0–1 相似度）。
   * 传了它就会启用"多块拼接择优"，用于 Phigros 那种曲名被切碎的情形。
   * 由调用方注入是为了避免 shared 层反向依赖定数表匹配逻辑。
   */
  titleScorer?: (text: string) => number,
  /**
   * PTT 允许的最少小数位。默认 4（版式 A 的卡面口径）；
   * 版式 B 的卡面只显示 2 位，必须传 2，否则 PTT 一个都读不到。
   * 见 `extractPotential` 的注释。
   */
  minPotentialDecimals = 4,
  /**
   * 外部注入的曲名候选（**纯文本，不参与坐标合并**）。
   *
   * 由 ONNX 曲名增强路径提供（见 `src/main/ocr.ts` 的"各取其长"一节）。
   * 之所以要单独的入口而不是直接塞进 `items`：两个引擎坐标系不同，
   * 混进 `items` 会被开头的 `mergeLineFragments` 错误合并。
   */
  extraTitleTexts?: string[],
  /**
   * **PTT 定向补读**得到的文本候选（纯文本，不参与坐标合并）。
   *
   * 由 ONNX v5 重读"PaddleJS 没解出 PTT"的那些格子产生。
   * v5 的优势是**能读对小数点**，而 `extractPotential` 要求 4 位小数，
   * 所以补读能救回这批格子的 PTT。
   *
   * ⚠ 与 `extraTitleTexts` 分开传，因为两者的处理不同：
   * 曲名候选要过滤掉带数字的、PTT 候选**恰恰需要数字**。
   */
  extraPotentialTexts?: string[],
  /**
   * **判定带**（F/L）单独识别得到的文本（纯文本，不参与坐标合并）。
   *
   * ## 为什么需要单独一条通道（用户实测驱动）
   *
   * 用户指出卡片右下角是**最后更新时间**（`17d`/`9h`），它**紧贴判定数印刷**，
   * 于是整行识别会得到 `L:39h`、`L:723d` 这类串，
   * 而 `L:3`+`9h` 与 `L:39`+`h` 在字符串上**无法区分**。
   *
   * 解法不是继续调正则，而是**换识别来源**：按几何裁一条右边界收窄的带
   * （见 `onnxTitleBands` 的 `xScaleRight=0.85`），让时间标落在带外。
   * 扫描证实 `0.85` 是临界值，再宽就会把时间标纳入。
   *
   * ⚠ 与 `extraPotentialTexts` 分开传，因为判定数**只**从这条通道取，
   * 避免整行文本里的时间标把 `extractFaults` 带偏。
   */
  extraFaultTexts?: string[],
  /** 独立几何定数带的文本候选；优先级高于整卡 OCR。 */
  extraConstantTexts?: string[]
): EntryCandidate {
  /*
   * 先按坐标把"同一行内横向相邻的碎片"合并。
   *
   * 为什么放在解析之前：实测 Arcaea 版式 B 会把 `POTENTIAL 12.39` 切成
   * `"POTEN"` + `"AL"` + `"12.3"` + `"19"`，末位还被误读
   * （`39`→`19`、`08`→`B`）。字符串层面的拼接救不了这种情况，
   * 但按坐标并回整行后，`extractPotential` 就能从
   * `POTENTIAL12.319` 里挑出 11–13 区间内的候选。
   *
   * 注意合并**不影响排序**：合并后的块仍带坐标，下面照样按 y 排序。
   */
  const sorted = mergeLineFragments(items)
  /*
   * 版式 B 的右上角等级菱形是重复谱面的唯一可靠线索之一。
   * 它会被 PaddleJS 读成 `11`、`10+`，也可能是噪声形式的 `qt`/`g+`；
   * 只保留右上角的小块，交给上层做“同名不同谱面”保护，不参与曲名匹配。
   */
  const chartLevel = (() => {
    if (gameId !== 'arcaea') return null
    const topRight = sorted
      .filter((item) => item.y <= 95 && item.x >= 220 && item.text.trim().length <= 5)
      .sort((a, b) => (b.x + b.w) - (a.x + a.w))
    const raw = topRight[0]?.text.trim()
    return raw ? raw.normalize('NFKC').toUpperCase() : null
  })()
  /*
   * **PTT 定向补读的候选**：先在这里算出值，稍后与 `sorted` 的结果一起择优。
   *
   * 不能并进 `sorted`（坐标系不同，会被 `mergeLineFragments` 错误合并），
   * 也不走曲名通道（那条通道会过滤掉带数字的文本，而 PTT 恰恰是数字）。
   */
  let extraPotConflict = false
  const extraPotValue = (() => {
    if (!extraPotentialTexts) return null
    const values = new Map<number, { value: number; text: string }>()
    for (const text of extraPotentialTexts) {
      const value = extractPotential(text, Math.min(minPotentialDecimals, 3))
      // 隔离字段必须有可见小数点；冲突不能通过取最大值解决。
      if (
        value &&
        !value.text.startsWith('恢复:') &&
        value.value >= 9 &&
        value.value <= 13.5
      ) values.set(value.value, value)
    }
    extraPotConflict = values.size > 1
    return values.size === 1 ? [...values.values()][0] : null
  })()
  const sources: string[] = []
  let rank: number | null = null
  let score: number | null = null
  let scoreRaw = ''
  let constant: number | null = null
  const constantCandidates: ConstantCandidate[] = []
  if (extraConstantTexts) {
    for (const text of extraConstantTexts) {
      for (const c of extractConstantCandidates(text, 'geometry:constant')) {
        constantCandidates.push({ ...c, confidence: Math.max(c.confidence, 1) })
      }
    }
    if (constantCandidates.length > 0) constant = constantCandidates[0].value
  }
  let potential: number | null = null
  let grade: string | null = null
  let faults: EntryCandidate['faults'] = { far: null, lost: null }
  let accuracy: number | null = null
  /** 参与准确率判定的全部文本块（含坐标，最后统一挑选） */
  const accuracyCandidates: Array<{ text: string; y: number; x: number }> = []
  const titleParts: string[] = []
  /** 与 titleParts 对应的（文本, 纵坐标），供拼接时排序 */
  const titlePartsRaw: Array<{ text: string; y: number }> = []

  for (const item of sorted) {
    const raw = item.text
    if (!raw.trim()) continue
    sources.push(raw)

    for (const c of extractConstantCandidates(raw, `ocr:${item.x},${item.y}`)) {
      constantCandidates.push(c)
    }

    if (rank === null) {
      const r = extractRank(raw)
      if (r !== null) rank = r
    }

    if (score === null) {
      const s = extractScore(raw, gameId)
      if (s) {
        score = s.value
        scoreRaw = raw
      }
    }

    if (potential === null) {
      const p = extractPotential(raw, minPotentialDecimals)
      /*
       * Arcaea 的 PTT 有稳定的值域（9.0–13.5）。版式 A 的整卡文本
       * 可能把定数 `10.7` 与被截断的 PTT `12` 粘成 `10.712`；
       * 当最小位数放宽到 3 时，这个残片会看起来像一个合法小数。
       * 值域门槛让三位 PTT 仍可从字段带补读，同时保留整卡定数解析。
       */
      if (p && p.value >= 9 && p.value <= 13.5) potential = p.value
    }
    if (constant === null) {
      const c = extractConstantCandidates(raw)[0]
      if (c) constant = c.value
    }

    if (grade === null) {
      const g = extractGrade(raw)
      if (g) grade = g
    }

    /*
     * ⚠ **先在"剥掉 Potential 文本"的副本上取判定数**（用户实测驱动）。
     *
     * 坐标块里常常把 Potential 行也带进来，例如：
     * ```
     * 'OTENTIAL10.312.07N'     <- 这里的 `L10` 会被当成 lost=10！
     * 'OTENTIAL9.811.5187NC'   <- 同样
     * ```
     * `POTENTIAL` 的末字母 `l` + 紧随的定数十位，正好符合 `L` + 数字。
     * 我试过用否定型后顾 `(?<!POTENTIA)` 排除，但 OCR 常把
     * `POTENTIAL` 读成 `OTENTIAL`（首字母丢失），后顾就失效了。
     *
     * 所以改为**先剥掉整段 Potential 文本**再解析判定数——
     * 这与 `extractConstant` 的做法一致（它同样是先剥 PTT 再找定数）。
     */
    const rawForFaults = potential !== null ? raw.replace(String(potential), '') : raw
    const f = extractFaults(rawForFaults.replace(/P?OTENTIAL/gi, ' '))
    if (faults.far === null && f.far !== null) faults = { ...faults, far: f.far }
    if (faults.lost === null && f.lost !== null) faults = { ...faults, lost: f.lost }

    /*
     * 准确率：把所有块里的候选都收集起来。不能取第一个命中的块——
     * 实测同一张 Phigros 卡上会同时出现
     * 被截断的碎片（`33%`）与真实值（`99.49%`），见 extractAccuracyFrom。
     */
    accuracyCandidates.push({ text: raw, y: item.y, x: item.x })

    // 曲名候选：不含大段数字、且含字母或 CJK 的块
    {
      /*
       * ⚠ 打分必须对**清理后**的文本做，而且要**双重检查关键词**。
       *
       * 实测坑：`cleanTitle('ARCAEA')` 曾会剥掉前导 `A` 变成 `RCAEA`
       * （因为它命中了"全大写、长度 ≥7、剥 1 个前导字母"的启发式），
       * 于是原本能被 `FIELD_KEYWORDS` 拦下的页头 `ARCAEA` 绕过了过滤，
       * 以 `RCAEA` 的身份拿到 10 分、被当成曲名。
       *
       * 所以：先清理再打分，并且对清理后的结果再查一次关键词。
       */
      const cleaned = cleanTitle(raw)
      const score = scoreTitleCandidate(cleaned)
      if (score > 0 && !FIELD_KEYWORDS.test(cleaned)) {
        titleParts.push(cleaned)
        titlePartsRaw.push({ text: cleaned, y: item.y })
      }
      /*
       * 同时把"剥掉一个前导大写字母"的版本**也作为候选**。
       *
       * 为什么不用启发式直接决定：实测那套启发式（全大写 + 长度 ≥7 + 剥 1 个前导字母）
       * **只对 1 个真实样本有收益**（`LMVURBD` → `MVURBD`），
       * 却会**误伤 29 首真实曲名**——定数表里 `SENOCIDER`、`GENOCIDER`、
       * `MEGALOVANIA`、`PRAGMATISM`、`SATISFACTION` 等全是"全大写且长"，
       * 会被削成 `ENOCIDER`、`EGALOVANIA`…从而匹配失败。
       *
       * 另外两个当时以为需要削的样本（`ZlRingedGene`、`CeAttraqtia`）
       * 经实测**靠模糊匹配本来就能成功**，削了反而命中不了——
       * 所以启发式的收益比想象中小得多，风险却大得多。
       *
       * 改成"两个候选都交给打分函数"，由**定数表**决定哪个更像真曲名
       * （`titleScorer` 由调用方注入，就是 `matchTitle` 的相似度）。
       * 这样 `LMVURBD` 仍能匹配到 `MVURBD`，而 `SENOCIDER` 不会被削。
       */
      if (titleScorer) {
        const stripped = cleanTitle(raw, true)
        if (
          stripped !== cleaned &&
          stripped.length >= 3 &&
          !FIELD_KEYWORDS.test(stripped) &&
          !looksLikeFieldLabel(stripped)
        ) {
          const s2 = scoreTitleCandidate(stripped)
          if (s2 > 0) {
            titleParts.push(stripped)
            titlePartsRaw.push({ text: stripped, y: item.y })
          }
        }
      }
    }
  }

  // 原图的隔离 PTT 字段优先于整卡小字，后者可能吞掉小数位。
  potential = extraPotConflict ? null : extraPotValue?.value ?? potential

  // A clear-status suffix in the card's isolated Potential band is safer than
  // a token in a full-image line. Require a readable matching value; disagreeing
  // model suffixes remain unknown for review instead of borrowing a neighbour.
  if (gameId === 'arcaea' && extraPotentialTexts && potential !== null) {
    const statuses = new Set<string>()
    for (const text of extraPotentialTexts) {
      const value = extractPotential(text, Math.min(minPotentialDecimals, 3))
      if (!value || value.text.startsWith('恢复:') || value.value !== potential) continue
      const suffix = /(?:^|[^A-Z])(PM|FR|TC|TL|NC|HC)\s*$/i.exec(text.normalize('NFKC'))
      if (suffix) statuses.add(suffix[1].toUpperCase())
    }
    if (statuses.size > 0) grade = statuses.size === 1 ? [...statuses][0] : null
  }

  const uniqueConstants = [...new Map(constantCandidates.map((c) => [c.value, c])).values()]
  if (uniqueConstants.length > 0) constant = uniqueConstants[0].value

  // 准确率：跨所有块取合理区间内的最大值
  {
    const a = extractAccuracyFrom(accuracyCandidates, { preferLeftmost: false })
    if (a) accuracy = a.value
  }

  /*
   * **注入外部曲名候选**（2026-04，"各取其长"方案）。
   *
   * ## 为什么需要这个入口
   *
   * ONNX 引擎的曲名更准（且支持日文假名），但它与 PaddleJS 的
   * **坐标系不同**。我第一版把 ONNX 的文本块直接并进 `items`，
   * 结果解析器开头的 `mergeLineFragments`（按 y 坐标合并同一行的碎片）
   * 把它们与 PaddleJS 的块错误合并，**PTT 从 50 掉到 24**。
   *
   * 所以曲名改走这个"纯文本注入"通道：不参与坐标合并，
   * 只作为**额外候选**进入曲名候选池，由打分器公平竞争。
   * 分数/PTT/定数等字段仍完全来自 PaddleJS。
   */
  if (extraTitleTexts) {
    for (const t of extraTitleTexts) {
      const cleaned = cleanTitle(t)
      if (!cleaned) continue
      if (FIELD_KEYWORDS.test(cleaned)) continue
      if (!titleParts.includes(cleaned)) {
        titleParts.push(cleaned)
        /*
         * 纵坐标给一个**远离卡片区域的负值**：这样它只会作为
         * 独立候选参与打分，不会被 `joinTitleFragments` 与其他块拼接。
         */
        titlePartsRaw.push({ text: cleaned, y: -10000 })
      }
    }
  }

  /*
   * ## 判定数（F/L）的**优先级覆盖**（用户实测驱动）
   *
   * 两条来源的可靠性不同，所以这里做**覆盖**而不是"先到先得"：
   *
   * | 来源 | 可靠性 | 原因 |
   * |---|---|---|
   * | **判定带**（几何裁、右边界 0.85）| **高** | 时间标落在带外，读数干净 |
   * | 坐标块（整行碎片）| 低 | 判定数与右下角时间标连着（`L:3` + `9h`）|
   *
   * 实测对比（用户真值）：
   * ```
   * #1  坐标块 "：1153(+1016)F:14L:3" -> L=39  ❌
   *     判定带 "1163（+1015）F14L:3"  -> L=3   ✅
   * ```
   * 所以判定带有值时**以它为准**；没有时才回退到坐标块。
   * 两条都没有则保持 null（界面可编辑，符合"宁可缺，不可错"）。
   */
  if (extraFaultTexts !== undefined) {
    const band = { far: null as number | null, lost: null as number | null }
    for (const t of extraFaultTexts) {
      const ef = extractFaults(t)
      if (band.far === null && ef.far !== null) band.far = ef.far
      if (band.lost === null && ef.lost !== null) band.lost = ef.lost
    }
    /*
     * 判定带**完全接管** F/L：只要它解出任一字段，就整体采用它的结果
     * （而不是逐字段取并集）。
     *
     * 逐字段并集会带来"半对半错"的串味：实测 `#44` 判定带读出
     * `F=2 L=7`（正确），但坐标块给出 `F=21`，于是并集得到 `F=21 L=7`
     * ——比全错更难发现。整体接管能避免这种混合。
     */
    // 已尝试隔离判定带后，缺项保持未知；不能回退到可能含时间标的整行。
    faults = band
  }

  /*
   * 选曲名。两条路径：
   *
   * ① **没有打分依据时**：按特征打分取最高的那个块（旧行为）。
   *    不能"取最长"——实测 `POTENTIAL10.712` 比 `InvertedWorld` 更长。
   *
   * ② **给了打分依据（`titleScorer`）时**：把所有像曲名的块做**拼接择优**
   *    （见 `joinTitleFragments`）。这一步是为 Phigros 加的：它的曲名常被
   *    OCR 切成多块（`ethe` + `Miserable`），只取单块匹配不上。
   *    实测曲名匹配率 **17/36 → 21/36**，且无一处变差。
   *
   * 两条路径都保留：Arcaea 的曲名基本是单块，走 ① 更省；Phigros 走 ②。
   */
  /*
   * 候选池：**把全部曲名候选按打分排序后暴露出去**。
   *
   * ## 为什么要暴露（而不是只给选中的那个）
   *
   * 实测结论：Phigros 的瓶颈**不是裁剪几何**，而是"单格里只剩唯一候选、
   * 没有纠错余地"。宽框（跨卡）之所以比精确窄框更好，
   * 正是因为它让**打分器在同一格里看到多个候选**。
   *
   * 所以这里把所有候选按分数排序输出，供上层做**跨格联合分配**
   * （见 `assignTitlesGlobally`）——逐格独立决策无法利用
   * "同一首曲目不该出现在两格"这类全局约束。
   */
  const candidatePool = titleScorer
    ? (() => {
        const frags = titlePartsRaw
          .filter((f) => looksLikeTitleFragment(f.text))
          .map((f) => ({ text: f.text, y: f.y }))
        const joined = joinTitleFragments(frags, titleScorer)
        // 拼接结果优先，其余单块候选按分数跟随
        const rest = titleParts
          .filter((t) => t !== joined.text)
          .sort((a, b) => scoreTitleCandidate(b) - scoreTitleCandidate(a))
        const pool = joined.text ? [joined.text, ...rest] : rest
        return [...new Set(pool)].map((text) => ({ text, score: titleScorer(text) }))
      })()
    : [...new Set(titleParts)]
        .sort((a, b) => scoreTitleCandidate(b) - scoreTitleCandidate(a))
        .map((text) => ({ text, score: scoreTitleCandidate(text) }))

  /*
   * **分隔符切段**：分表上的"中日文标题 + 英文曲名"（用户 2026-04 指出）。
   *
   * 用户说明：定数表用的是**游戏内英文曲名**，而分表上有些曲目显示
   * **中日文标题**——同一首歌却对不上。实测：
   *   ```
   *   分表显示  妖艶魔女-trappola bewitching
   *   定数表    trappola bewitching          ← "-" 后面的英文尾巴就是它
   *   分表显示  望影の方舟Six
   *   定数表    望影の方舟Six                （表里本身也有 CJK 曲名）
   *   ```
   *
   * 所以把每个候选再按分隔符切开、**各段分别作为候选**，
   * 让打分器去试哪一段能命中定数表。这样：
   *   - 分表 CJK + 表英文 → 英文段命中；
   *   - 分表英文 + 表 CJK → CJK 段命中。
   *
   * 分段结果同样走 `titleScorer` 打分，所以不会降低原有候选的优先级。
   */
  const withSegments = (() => {
    const extra: string[] = []
    for (const c of candidatePool) {
      for (const seg of c.text.split(/[-–—:：|/]/)) {
        const t = seg.trim()
        if (t.length < 2 || t === c.text) continue
        extra.push(t)
      }
    }
    if (extra.length === 0) return candidatePool
    const seen = new Set(candidatePool.map((c) => c.text))
    const merged = [...candidatePool]
    for (const t of extra) {
      if (seen.has(t)) continue
      seen.add(t)
      merged.push({ text: t, score: titleScorer ? titleScorer(t) : 0 })
    }
    return merged
  })()
  // 所有来源和切段候选一起排序，不能让先加入的低分拼接串压过正确曲名。
  const rankedTitles = titleScorer ? withSegments.sort((a, b) => b.score - a.score) : withSegments
  const title = rankedTitles[0]?.text ?? ''

  // 置信度：关键字段命中数 / 期望字段数（曲名、分数、定数、PTT）
  const expected = 4
  let got = 0
  if (title) got++
  if (score !== null) got++
  if (constant !== null) got++
  if (potential !== null) got++
  const confidence = got / expected

  return {
    rank,
    title,
    titleCandidates: rankedTitles,
    score,
    scoreRaw,
    constant,
    constantCandidates: uniqueConstants,
    potential,
    grade,
    chartLevel,
    faults,
    accuracy,
    confidence,
    sources
  }
}

/**
 * 判断某张卡是否"识别得不干净"，需要人工复核。
 *
 * 触发条件（任一）：关键字段缺失、置信度低、或分数位数异常。
 */
export function needsReview(c: EntryCandidate): { review: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!c.title) reasons.push('未识别到曲名')
  if (c.score === null) reasons.push('未识别到分数')
  if (c.constant === null) reasons.push('未识别到定数')
  if (c.confidence < 1) reasons.push(`置信度 ${(c.confidence * 100).toFixed(0)}%`)
  /*
   * 分数结构校验（重要）：
   * Arcaea 分数是 7 位（9'958'701）或 8 位（10'000'000），且**一定以 9 或 10 开头**。
   * 实测曾出现裁剪掉一位变成 `0995870` 的情况——数值仍在区间内，
   * 光看区间发现不了，必须校验位数与首位。
   */
  if (c.score !== null) {
    const digits = String(c.score).length
    if (digits !== 7 && digits !== 8) {
      reasons.push(`分数位数异常（${digits} 位，应为 7 或 8）`)
    } else if (c.score < 9_000_000) {
      reasons.push(`分数 ${c.score} 不以 9 开头，疑为漏位`)
    }
  }
  return { review: reasons.length > 0, reasons }
}
