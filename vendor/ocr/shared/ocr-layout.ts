/** 通用网格定位；游戏的模板、字段与检测策略由独立配置提供。 */
import type { Rect, CardSlot, GridDetection, GrayImage, LayoutTemplate, AnchorCardSpec, ColumnOffset } from './ocr-layout/types'
import { findBrightRuns, projectRatio, projectSaturation } from './ocr-layout/geometry'
import { OCR_PROFILES } from './games/ocr-profiles'
export type { Rect, CardSlot, GridDetection, GrayImage, LayoutTemplate, AnchorCardSpec, ColumnOffset } from './ocr-layout/types'
export { BRIGHT_THRESHOLD, findBrightRuns, projectRatio, projectSaturation } from './ocr-layout/geometry'
export { ARCAEA_PLAYER_BESTS } from './games/arcaea/ocr'

export function scoreTemplate(profile: number[], template: LayoutTemplate, size: number, axis: 'x' | 'y'): number {
  const n = profile.length
  if (n === 0 || size <= 0) return 0
  const first = axis === 'x' ? template.firstColX : template.firstRowY
  const pitch = axis === 'x' ? template.colPitch : template.rowPitch
  const extent = (axis === 'x' ? template.colWidth : template.rowHeight) * size
  const count = axis === 'x' ? template.cols : template.rows
  const startPx = first * size
  const pitchPx = pitch * size
  if (pitchPx < 4) return 0

  let centerSum = 0
  let betweenSum = 0
  let cells = 0
  const half = Math.max(1, Math.round(extent * 0.15))
  for (let c = 0; c < count; c++) {
    // 模板记录的是格的上/左缘，格中心由尺寸决定，不能用含间隙的步长代替。
    const center = Math.round(startPx + c * pitchPx + extent / 2)
    if (center < 0 || center >= n) break
    let s = 0
    let k = 0
    for (let i = Math.max(0, center - half); i <= Math.min(n - 1, center + half); i++) {
      s += profile[i]
      k++
    }
    centerSum += k > 0 ? s / k : 0
    const mid = Math.round(startPx + c * pitchPx + (extent + pitchPx) / 2)
    if (mid >= 0 && mid < n) betweenSum += profile[mid]
    cells++
  }
  if (cells < 2) return 0
  const center = centerSum / cells
  const between = betweenSum / cells
  /*
   * 判据随**极性**翻转。
   *
   * - `'bright'`（默认）：亮卡暗底 → 格中心更亮、格间更暗，取 `center - 0.6×between`
   * - `'dark'`：暗卡亮底（官方订阅功能的分表）→ 反过来取 `between - 0.6×center`
   *
   * 实测：官方分表用 `'bright'` 判据时列得分恒为负，
   * 被 `colScore < 0.45` 拒掉，整图落到 `generic-grid`。
   */
  const polarity = template.polarity ?? 'bright'
  if (polarity === 'dark') return Math.max(0, between - 0.6 * center)
  // 格中心越亮、格间越暗越好
  return Math.max(0, center - 0.6 * between)
}

export function looksLikeTallSheet(width: number, height: number): boolean {
  return height / width >= 0.85
}

export function fitGrid(
  profile: number[],
  opts: { minSize: number; maxSize: number; maxCells: number }
): { start: number; pitch: number; size: number; cells: number; score: number } | null {
  const n = profile.length
  if (n === 0) return null

  // 候选步长：由"亮区段的起点差"给出若干猜测，再在附近细化
  const coarse = findBrightRuns(profile, 0.4, Math.max(4, Math.round(n * 0.005)))
  const pitchCandidates = new Set<number>()
  const addPitch = (p: number): void => {
    if (p < opts.minSize || p > opts.maxSize) return
    for (let d = -3; d <= 3; d++) {
      const v = p + d
      if (v >= opts.minSize && v <= opts.maxSize) pitchCandidates.add(v)
    }
  }
  for (let i = 1; i < coarse.length; i++) addPitch(coarse[i][0] - coarse[i - 1][0])
  // 兜底候选：从区段尺寸推（假设占空比 0.6）
  for (const [a, b] of coarse) addPitch(Math.round((b - a + 1) / 0.62))
  if (pitchCandidates.size === 0) return null

  let best: { start: number; pitch: number; size: number; cells: number; score: number } | null = null

  const firstRun = coarse[0]
  const minStart = firstRun ? Math.max(0, firstRun[0] - Math.round((opts.maxSize ?? 100) * 0.1)) : 0
  const maxStart = firstRun ? firstRun[0] + 2 : pitchCandidates.size > 0 ? n : 0

  for (const pitch of pitchCandidates) {
    if (pitch <= 0) continue
    const maxCells = Math.min(opts.maxCells, Math.floor(n / pitch))
    if (maxCells < 2) continue
    // 起点搜索范围收紧到首个亮区附近
    for (let start = Math.max(0, minStart); start <= Math.min(maxStart, n - pitch); start++) {
      let sumCenter = 0
      let sumBetween = 0
      let cells = 0
      for (let c = 0; c * pitch + start < n; c++) {
        const center = Math.round(start + c * pitch + pitch / 2)
        if (center >= n) break
        // 中心附近取 ±10% 步长的窗口平均，抗单像素噪声
        const half = Math.max(1, Math.round(pitch * 0.12))
        let s = 0
        let k = 0
        for (let i = Math.max(0, center - half); i <= Math.min(n - 1, center + half); i++) {
          s += profile[i]
          k++
        }
        sumCenter += k > 0 ? s / k : 0
        cells++
        // 格间中点：应当偏暗（否则说明步长太小，切碎了同一张卡）
        const mid = Math.round(start + c * pitch + pitch)
        if (mid < n) sumBetween += profile[mid]
      }
      if (cells < 2) continue
      const score = sumCenter / cells - 0.5 * (sumBetween / cells)
      if (!best || score > best.score) {
        best = { start, pitch, size: pitch, cells, score }
      }
    }
  }

  if (!best) return null
  // 修正格宽：从亮区段实测卡片实际尺寸（拟合只给出步长与起点）
  const inside = coarse.filter(([a]) => a >= best!.start - best!.pitch * 0.3)
  best.size = inside.length > 0 ? inside[0][1] - inside[0][0] + 1 : Math.round(best.pitch * 0.62)
  return best
}

export function gridToRuns(
  fit: { start: number; pitch: number; size: number; cells: number },
  limit: number
): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  for (let c = 0; c < fit.cells; c++) {
    const from = Math.round(fit.start + c * fit.pitch)
    const to = from + fit.size - 1
    if (from < 0 || to >= limit) break
    runs.push([from, to])
  }
  return runs
}

export function extendRuns(
  runs: Array<[number, number]>,
  pitch: number,
  limit: number,
  isBright: (from: number, to: number) => boolean
): Array<[number, number]> {
  if (runs.length === 0 || pitch <= 0) return [...runs]
  const size = runs[0][1] - runs[0][0] + 1
  const out = runs.map(([a, b]) => [a, b] as [number, number])
  // 向后补（更常见：截图底部把最后一行裁掉）
  for (let i = 0; i < 30; i++) {
    const last = out[out.length - 1]
    const next = last[0] + pitch
    if (next + size > limit) break
    if (!isBright(next, next + size - 1)) break
    out.push([next, next + size - 1])
  }
  // 向前补
  for (let i = 0; i < 30; i++) {
    const first = out[0]
    const next = first[0] - pitch
    if (next < 0) break
    if (!isBright(next, next + size - 1)) break
    out.unshift([next, next + size - 1])
  }
  return out
}

/**
 * **按模板比例直接生成网格**（不做任何打分）。
 *
 * 供 `assumeGrid` 的模板使用——见 `LayoutTemplate.assumeGrid` 的说明：
 * 版式B（官方订阅功能）的卡片是"暗面板 + 彩色亮立绘"，
 * 亮度投影的行得分天花板只有约 0.22，永远过不了 0.45 的门槛；
 * 而它的比例是**实测核对过**的，所以直接采用。
 *
 * ## 与 `tryTemplate` 的区别
 *
 * `tryTemplate` 先给模板打分、过门槛才生成网格；本函数**不打分**，
 * 只要行列数够（≥3）就直接生成。所以它是"信任模板"的路径。
 */
function gridFromTemplate(
  image: GrayImage,
  t: LayoutTemplate,
  W: number,
  H: number,
  debug: GridDetection['debug']
): GridDetection | null {
  const rowRuns = gridToRuns(
    {
      start: Math.round(t.firstRowY * H),
      pitch: Math.round(t.rowPitch * H) || 1,
      size: Math.round(t.rowHeight * H) || 1,
      cells: t.rows
    },
    H
  )
  const colRuns = gridToRuns(
    {
      start: Math.round(t.firstColX * W),
      pitch: Math.round(t.colPitch * W) || 1,
      size: Math.round(t.colWidth * W) || 1,
      cells: t.cols
    },
    W
  )
  if (rowRuns.length < 3 || colRuns.length < 3) return null

  /*
   * ## 内容校验（不能只信比例）
   *
   * 只按比例切的话，**无卡片结构的图也会被套成 5×10** ——
   * 实测这会让一条护栏用例挂掉，而它的意图正是"别把无结构图报成正常网格"
   * （否则主流程会照着裁 50 张卡、产出一堆垃圾条目）。
   *
   * 判据：版式B 的卡片是**暗面板**。所以取每行的中心带，统计其中
   * "比全图中位数更暗"的像素比例——真实分表应当占相当一部分，
   * 而无结构图（大面积亮底）会远低于阈值。
   *
   * 这是**廉价的合理性检查**，不是精确打分，所以阈值取得很宽（0.10），
   * 只为拦住"整图都很亮"的情况。
   */
  {
    const vals: number[] = []
    for (let y = 0; y < H; y += 8) {
      for (let x = 0; x < W; x += 8) vals.push(image.data[y * W + x])
    }
    vals.sort((a, b) => a - b)
    const median = vals[Math.floor(vals.length / 2)] ?? 128
    let dark = 0
    let total = 0
    for (const [r0, r1] of rowRuns) {
      const cy = Math.min(H - 1, Math.max(0, Math.round((r0 + r1) / 2)))
      for (let x = 0; x < W; x += 4) {
        if (image.data[cy * W + x] < median) dark++
        total++
      }
    }
    const darkRatio = total > 0 ? dark / total : 0
    if (darkRatio < 0.1) return null
  }

  debug.rowRuns = rowRuns
  debug.colRuns = colRuns
  return {
    family: t.family,
    rows: rowRuns.length,
    cols: colRuns.length,
    rowPitch: Math.round(t.rowPitch * H),
    colPitch: Math.round(t.colPitch * W),
    slots: assembleSlots(rowRuns, colRuns, t.extraRegions, t.textInset),
    /*
     * 没打分，所以置信度给一个明确的中间值——
     * 既不冒充"高置信"（那会让上层误以为经过验证），
     * 也不低到被当成检测失败。
     */
    confidence: 0.6,
    debug
  }
}

export function detectCardGrid(image: GrayImage, satImage?: GrayImage, profiles = OCR_PROFILES): GridDetection {
  const { width: W, height: H } = image
  const debug: GridDetection['debug'] = { rowRuns: [], colRuns: [] }
  const rowRatio = projectRatio(image, 'y', 0, H - 1, [0, W - 1])
  if (looksLikeTallSheet(W, H)) {
    for (const profile of profiles) {
      const projectedImage = profile.projection === 'saturation' ? satImage ?? image : image
      const detected = profile.detectBands?.(projectedImage, W, H, debug)
      if (detected) return detected
      const rows = projectRatio(projectedImage, 'y', 0, H - 1, [0, W - 1])
      for (const template of profile.templates) {
        /*
         * **显式网格**：跳过打分，直接按模板比例生成。
         *
         * 版式B（官方订阅功能）的卡片是"暗面板 + 彩色亮立绘"，
         * 亮度投影的行得分天花板只有 ~0.22，永远过不了 0.45 的门槛，
         * 而它的比例是实测核对过的。所以这类模板直接采用。
         *
         * 只在 `looksLikeTallSheet()` 为真时走到这里，
         * 所以版式A（近方图）不受影响。
         */
        if (template.assumeGrid) {
          /*
           * ⚠ 必须过宽高比这道门。
           *
           * `looksLikeTallSheet()` 放进来的是"宽/高 ≤ 1.18"的一大类图，
           * 其中很多是**无卡片结构**或别的版式。若对它们一律套用 5×10，
           * 会裁出大量垃圾条目（实测两条护栏用例就是这么挂的）。
           */
          const aspect = W / H
          const cap = template.assumeGridMaxAspect ?? 0.7
          if (aspect > cap) continue
          const assumed = gridFromTemplate(projectedImage, template, W, H, debug)
          if (assumed) return assumed
          continue
        }
        const grid = tryTemplate(projectedImage, template, rows, W, H, debug, template.extraRegions)
        if (grid) return grid
      }
    }
  }
  return detectByFit(image, rowRatio, debug)
}

export function clusterGroups(values: number[], tolerance: number): Array<{ c: number; values: number[] }> {
  const sorted = [...values].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const v of sorted) {
    const last = groups[groups.length - 1]
    if (last && v - last[last.length - 1] <= tolerance) {
      last.push(v)
      continue
    }
    groups.push([v])
  }
  return groups.map((g) => ({
    c: Math.round(g.reduce((a, b) => a + b, 0) / g.length),
    values: g
  }))
}

export function pickHeaviest(
  groups: Array<{ c: number; values: number[] }>,
  limit?: number
): number[] {
  const sorted = [...groups].sort((a, b) => b.values.length - a.values.length)
  const kept = limit ? sorted.slice(0, limit) : sorted
  return kept.map((g) => g.c).sort((a, b) => a - b)
}

export function pickRegularSeries(candidates: number[]): number[] {
  if (candidates.length < 2) return [...candidates].sort((a, b) => a - b)
  const xs = [...candidates].sort((a, b) => a - b)
  let best: number[] = [xs[0]]
  let bestScore = -Infinity

  for (let i = 0; i < xs.length - 1; i++) {
    const pitch = xs[i + 1] - xs[i]
    if (pitch <= 0) continue
    const series = [xs[i]]
    for (let j = i + 1; j < xs.length; j++) {
      const d = xs[j] - series[series.length - 1]

      const k = d / pitch
      const nearest = Math.max(1, Math.round(k))
      const nearInt = nearest <= 3 && Math.abs(k - nearest) <= 0.45
      const okNeighbour = Math.abs(k - 1) <= 0.3
      if (okNeighbour || nearInt) {
        series.push(xs[j])
      }
    }
    const gaps: number[] = []
    for (let k = 1; k < series.length; k++) gaps.push(series[k] - series[k - 1])
    const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0
    const dev = mean
      ? gaps.reduce((a, b) => a + Math.abs(b - mean), 0) / gaps.length / mean
      : 0
    // 成员数为主、间距规整度为辅
    const score = series.length * 10 - dev * 5
    if (score > bestScore) {
      bestScore = score
      best = series
    }
  }
  return best
}

export function clusterValues(values: number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const v of sorted) {
    const last = groups[groups.length - 1]
    if (last && v - last[last.length - 1] <= tolerance) {
      last.push(v)
      continue
    }
    groups.push([v])
  }
  return groups.map((g) => Math.round(g.reduce((a, b) => a + b, 0) / g.length))
}

export function gridFromAnchors(
  anchors: Array<{ x: number; y: number }>,
  imageWidth: number,
  imageHeight: number,
  tolerance = 60,
  spec: AnchorCardSpec = { width: 1, height: 1, dx: 0, dy: 0 },

  family: GridDetection['family'] = 'generic-grid',

  expectedCols?: number,

  clampRight = true,

  colOffsets?: ColumnOffset[]
): GridDetection | null {
  if (anchors.length < 4) return null
  let colCenters: number[]
  let rowCenters: number[]
  if (expectedCols && expectedCols >= 2) {

    const colGroups = clusterGroups(anchors.map((a) => a.x), 30)
    colCenters = pickHeaviest(colGroups, expectedCols)
    if (colCenters.length < 2) colCenters = clusterValues(anchors.map((a) => a.x), tolerance)

    const rowCands = clusterValues(anchors.map((a) => a.y), 40)
    const seriesRows = pickRegularSeries(rowCands)
    rowCenters = seriesRows.length >= 2 ? seriesRows : rowCands
  } else {
    colCenters = clusterValues(anchors.map((a) => a.x), tolerance)
    rowCenters = clusterValues(anchors.map((a) => a.y), tolerance)
  }
  if (colCenters.length < 2 || rowCenters.length < 2) return null

  const { width: cw, height: ch, dx, dy } = spec
  const slots: CardSlot[] = []
  let index = 1
  for (let r = 0; r < rowCenters.length; r++) {
    for (let c = 0; c < colCenters.length; c++) {

      const colDx = colOffsets?.[c]?.dx ?? dx
      const colW = colOffsets?.[c]?.width ?? cw
      const x = clampRight
        ? Math.max(0, Math.min(imageWidth - colW, colCenters[c] + colDx))
        : Math.max(0, colCenters[c] + colDx)
      const y = clampRight
        ? Math.max(0, Math.min(imageHeight - ch, rowCenters[r] + dy))
        : Math.max(0, rowCenters[r] + dy)

      const w = clampRight ? colW : Math.max(1, Math.min(colW, imageWidth - x))
      const h = clampRight ? ch : Math.max(1, Math.min(ch, imageHeight - y))

      const rect: Rect = { x, y, w, h }
      slots.push({ index: index++, row: r + 1, col: c + 1, card: rect, text: rect })
    }
  }

  const colPitch = colCenters.length > 1 ? colCenters[1] - colCenters[0] : 0
  const rowPitch = rowCenters.length > 1 ? rowCenters[1] - rowCenters[0] : 0
  return {
    family,
    rows: rowCenters.length,
    cols: colCenters.length,
    rowPitch,
    colPitch,
    slots,

    confidence: Math.min(0.95, 0.5 + (anchors.length / (rowCenters.length * colCenters.length)) * 0.45),
    debug: {
      rowRuns: rowCenters.map((v) => [v, v] as [number, number]),
      colRuns: colCenters.map((v) => [v, v] as [number, number])
    }
  }
}

function tryTemplate(
  image: GrayImage,
  t: LayoutTemplate,
  rowProfile: number[],
  W: number,
  H: number,
  debug: GridDetection['debug'],
  extraRegions?: Record<string, { x: number; y: number; w: number; h: number }>
): GridDetection | null {
  const rowScore = scoreTemplate(rowProfile, t, H, 'y')
  if (rowScore < 0.45) return null

  const rowRuns = gridToRuns(
    {
      start: Math.round(t.firstRowY * H),
      pitch: Math.round(t.rowPitch * H) || 1,
      size: Math.round(t.rowHeight * H) || 1,
      cells: t.rows
    },
    H
  )
  const firstRow = rowRuns[0]
  if (!firstRow) return null

  const colProfile =
    t.projection === 'saturation'
      ? projectSaturation(image, 'x', 0, W - 1, [firstRow[0], firstRow[1]])
      : projectRatio(image, 'x', 0, W - 1, [firstRow[0], firstRow[1]])
  const colScore = scoreTemplate(colProfile, t, W, 'x')
  if (colScore < 0.45) return null

  const colRuns = gridToRuns(
    {
      start: Math.round(t.firstColX * W),
      pitch: Math.round(t.colPitch * W) || 1,
      size: Math.round(t.colWidth * W) || 1,
      cells: t.cols
    },
    W
  )
  if (colRuns.length < 3 || rowRuns.length < 3) return null

  debug.rowRuns = rowRuns
  debug.colRuns = colRuns
  return {
    family: t.family,
    rows: rowRuns.length,
    cols: colRuns.length,
    rowPitch: Math.round(t.rowPitch * H),
    colPitch: Math.round(t.colPitch * W),
    slots: assembleSlots(rowRuns, colRuns, extraRegions ?? t.extraRegions, t.textInset),
    confidence: Math.min(1, 0.5 + rowScore * 0.3 + colScore * 0.3),
    debug
  }
}

function buildExtra(
  card: Rect,
  regions: Record<string, { x: number; y: number; w: number; h: number }>
): Array<{ name: string; rect: Rect }> {
  return Object.entries(regions).map(([name, r]) => ({
    name,
    rect: {
      x: card.x + Math.round(card.w * r.x),
      y: card.y + Math.round(card.h * r.y),
      w: Math.max(1, Math.round(card.w * r.w)),
      h: Math.max(1, Math.round(card.h * r.h))
    }
  }))
}

function assembleSlots(
  rowRuns: Array<[number, number]>,
  colRuns: Array<[number, number]>,
  extra?: Record<string, { x: number; y: number; w: number; h: number }>,
  textInset = 0.02
): CardSlot[] {
  const slots: CardSlot[] = []
  let index = 1
  for (let r = 0; r < rowRuns.length; r++) {
    for (let c = 0; c < colRuns.length; c++) {
      const col = colRuns[c]
      const row = rowRuns[r]
      const card: Rect = { x: col[0], y: row[0], w: col[1] - col[0] + 1, h: row[1] - row[0] + 1 }

      const inset = Math.round(card.w * textInset)
      const text: Rect = { x: card.x + inset, y: card.y, w: card.w - inset, h: card.h }
      slots.push({ index: index++, row: r + 1, col: c + 1, card, text, ...(extra ? { extra: buildExtra(card, extra) } : {}) })
    }
  }
  return slots
}

function detectByFit(image: GrayImage, rowRatio: number[], debug: GridDetection['debug']): GridDetection {
  const { width: W, height: H } = image

  const rowFit = fitGrid(rowRatio, {
    minSize: 8,
    maxSize: Math.max(12, Math.round(H / 3)),
    maxCells: 60
  })
  debug.rowRuns = rowFit ? gridToRuns(rowFit, H) : []
  if (!rowFit || debug.rowRuns.length < 2) {
    return {
      family: 'generic-grid',
      rows: debug.rowRuns.length,
      cols: 0,
      rowPitch: rowFit?.pitch ?? 0,
      colPitch: 0,
      slots: [],
      confidence: 0,
      debug
    }
  }
  const rowPitch = rowFit.pitch
  const rowRuns = debug.rowRuns

  const firstRow = rowRuns[0]
  const colRatio = projectRatio(image, 'x', 0, W - 1, [firstRow[0], firstRow[1]])
  const colFit = fitGrid(colRatio, {
    minSize: 12,
    maxSize: Math.max(16, Math.round(W / 3)),
    maxCells: 40
  })
  debug.colRuns = colFit ? gridToRuns(colFit, W) : []
  if (!colFit || debug.colRuns.length < 2) {
    return {
      family: 'generic-grid',
      rows: rowRuns.length,
      cols: debug.colRuns.length,
      rowPitch,
      colPitch: colFit?.pitch ?? 0,
      slots: [],
      confidence: 0,
      debug
    }
  }

  let confidence = 0
  if (rowRuns.length >= 3 && debug.colRuns.length >= 3) {
    confidence = 0.5
    if (rowFit.score > 0.5 && colFit.score > 0.5) confidence += 0.1
  }

  return {
    family: 'generic-grid',
    rows: rowRuns.length,
    cols: debug.colRuns.length,
    rowPitch,
    colPitch: colFit.pitch,
    slots: assembleSlots(rowRuns, debug.colRuns),
    confidence: Math.min(1, confidence),
    debug
  }
}
