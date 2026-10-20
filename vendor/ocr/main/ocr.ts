/**
 * OCR 运行层（主进程侧）。
 *
 * 架构：
 *   主进程（解码图片、定位卡片网格、按卡片裁剪）
 *     → 隐藏的 worker 窗口（跑 WebGL 推理，返回文本块与坐标）
 *       → 主进程（解析 + 与定数表交叉校验）
 *
 * 为什么推理放在渲染进程而不是主进程：
 *   `@paddlejs/paddlejs-backend-webgl` 需要 WebGL 与 DOM，主进程没有。
 *   而原生方案（RapidOCR + onnxruntime-node）解包 257 MB 且要按 Electron ABI
 *   重编译，超出体积预算。渲染进程方案整包只多 11.4 MB（模型）+ 1.7 MB（库）。
 *
 * ⚠ 关键限制（实测得出）：**同一个 WebGL 上下文里第二次 init 会崩**
 *   （shader 创建返回 null → `setProgram` 报错）。所以：
 *   - worker 只初始化一次模型，之后复用；
 *   - 一旦任务失败，直接销毁并重建 worker 窗口，而不是重试。
 */

import * as electron from 'electron'
import { nativeImage, type BrowserWindow as BrowserWindowType, type NativeImage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { getOcrProfile, type OcrGameProfile } from '@shared/games/ocr-profiles'
import {
  detectCardGrid,
  gridFromAnchors,
  type GrayImage,
  type Rect
} from '@shared/ocr-layout'
import { parseCardItems, type CardOcrResult, type EntryCandidate, type OcrItem, type SheetOcrResult } from '@shared/ocr'
import {
  parseSettlementItems,
  type SettlementCandidate,
  type SettlementOcrResult
} from '@shared/ocr-settlement'
import { matchTitle, validateCandidate } from '@shared/ocr-validate'
import { assignTitlesGlobally, hasDistinctChartVariants } from '@shared/ocr-assign'
import {
  assignItemsToSlots,
  currentOcrEngine,
  titlesEngine,
  onnxExtractFromImage,
  onnxLinesFromFullImage,
  onnxTitleBands,
  takeBandDebug,
  stripRankTail,
  onnxRecognizeCrops
} from './ocr-engine'
import { loadTierTable, loadTierTableForGame } from './tiers'

const { BrowserWindow } = electron

/** 一次识别任务的结果 */
export interface OcrJobResult {
  ok: boolean
  items?: OcrItem[]
  error?: string
  ms?: number
}


let workerWindow: BrowserWindowType | null = null
/** 批次号：每次注入一批就 +1，worker 用它区分结果 */
let batchSeq = 0
let workerReady: Promise<void> | null = null
const pending = new Map<number, (result: OcrJobResult) => void>()

/** 诊断日志开关：设 BEST30_LOG_OCR=1 后在主进程 stdout 打印流程 */
const LOG = process.env.BEST30_LOG_OCR === '1'
function diag(msg: string): void {
  if (LOG) console.log(`[ocr] ${msg}`)
}

/** 并发保护：同一时刻只允许一个识别任务（worker 只有一个 WebGL 上下文） */
let busy = false

/** 供界面/诊断读取的当前状态 */
export function ocrRuntimeState(): {
  workerAlive: boolean
  ready: boolean
  busy: boolean
  pendingJobs: number
} {
  return {
    workerAlive: !!workerWindow && !workerWindow.isDestroyed(),
    ready: workerReady !== null,
    busy,
    pendingJobs: pending.size
  }
}

/** 判断环境（与主进程 index.ts 保持一致） */
function isDev(): boolean {
  return !!process.env.ELECTRON_RENDERER_URL
}

/** 创建/复用 worker 窗口 */
async function ensureWorker(): Promise<BrowserWindowType> {
  if (workerWindow && !workerWindow.isDestroyed()) {
    diag('复用已有 worker 窗口')
    return workerWindow
  }
  diag('创建 worker 窗口…')

  workerWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // 不用 transparent/offscreen：实测透明合成会走软件路径，
    // WebGL 可能退化甚至不可用，而 OCR 推理强依赖 WebGL。
    backgroundColor: '#0b0e17',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      /*
       * **给 worker 进程打标记**，让 preload 把它降到 `idle` 优先级。
       *
       * ## 为什么要降（用户反馈"玩游戏/看视频变卡"）
       *
       * 这个隐藏窗口跑 **WebGL 推理**——它是 CPU/GPU 占用的大头，
       * 而且 `backgroundThrottling: false` 让它**不受节流全速跑**。
       * 于是识别期间它与用户的游戏/视频**抢同一块 GPU 与 CPU**。
       *
       * 降到 `idle`：系统空闲时仍能用满算力（识别速度基本不变），
       * 有前台任务时**让路**。OCR 是后台批处理，不值得跟游戏抢。
       *
       * preload 读到这个参数后调用 `os.setPriority`
       * （见 `src/preload/index.ts` 的 `applyWorkerPriority`）。
       */
      additionalArguments: ['--best30-ocr-worker=low-priority']
    }
  })
  workerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const ready = new Promise<void>((resolve, reject) => {
    const wc = workerWindow!.webContents
    const timer = setTimeout(() => reject(new Error('OCR worker 加载超时')), 30000)
    const check = async (): Promise<void> => {
      try {
        const ok = await wc.executeJavaScript('window.__ocrReady === true')
        if (ok) {
          clearTimeout(timer)
          diag('worker 就绪（__ocrReady = true）')
          resolve()
          return
        }
      } catch {
        /* 页面还没加载完，继续等 */
      }
      setTimeout(() => void check(), 200)
    }
    wc.once('did-finish-load', () => void check())
    wc.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(timer)
      diag(`worker 加载失败：${code} ${desc}`)
      reject(new Error(`OCR worker 加载失败（${code} ${desc}）`))
    })
  })

  if (isDev()) {
    void workerWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL as string}/ocr-worker.html`)
  } else {
    void workerWindow.loadFile(join(__dirname, '../renderer/ocr-worker.html'))
  }

  workerWindow.on('closed', () => {
    workerWindow = null
    workerReady = null
  })

  workerReady = ready
  return workerWindow
}

/** 销毁 worker（上下文损坏时调用，下次会重建） */
function destroyWorker(): void {
  if (workerWindow && !workerWindow.isDestroyed()) {
    /*
     * **销毁前显式丢弃 WebGL 上下文**（实测内存修复）。
     *
     * 实测：只调 `destroy()` 时 worker 的 renderer 进程确实消失了，
     * 但 **Chromium 的 gpu 进程仍占着约 2.4GB**——PaddleJS 分配的
     * WebGL 纹理/缓冲没有随页面销毁而归还。
     *
     * `WEBGL_lose_context` 是标准扩展，用于**主动放弃**上下文，
     * 浏览器随后会释放它持有的 GPU 资源。销毁前调用一次，
     * 让释放路径明确走一遍。失败也不影响销毁本身。
     */
    try {
      const wc = workerWindow.webContents
      if (!wc.isDestroyed()) {
        void wc
          .executeJavaScript(
            '(() => { try { for (const c of document.querySelectorAll("canvas")) {' +
              ' const gl = c.getContext("webgl2") || c.getContext("webgl");' +
              ' const ext = gl && gl.getExtension && gl.getExtension("WEBGL_lose_context");' +
              ' if (ext) ext.loseContext(); } } catch (e) {} return true })()',
            true
          )
          .catch(() => undefined)
      }
    } catch {
      /* 忽略：销毁本身才是关键 */
    }
    workerWindow.destroy()
  }
  workerWindow = null
  workerReady = null
  /*
   * ⚠ **必须重置 `assetsInjected`**。
   *
   * 实测踩坑（2026-04）：加了"每批重建 worker"之后，识别结果从 50 格
   * 掉到只剩 3 格。原因是 `injectOcrAssets()` 开头有
   * `if (assetsInjected) return`——重建 worker 后这个标记仍是 `true`，
   * 于是**新 worker 根本没被注入模型资源**，后续批次只能拿到空结果
   * （流程照常报"完成"，所以很容易漏掉）。
   *
   * 销毁 worker 就等于"资源没了"，标记必须一起清掉。
   */
  assetsInjected = false
  for (const resolve of pending.values()) resolve({ ok: false, error: 'OCR worker 已重建' })
  pending.clear()
}

/** 注册 OCR worker 的结果回调（在主进程 index.ts 里调用一次） */
export function registerOcrResultHandler(): void {
  electron.ipcMain.on(IPC.ocrResult, (_e, payload: { id: number; ok: boolean; items?: OcrItem[]; error?: string; ms?: number }) => {
    diag(`收到回传 id=${payload?.id} ok=${payload?.ok}${payload?.error ? ' 错误=' + payload.error : ''}`)
    const resolve = pending.get(payload.id)
    if (resolve) {
      pending.delete(payload.id)
      resolve({ ok: payload.ok, items: payload.items, error: payload.error, ms: payload.ms })
    } else {
      diag(`回传 id=${payload?.id} 没有对应的等待者（可能是诊断 ping）`)
    }
  })
}

/** 模型与权重文件相对 `ocr-models/` 的路径 */
const OCR_MODEL_FILES = [
  'det/model.json',
  'det/chunk_1.dat',
  'rec/model.json',
  'rec/chunk_1.dat',
  'rec/chunk_2.dat',
  'ppocr_keys_v1.txt'
] as const

/** 定位模型目录（开发时在 src/renderer/public，打包后在 resources/app.asar/out/renderer） */
function ocrModelsDir(): string {
  // 打包后 __dirname 是 resources/app.asar/out/main
  const packaged = join(__dirname, '../renderer/ocr-models')
  if (existsSync(packaged)) return packaged
  // 开发时 __dirname 是 out/main（electron-vite 也是这个布局），回退到源码 public
  const dev = join(__dirname, '../../src/renderer/public/ocr-models')
  return dev
}

let assetsInjected = false

/**
 * 把模型文件注入 worker 页面。
 *
 * 为什么必须注入而不是让页面自己加载：打包后页面是 `file://` 协议，
 * paddlejs 内部的 `fetch()` 取 `file://` 会被拒绝
 * （实测 `TypeError: Failed to fetch`），识别永远不返回。
 * 主进程读出文件内容转成 data URL，页面侧改写 fetch 后用 data URL 命中。
 */
async function injectOcrAssets(win: BrowserWindowType): Promise<void> {
  if (assetsInjected) return
  const dir = ocrModelsDir()
  const files: Record<string, string> = {}
  for (const rel of OCR_MODEL_FILES) {
    const file = join(dir, rel)
    if (!existsSync(file)) throw new Error(`缺少 OCR 模型文件：${rel}（应在 ${dir}）`)
    const buf = readFileSync(file)
    const mime = rel.endsWith('.json')
      ? 'application/json'
      : rel.endsWith('.txt')
        ? 'text/plain'
        : 'application/octet-stream'
    files[rel] = `data:${mime};base64,${buf.toString('base64')}`
  }
  // 页面里 paddlejs 请求的是 `./ocr-models/xxx`（相对 worker 页面），所以要按这个基准登记
  const base = './ocr-models/'
  const count = await win.webContents.executeJavaScript(
    `window.__ocrRegisterAssets(${JSON.stringify(files)}, ${JSON.stringify(base)})`,
    true
  )
  diag(`已注入模型资源 ${count} 个（目录 ${dir}）`)
  const init = (await win.webContents.executeJavaScript('window.__ocrInit()', true)) as {
    ok: boolean
    error?: string
    ms?: number
    cached?: boolean
  }
  if (!init.ok) throw new Error(`模型初始化失败：${init.error ?? '未知'}`)
  diag(`模型初始化完成${init.cached ? '（复用缓存）' : ` ${init.ms}ms`}`)
  assetsInjected = true
}

/**
 * 单批载荷上限（字节）。
 *
 * ## 为什么从 1.5MB 降到 400KB（实测性能修复，2026-04）
 *
 * 实测**内存峰值与单批卡片数近似成正比**：
 * ```
 * 批次 1/4（15 张）→ gpu 进程涨到 5.7GB，系统可用内存掉到 1.3GB
 * 批次完成后       → 回落到 241MB
 * ```
 * 即 PaddleJS **每次 `recognize()` 都不释放中间张量/GL 对象**，
 * 单批内累积多少张就吃多少内存。所以**限制单批数量**是压低峰值的
 * 直接手段：15 张 → 约 4 张（每张 99KB），峰值应降到 GB 以下。
 *
 * ## 代价
 *
 * 批次变多（约 13 批），而每批要重建 worker 并重新加载模型
 * （实测模型初始化 4.8 秒）。总耗时增加约 1 分钟量级，
 * 换来的是**不再把系统内存吃到换页**——用户明确反馈过这个卡顿
 * 比识别慢更影响使用。
 */
const BATCH_BYTE_LIMIT = 400_000


/**
 * 把结算图的解析结果适配成分表解析器的候选形状。
 *
 * 为什么要转换：下层的交叉校验（`validateCandidate`）是按 `EntryCandidate`
 * 设计的，复用它就不必把"曲名模糊匹配 / 定数纠错 / 难度反推"再写一遍。
 * 结算图没有 PTT 字段，所以 `potential: null`，校验层会走"按定数反推难度"的路径。
 */
function settlementToEntryCandidate(c: SettlementCandidate): EntryCandidate {
  return {
    rank: null,
    title: c.title,
    score: c.score,
    scoreRaw: c.scoreRaw,
    constant: null,
    potential: null,
    grade: c.grade,
    chartLevel: null,
    faults: {
      far: c.faults.far,
      lost: c.faults.lost,
      ...(c.faults.good !== undefined ? { good: c.faults.good } : {}),
      ...(c.faults.bad !== undefined ? { bad: c.faults.bad } : {}),
      ...(c.faults.miss !== undefined ? { miss: c.faults.miss } : {})
    },
    accuracy: c.accuracy,
    confidence: c.confidence,
    sources: c.sources
  }
}

/**
 * 识别一张**单曲结算图**。
 *
 * 与分表长图的区别：结算图只有一张、文字大得多，检测模型不会把字缩糊，
 * 所以**整图一次识别**即可（实测 1280×960 约 12 秒），
 * 不需要网格定位与逐卡裁剪。
 */
export async function recognizeSettlement(
  filePath: string,
  gameId = 'arcaea'
): Promise<SettlementOcrResult> {
  const t0 = Date.now()
  diag(`开始识别结算图 ${filePath}`)
  if (!existsSync(filePath)) {
    return { ok: false, error: `找不到文件：${filePath}`, items: [], ms: 0 }
  }
  const rawImage = nativeImage.createFromBuffer(readFileSync(filePath))
  if (rawImage.isEmpty()) {
    return { ok: false, error: '图片解码失败（格式不支持或文件损坏）', items: [], ms: 0 }
  }
  /*
   * 同样限制长边（性能修复）。
   *
   * 结算图实测 1280×960，本来就低于 1200 长边时 `capForOcr` 会原样返回，
   * 所以**对现有素材无影响**；这一步是为了防止用户提供的大尺寸结算图
   * 再触发那个 5GB 峰值。
   *
   * 坐标一致性：`size` 与送识别的必须是同一张图（`parseSettlementItems`
   * 用 `imageHeight` 的**比例**定位曲名，所以尺寸不统一会直接错位）。
   */
  const image = capForOcr(rawImage)

  try {
    /*
     * **引擎分派**（迁移期，可回退）：ONNX 路径在主进程用 CPU 推理，
     * 不需要隐藏的 WebGL worker。PaddleJS 路径保持原样。
     * 详见 `src/main/ocr-engine.ts`。
     */
    if (currentOcrEngine() === 'onnx') {
      const items0 = await onnxExtractFromImage(image)
      const items1 = items0 as OcrItem[]
      diag(`结算图识别完成（ONNX）：${items1.length} 个文本块，耗时 ${Date.now() - t0}ms`)
      const { size: sz } = { size: image.getSize() }
      const candidate1 = parseSettlementItems(items1, { imageHeight: sz.height, gameId })
      const table1 = loadTierTable()
      const validation1 = validateCandidate(
        table1.table,
        settlementToEntryCandidate(candidate1),
        gameId
      )
      return { ok: true, candidate: candidate1, validation: validation1, items: items1, ms: Date.now() - t0 }
    }
    const win = await ensureWorker()
    if (workerReady) await workerReady
    await injectOcrAssets(win)

    /*
     * 结算图**不做放大**：实测原尺寸（1280×960）就已经能正确读出曲名、
     * 分数与判定；放大 2 倍反而更慢（50s vs 24s）且让各处坐标翻倍，
     * 曾因此与解析层的绝对阈值冲突导致曲名读空。
     */
    const size = image.getSize()
    const results = await recognizeBatch(win, (batchSeq += 1), [
      { index: 1, dataUrl: image.toDataURL() }
    ])
    const first = results[0]
    if (!first || !first.ok) {
      return { ok: false, error: first?.error ?? '识别失败', items: [], ms: Date.now() - t0 }
    }
    const items = first.items ?? []
    diag(`结算图识别完成：${items.length} 个文本块，耗时 ${Date.now() - t0}ms`)
    if (LOG) {
      for (const it of items) {
        diag(`  块 x=${it.x} y=${it.y} h=${it.h} ${JSON.stringify(it.text)}`)
      }
    }

    const candidate = parseSettlementItems(items, { imageHeight: size.height, gameId })
    const table = loadTierTable()
    const validation = validateCandidate(table.table, settlementToEntryCandidate(candidate), gameId)
    return { ok: true, candidate, validation, items, ms: Date.now() - t0 }
  } catch (error) {
    return { ok: false, error: String((error as Error).message), items: [], ms: Date.now() - t0 }
  } finally {
    /*
     * 同样要释放 worker：结算图虽然只有一张，但 PaddleJS 的张量
     * 一样会撑出 GB 级内存且不归还（详见 `recognizeSheet` 的说明）。
     */
    destroyWorker()
  }
}

/**
 * 让 worker 识别一批裁剪好的卡片图。
 *
 * 用"批"而不是"一次一张"：每次注入都要序列化整个载荷（几十上百 KB），
 * 攒成一批能显著减少往返。
 */
async function recognizeBatch(
  win: BrowserWindowType,
  batchId: number,
  crops: Array<{ index: number; dataUrl: string }>
): Promise<Array<{ index: number; ok: boolean; items?: OcrItem[]; error?: string }>> {
  const wc = win.webContents
  void wc
    .executeJavaScript(`window.__ocrRunBatch(${batchId}, ${JSON.stringify(crops)})`, true)
    .catch((error: Error) => diag(`批次 #${batchId} 注入失败：${error.message}`))

  const deadline = Date.now() + 300000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    let raw: unknown
    try {
      raw = await wc.executeJavaScript(
        `(function(){ var r = window.__ocrBatchResult; if (r && r.batchId === ${batchId}) { window.__ocrBatchResult = null; return r } return null })()`,
        true
      )
    } catch (error) {
      return crops.map((c) => ({ index: c.index, ok: false, error: `取回结果失败：${(error as Error).message}` }))
    }
    if (raw && typeof raw === 'object') {
      const payload = raw as { ok: boolean; results?: Array<{ index: number; ok: boolean; items?: OcrItem[]; error?: string }>; error?: string }
      if (!payload.ok && payload.error) {
        return crops.map((c) => ({ index: c.index, ok: false, error: payload.error }))
      }
      return payload.results ?? []
    }
  }
  destroyWorker()
  return crops.map((c) => ({ index: c.index, ok: false, error: 'OCR 识别超时' }))
}

/** nativeImage → 灰度图（感知亮度加权） */
function toGray(image: NativeImage): GrayImage {
  const size = image.getSize()
  const bmp = image.toBitmap() // BGRA
  const data = new Uint8Array(size.width * size.height)
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (bmp[p + 2] * 299 + bmp[p + 1] * 587 + bmp[p] * 114) / 1000
  }
  return { width: size.width, height: size.height, data }
}

/**
 * nativeImage → **色度图**（用于 Phigros 版式的网格检测）。
 *
 * 为什么要单独做一张：Phigros 长图的**背景是亮灰色、卡片是彩色**，
 * 两者亮度都在 20–100 之间，用亮度剖面根本分不出卡片在哪
 * （实测行/列检测全部失效）。改用"彩色程度"：
 *   饱和度 = max(R,G,B) − min(R,G,B)，灰背景接近 0、彩色卡片明显更高。
 *
 * 输出仍是单通道 `GrayImage`（255 = 明显彩色、0 = 灰），
 * 这样可以直接复用同一套亮度投影与模板算法。
 */
function toSaturationImage(image: NativeImage): GrayImage {
  const size = image.getSize()
  const bmp = image.toBitmap() // BGRA
  const data = new Uint8Array(size.width * size.height)
  /** 饱和度阈值：实测灰背景 <10、彩色卡片 40+，取 25 作分界 */
  const SAT_THRESHOLD = 25
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const b = bmp[p]
    const g = bmp[p + 1]
    const r = bmp[p + 2]
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    data[i] = sat > SAT_THRESHOLD ? 255 : 0
  }
  return { width: size.width, height: size.height, data }
}

/** 是否已认出「受支持的已知版式」（认出了就不必再走整图 OCR 锚点路径） */
function isKnownGridFamily(g: { family: string; slots?: Array<{ text: { w: number } }> }, profile: OcrGameProfile, width: number): boolean {
  if (g.family === profile.anchor?.family) return true
  if (!profile.templates.some((template) => template.family === g.family)) return false
  const minimum = profile.minimumTextWidth ?? 0
  const reference = profile.anchor?.referenceWidth ?? width
  return (g.slots?.[0]?.text.w ?? 0) >= minimum * width / reference
}

/**
 * 投影检测失败时，用分数块中心推导网格。
 * 字段格式、列数、卡片偏移由游戏配置提供，避免主流程增加游戏分支。
 */
async function gridFromOcrAnchors(
  win: BrowserWindowType,
  image: NativeImage,
  gameId: string
): Promise<ReturnType<typeof gridFromAnchors>> {
  // 调用者已经采样；识别、聚类和后续裁剪必须使用同一张图的坐标。
  const profile = getOcrProfile(gameId)
  if (!profile.anchor) return null
  const capped = image
  const size = capped.getSize()
  try {
    const t0 = Date.now()
    /*
     * 引擎分派：ONNX 路径直接在主进程识别整图（不需要 worker）。
     * 返回形状与 PaddleJS 的 `items` 一致，下面逻辑不用改。
     */
    const items =
      currentOcrEngine() === 'onnx'
        ? ((await onnxExtractFromImage(capped)) as OcrItem[])
        : ((await recognizeBatch(win, (batchSeq += 1), [{ index: 1, dataUrl: capped.toDataURL() }]))[0]
            ?.items ?? [])
    diag(`锚点法 整图 OCR（${currentOcrEngine()}）：${items.length} 个文本块，耗时 ${Date.now() - t0}ms`)
    // 分数格式来自配置，同时排除准确率文本，防止百分数成为网格锚点。
    const scoreRe = profile.scorePattern
    const anchors: Array<{ x: number; y: number }> = []
    for (const it of items) {
      const t = it.text.replace(/\s/g, '')
      if (!scoreRe.test(t)) continue
      if (/[%％]/.test(it.text)) continue
      // 用块中心作为锚点（x/y 是左上角）
      anchors.push({ x: it.x + Math.round(it.w / 2), y: it.y + Math.round(it.h / 2) })
    }
    diag(`锚点法 分数块锚点 ${anchors.length} 个`)
    /*
     * 诊断输出：把**原始锚点坐标**按 x 排序打印出来。
     * 目的是看清列聚类为什么选错——实测列中心出现 549/560（只差 11）这种
     * 本该合并成同一列的重复簇，需要知道是哪些 x 进了聚类。
     */
    {
      const xs = [...new Set(anchors.map((a) => a.x))].sort((a, b) => a - b)
      const counts = new Map<number, number>()
      for (const a of anchors) counts.set(a.x, (counts.get(a.x) ?? 0) + 1)
      diag(
        `锚点法 原始 x 值（值:个数）：${xs.map((x) => `${x}:${counts.get(x)}`).join(' ')}`
      )
      const ys = [...new Set(anchors.map((a) => a.y))].sort((a, b) => a - b)
      diag(`锚点法 原始 y 值 ${ys.length} 个：${ys.join(' ')}`)
    }
    if (anchors.length < 4) return null
    // 参考像素尺寸随采样比例缩放，避免长图被采样后仍使用原来的固定偏移。
    const anchor = profile.anchor
    const k = size.width / (anchor.referenceWidth ?? size.width)
    const scaledCard = { width: anchor.card.width * k, height: anchor.card.height * k, dx: anchor.card.dx * k, dy: anchor.card.dy * k }
    const offsets = anchor.columnOffsets?.map((offset) => ({
      ...(offset.dx === undefined ? {} : { dx: offset.dx * k }),
      ...(offset.width === undefined ? {} : { width: offset.width * k })
    }))
    return gridFromAnchors(anchors, size.width, size.height, 60 * k, scaledCard,
      anchor.family, anchor.columns, anchor.clampRight, offsets)
  } catch (error) {
    diag(`锚点法失败：${(error as Error).message}`)
    return null
  }
}

/**
 * **限制长边后再送识别**（性能修复，2026-04）。
 *
 * ## 为什么必须做（实测数据）
 *
 * 用户实测"用软件时连输入文字都卡"。逐进程监测发现：
 * ```
 *              识别前      识别中        系统可用内存
 * gpu 进程     128MB   →  5058MB   →   0.2GB（几乎耗尽）
 * ```
 * 即**单次识别把 GPU 进程撑到 5GB**，系统被迫换页（swap），
 * 于是全机变卡。我上一轮只修了"结束后不释放"，**没有解决峰值**——
 * 用户的实际体感问题依旧。
 *
 * ## 峰值来自哪里
 *
 * PaddleJS 的**检测模型**对整图推理，会为整图分配 Conv 特征图。
 * WebGL 纹理是 RGBA 且常按 float 存储，**比张量本身还大数倍**，
 * 而按原分辨率（实测素材 1755×1600 ~ 1920×1750）分配就会到 GB 级。
 *
 * ## 为什么限制到 1200 长边不损失精度
 *
 * PaddleJS 的检测模型输入本来就固定 **960×960**，喂更大的图**它自己也会缩**。
 * 所以先缩到长边 1200（仍在 960 之上，给检测留余量），
 * 结果与原来一致，但显存/内存占用按面积比例下降。
 * 卡片文字区仍会被 `cropAndUpscale` 放大 3 倍再识别，小字不会糊。
 */
function capForOcr(image: NativeImage, maxSide = 1200): NativeImage {
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= maxSide) return image
  const k = maxSide / longest
  const w = Math.max(1, Math.round(width * k))
  const h = Math.max(1, Math.round(height * k))
  diag(`下采样：${width}×${height} → ${w}×${h}（长边限制 ${maxSide}，降低显存峰值）`)
  return image.resize({ width: w, height: h, quality: 'good' })
}

/**
 * **把 OCR 行的坐标从一张图的坐标空间换算到另一张图**。
 *
 * ## 为什么必须有这一步（用户实测暴露的严重 bug）
 *
 * 用户的测试图暴露出"**曲名被配到别的格位**"：
 * ```
 * #13 应是 singularity      → 被配成 #28 的 Capella
 * #16 应是 Breach of faith  → 被配成 #17 的 DREAD AREA
 * #26 应是 Chronicle        → 被配成 #11 的 Crimson Throne
 * ```
 * 这些不是识别错误，而是**坐标空间混用**：
 *   - PaddleJS 的槽位（`finalGrid.slots[].text`）在下采样图上算
 *     （实测 1920×1750 → 1200×1094，比例 **0.625**）；
 *   - 我给 ONNX 的是**原图**，它返回的行坐标是原图坐标。
 *
 * 两者相差 1.6 倍，每行的 y 会偏约 60% —— 一行因此落进
 * **下方另一格**的范围，曲名就"跳格"了。这与用户描述的
 * "被读取成别格的曲名"完全吻合。
 *
 * @param items 在 `from` 图上量出的行
 * @param from  检测所用的图
 * @param to    槽位所在的图
 */
function scaleItemsToImage(
  items: OcrItem[],
  from: NativeImage,
  to: NativeImage
): OcrItem[] {
  const a = from.getSize()
  const b = to.getSize()
  if (a.width === b.width && a.height === b.height) return items
  /*
   * 用**两个方向比例的平均**作为统一缩放：两图是等比缩放关系
   * （`resize` 保持长宽比），取平均可减小四舍五入误差。
   */
  const kx = b.width / a.width
  const ky = b.height / a.height
  const k = (kx + ky) / 2
  diag(`坐标换算：${a.width}×${a.height} → ${b.width}×${b.height}（比例 ${k.toFixed(4)}）`)
  return items.map((it) => ({
    ...it,
    x: Math.round(it.x * k),
    y: Math.round(it.y * k),
    w: Math.max(1, Math.round(it.w * k)),
    h: Math.max(1, Math.round(it.h * k))
  }))
}

/**
 * 按矩形裁剪并放大。
 *
 * 放大是必要的：检测模型输入固定 960×960，卡片文字区很小（实测约 220×100），
 * 直接送进去相当于把很小的图再缩小，小字会糊掉。放大 3 倍后单卡识别
 * 实测能拿到正确的分数与 PTT。
 */
function cropAndUpscale(image: NativeImage, rect: Rect, scale = 3): string {
  const size = image.getSize()
  const x = Math.max(0, Math.min(size.width - 1, rect.x))
  const y = Math.max(0, Math.min(size.height - 1, rect.y))
  const w = Math.max(1, Math.min(size.width - x, rect.w))
  const h = Math.max(1, Math.min(size.height - y, rect.h))
  const cropped = image.crop({ x, y, width: w, height: h })
  const scaled = cropped.resize({ width: Math.round(w * scale), height: Math.round(h * scale), quality: 'best' })
  return scaled.toDataURL()
}

/** 将卡片文字区与卡外附加区域合并成一个裁剪框，保持同一 OCR 结果。 */
function cropRectWithExtras(slot: { text: Rect; extra?: Array<{ rect: Rect }> }): Rect {
  const rects = [slot.text, ...(slot.extra ?? []).map((item) => item.rect)]
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * 识别一张长分表。
 *
 * 流程：解码 → 网格定位 → 逐卡裁剪放大 → 送 worker 识别 → 解析候选。
 * 串行执行：worker 只有一个 WebGL 上下文，并发没有收益且更容易触发崩溃。
 */
/**
 * 识别一张长分表。
 *
 * 流程：解码 → 网格定位 → 逐卡裁剪放大 → 分批注入 worker 识别 → 解析 + 交叉校验。
 * 串行执行：worker 只有一个 WebGL 上下文，并发没有收益且更容易触发崩溃。
 *
 * `onProgress(done, total)`：`total` 在裁剪完成后就是**卡片总数**（准确），
 * 因为分批只是传输方式，用户关心的是"已识别多少张卡"。
 * `onStage` 用于阶段提示（模型初始化较慢，单独报出来避免用户以为卡死）。
 */
export async function recognizeSheet(
  filePath: string,
  hooks?: { onProgress?: (done: number, total: number) => void; onStage?: (stage: string) => void }
): Promise<SheetOcrResult> {
  /*
   * 并发保护：worker 只有一个 WebGL 上下文，两路识别同时跑会互相破坏
   * （实测表现为任务派发后 worker 永远收不到、界面一直转圈）。
   * 这里直接拒绝第二次调用，而不是排队——排队会让用户以为卡死。
   */
  if (busy) {
    return {
      ok: false,
      error: '已有识别任务在进行中，请等它完成后再试',
      family: '',
      rows: 0,
      cols: 0,
      confidence: 0,
      cards: [],
      ms: 0
    }
  }
  busy = true
  try {
    return await recognizeSheetInner(filePath, hooks)
  } finally {
    busy = false
    /*
     * **任务结束后必须销毁 worker 窗口**（实测性能修复，2026-04）。
     *
     * ## 问题（用户反馈"用软件时玩游戏/看视频会变卡"）
     *
     * 实测单次识别时各进程占用：
     * ```
     *              识别前      识别中        识别后
     * gpu 进程     133MB    →  4892MB   →   3300MB   ← 不释放！
     * 总内存       360MB    →  5410MB   →   3872MB
     * ```
     * 即 **3.4MP 的图会撑出约 4.9GB 的 GPU 进程内存**（PaddleJS 的
     * 中间张量放大量极大），而且**识别完成也不归还**——原来的代码只在
     * **任务失败**时才 `destroyWorker()`，成功路径的 `finally` 只清了 `busy`。
     *
     * 后果有两层：
     *   1. 识别期间抢占内存/GPU → 用户同时玩游戏、看视频就卡；
     *   2. 识别**结束后**仍占着 GB 级内存不放 → 平时也卡。
     *
     * ## 代价
     *
     * 下次识别要**重新加载模型**（`ensureWorker` 会重建）。
     * 实测模型加载在 1–2 秒量级，相对单次识别几十秒可以接受；
     * 而"结束就释放"能保证**不用软件时不占资源**——这正是用户要的。
     */
    destroyWorker()
  }
}

async function recognizeSheetInner(
  filePath: string,
  hooks?: { onProgress?: (done: number, total: number) => void; onStage?: (stage: string) => void }
): Promise<SheetOcrResult> {
  const gameId = 'arcaea'
  const knownDifficulty: string | undefined = undefined
  const onProgress = hooks?.onProgress
  const onStage = hooks?.onStage
  const t0 = Date.now()
  diag(`开始识别 ${filePath}`)
  if (!existsSync(filePath)) {
    return { ok: false, error: `找不到文件：${filePath}`, family: '', rows: 0, cols: 0, confidence: 0, cards: [], ms: 0 }
  }

  const rawImage = nativeImage.createFromBuffer(readFileSync(filePath))
  if (rawImage.isEmpty()) {
    return { ok: false, error: '图片解码失败（格式不支持或文件损坏）', family: '', rows: 0, cols: 0, confidence: 0, cards: [], ms: 0 }
  }
  /*
   * **整条分表流程统一用缩放后的图**（性能修复 + 坐标一致性）。
   *
   * ## 性能
   *
   * 实测原分辨率（1755×1600 ~ 1920×1750）会让 PaddleJS 的检测阶段
   * 把 GPU 进程撑到 **5GB**、系统可用内存掉到 0.2GB，全机换页卡顿。
   * 检测模型输入本来就固定 960×960，先缩到长边 1200 不损失精度
   * （卡片文字区仍会放大 3 倍再识别）。
   *
   * ## 坐标一致性（**这是必须统一的另一个原因**）
   *
   * 锚点法（`gridFromOcrAnchors`）的网格坐标来自**它送识别的那张图**。
   * 若裁剪时改用另一张不同尺寸的图，`slot.text` 就会**整体错位**
   * （实测素材 1920 → 1200 差 1.6 倍，裁剪会裁到完全错误的位置）。
   * 所以 detection / anchors / 裁剪**全部只用这一个 `image`**。
   *
   * ⚠ 但**ONNX 引擎不需要这个下采样**（2026-04 修正）：
   * 它是纯 CPU 推理，没有显存问题，而下采样会让卡片文字变小、
   * 数字出现系统性误读——实测把 `09'967'750` 读成 `10067750`
   * （`9`→`0`、`8`→`6`、`G`→`C`），于是**分数只剩 3/50、PTT 0/50**。
   * 所以只在 PaddleJS 路径下采样（那才是为显存加的）。
   */
  const rawImageForLines = rawImage
  /*
   * ⚠ **PaddleJS 路径保持基线行为**（`capForOcr` 下采样）。
   *
   * 我一度把这里改成无条件下采样，导致卡片 slot 从 232×100 变成 145×62、
   * 卡片内文字更小，**PTT 从 50 掉到 24**。所以这里必须按引擎区分：
   *   - PaddleJS：下采样（那是为它的 WebGL 显存加的，且基线就是这么做）
   *   - ONNX：不下采样（纯 CPU 无显存压力，全分辨率对识别更好）
   */
  const image = currentOcrEngine() === 'onnx' ? rawImage : capForOcr(rawImage)

  /*
   * 同时准备两种图：
   *   - 亮度图：Arcaea（深背景 + 浅色卡片）用它；
   *   - 色度图：Phigros（亮灰背景 + 彩色卡片）必须用它。
   * detectCardGrid 会依次尝试两套模板，各自配对的剖面见 ocr-layout.ts。
   */
  const grayImage = toGray(image)
  const satImage = toSaturationImage(image)
  const profile = getOcrProfile(gameId)
  const grid = detectCardGrid(grayImage, satImage, [profile])

  if (onStage) onStage('正在准备 OCR 模型…')
  /*
   * **只有 PaddleJS 引擎才需要 worker 窗口**。
   *
   * ⚠ 实测踩坑：这里原本**无条件** `ensureWorker()`，于是即使
   * `BEST30_OCR_ENGINE=onnx`，隐藏的 WebGL worker 照样被创建、
   * 模型照样加载——`gpu` 进程依旧涨到 4.6GB，
   * 而我的分派检查在**批次循环里**（太晚）。日志表现为
   * "引擎 = onnx" 之后仍然 `创建 worker 窗口…`。
   *
   * 所以分派必须在**最前面**：ONNX 路径完全不需要 worker。
   */
  const engine = currentOcrEngine()
  /*
   * ⚠ worker 的创建条件是"**任一**需要它的路径被启用"：
   *   - 主引擎是 PaddleJS（它必须用 WebGL worker）
   *   - 或者启用了 ONNX 曲名增强（PaddleJS 仍跑全程，所以也要 worker）
   */
  const needWorker = engine === 'paddlejs' || titlesEngine() === 'onnx'
  let win: BrowserWindowType | null = null
  if (needWorker) {
    win = await ensureWorker()
    if (workerReady) await workerReady
    await injectOcrAssets(win)
  } else {
    diag('使用 ONNX 引擎：跳过 WebGL worker（无 GPU 占用）')
  }
  if (onStage) onStage('模型就绪，开始识别…')

  diag(`网格检测：版式=${grid.family} ${grid.rows}行×${grid.cols}列 置信度=${grid.confidence.toFixed(2)} 格位=${grid.slots.length}`)

  /*
   * 版式 B（Arcaea「不同样式」B30）：像素投影全失效
   * （半透明紫卡片 vs 紫背景，实测亮度/白字/暗块/周期折叠四种手段都不行），
   * 所以改用**整图 OCR 的分数块当锚点**推网格。
   *
   * 代价说明：整图 OCR 实测约 39 秒（1800×2092 得到 119 个文本块），
   * 比分表逐卡识别的总耗时（3–5 分钟）小得多，可以接受。
   * 只在常规检测没认出已知版式时才走这条，避免拖慢已经能用的图。
   */
  let finalGrid = grid
  if (!isKnownGridFamily(grid, profile, image.getSize().width)) {
    if (onStage) onStage('正在分析版式（这一版式需要先整图识别一次）…')
    const anchorGrid = await gridFromOcrAnchors(win as BrowserWindowType, image, gameId)
    /*
     * ⚠ 判据不能用"格位更多"。
     *
     * 实测踩坑：Phigros 的通用检测与锚点法**都给 12×3 = 36 格**，
     * 于是"更多才替换"永远不成立，锚点法算完却被丢弃，
     * 日志显示锚点法成功（35 个锚点）而最终网格仍是通用检测的窄框。
     *
     * 正确的判据是：**锚点法只要成功推出网格就采用**——
     * 因为走到这里说明通用检测已被 `isKnownGridFamily` 判为不可信
     * （对 Phigros 而言就是"裁剪过窄、会漏掉左下角难度/定数色块"）。
     */
    if (anchorGrid) {
      diag(
        `改用整图 OCR 锚点网格：${anchorGrid.family} ${anchorGrid.rows}行×${anchorGrid.cols}列 置信度=${anchorGrid.confidence.toFixed(2)} 格位=${anchorGrid.slots.length}`
      )
      /*
       * 诊断：打印**最终采用的列/行中心**与第一行的裁剪左缘。
       * 只打印原始锚点列表不够——中间还经过聚类与"取最重的 N 簇"，
       * 必须看到它们的输出才能回答"为什么是 560 而不是 946"。
       */
      diag(`锚点法 采用列中心：${anchorGrid.debug.colRuns.map((r) => r[0]).join(' ')}`)
      diag(`锚点法 采用行中心：${anchorGrid.debug.rowRuns.map((r) => r[0]).join(' ')}`)
      finalGrid = anchorGrid
    }
  }
  diag(
    `最终网格：版式=${finalGrid.family} ${finalGrid.rows}行×${finalGrid.cols}列 置信度=${finalGrid.confidence.toFixed(2)} 格位=${finalGrid.slots.length}`
  )

  /*
   * 网格合理性校验——**这是防止"静默给出垃圾结果"的关键一道防线**。
   *
   * 实测三种情况都必须拦下：
   *   ① `arcaea分表04-不同样式.png`（另一种 Arcaea B30 版式，5 列 × 6 行）
   *      → 兜底判成 `7 行 × 0 列`、置信度 0.00；
   *   ② 同一张图在改动过程中还出现过 `33 行 × 5 列 = 165 格` 的**部分误检**——
   *      格位数不为 0，会被当成正常结果继续裁剪识别，最终给用户一堆垃圾条目；
   *   ③ `phirgos分表01.jpg`（Phigros 版式还没适配稳）
   *      → 兜底判成 `10 行 × 4 列`、置信度 0.50，而真实是 3 列。
   *
   * 判据：
   *   - 必须至少 2 列（1 列不可能是分表）；
   *   - 已知模板（Arcaea / Phigros / 锚点网格）置信度要 ≥ 0.5；
   *   - 兜底路径（generic-grid）置信度要 ≥ 0.6，否则一律报"版式未适配"。
   */
  const knownFamily = finalGrid.family === 'arcaea-player-bests'
  const tooFewCols = finalGrid.cols < 2
  const lowConfidence =
    knownFamily ? finalGrid.confidence < 0.5 : finalGrid.confidence < 0.6
  if (finalGrid.slots.length === 0 || tooFewCols || lowConfidence) {
    const why =
      finalGrid.slots.length === 0
        ? '没有检测到卡片网格'
        : tooFewCols
          ? `只检测到 ${finalGrid.cols} 列，不像是分表`
          : `兜底路径置信度只有 ${finalGrid.confidence.toFixed(2)}，结果不可靠`
    return {
      ok: false,
      error: `${why}（版式 ${finalGrid.family}，${finalGrid.rows} 行 × ${finalGrid.cols} 列）。当前版本仅支持 Arcaea「Player Bests」版式 A，请更换截图。`,
      family: finalGrid.family,
      rows: finalGrid.rows,
      cols: finalGrid.cols,
      confidence: finalGrid.confidence,
      cards: [],
      ms: Date.now() - t0
    }
  }

  // 逐卡裁剪（含放大），按字节上限攒批
  const crops = finalGrid.slots.map((slot) => ({
    index: slot.index,
    dataUrl: cropAndUpscale(image, cropRectWithExtras(slot))
  }))
  diag(`已裁剪 ${crops.length} 张卡片（每张约 ${(crops[0].dataUrl.length / 1024).toFixed(0)} KB）`)
  // 裁剪完成后卡片总数就已知，先报一次让进度条有准确分母
  if (onProgress) onProgress(0, crops.length)

  /*
   * 定数表用于交叉校验（缺失时也能识别，只是无法纠错）。
   *
   * ⚠ **按游戏加载**（用户要求"定数表也进行拆分避免混淆"）。
   *
   * 旧版本曾从合并的 `tiers.json` 读取多游戏数据；当前只加载 Arcaea。
   * 虽然匹配层有 `entry.game !== gameId` 的过滤、不会真的串味，
   * 但**把另一个游戏的几百条带进内存与日志本身就没有意义**，
   * 而且随着接入更多音游会越来越难维护。
   *
   * `loadTierTableForGame` 首次调用时会把这一个游戏的条目
   * 从合并文件拆到 `<userData>/tiers/<gameId>.json`（自动迁移，不丢数据）。
   */
  const table = loadTierTableForGame(gameId)
  diag(
    `交叉校验用的定数表：${gameId} ${table.table.entries.length} 首，告警 ${table.warnings.length} 条` +
      (table.warnings.length ? `（${table.warnings.join('；')}）` : '')
  )

  const batches: Array<Array<{ index: number; dataUrl: string }>> = []
  let current: Array<{ index: number; dataUrl: string }> = []
  let bytes = 0
  for (const crop of crops) {
    if (current.length > 0 && bytes + crop.dataUrl.length > BATCH_BYTE_LIMIT) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(crop)
    bytes += crop.dataUrl.length
  }
  if (current.length > 0) batches.push(current)
  diag(`分为 ${batches.length} 批（上限 ${(BATCH_BYTE_LIMIT / 1024).toFixed(0)} KB/批）`)

  const byIndex = new Map<number, { ok: boolean; items?: OcrItem[]; error?: string }>()
  let done = 0
  /*
   * **ONNX 的整图分行路径**（2026-04，效果优于"卡片内部分行"）。
   *
   * 在这里插入而不是改批次循环结构，是为了**最小侵入**：只要把
   * `byIndex` 填好，后面的逐卡解析逻辑完全不用动。
   *
   * ## 为什么这条路径更好（实测对比）
   *
   * | 行从哪来 | 分数行 | Potential 行 |
   * |---|---|---|
   * | 卡片 slot（232×100）内部分行 | 31/50 | **0/50**（`tental95>115388H(`）|
   * | **整图分行后按位置归属** | **45/50** | **28/50**（`Potential95>115388HC`）|
   *
   * 卡片的 slot 太小（232×100 要装下曲名/分数/Potential 三行），
   * 而整图分行时每行都是全分辨率，识别质量完全不同。
   */
  if (currentOcrEngine() === 'onnx') {
    if (onStage) onStage('正在整图分行识别（ONNX）…')
    const lines = await onnxLinesFromFullImage(image)
    diag(`整图分行：${lines.length} 行（坐标基准 ${image.getSize().width}×${image.getSize().height}）`)
    const bySlot = assignItemsToSlots(
      lines,
      finalGrid.slots.map((s) => ({ rect: s.text }))
    )
    for (let i = 0; i < finalGrid.slots.length; i++) {
      const slot = finalGrid.slots[i]
      byIndex.set(slot.index, { ok: true, items: bySlot.get(i) ?? [] })
    }
    if (onProgress) onProgress(finalGrid.slots.length, finalGrid.slots.length)
  }
  for (let b = 0; b < batches.length && currentOcrEngine() !== 'onnx'; b++) {
    /*
     * **每批之后销毁并重建 worker**（实测性能修复，2026-04）。
     *
     * ## 为什么必须这样
     *
     * 实测识别期间 `gpu` 进程内存随批次**持续累积**：
     * ```
     * T+ 15s  4808MB    批次 1/4 刚开始
     * T+ 90s  5299MB
     * T+150s  5576MB    ← 线性增长，不回落
     * ```
     * 而**每张裁剪图只有 99KB**（日志已确认），所以峰值**与图片大小无关**
     * ——是 **PaddleJS 每次推理后不释放中间张量/GL 对象**，多次累积到 GB 级。
     *
     * 我先试过"限制整图长边到 1200"（日志确认生效：1755×1600 → 1200×1094），
     * 但峰值**没有下降**——这进一步证明问题在"逐次推理的累积"，
     * 而不是单次输入的大小。
     *
     * PaddleJS 也没有公开的释放接口（在 `@paddlejs/*` 里搜
     * `dispose` / `releaseMemory` / `clearCache` 均无可用 API）。
     *
     * 所以唯一可靠的办法是**销毁整个 WebGL 上下文**，让浏览器回收全部 GL 资源。
     * 代价是每批重新加载模型（1–2 秒），相对单次识别几十秒可以接受，
     * 换来的是**峰值被限制在单批之内**。
     */
    if (b > 0 && currentOcrEngine() !== 'onnx') {
      destroyWorker()
      win = await ensureWorker()
      if (workerReady) await workerReady
      await injectOcrAssets(win)
      diag(`批次 ${b + 1} 前已重建 worker（释放上一批的 GL 资源）`)
    }
    /*
     * 引擎分派：ONNX 路径在主进程跑（无 WebGL，所以不需要
     * "每批重建 worker"那套补偿措施）。
     */
    const results =
      currentOcrEngine() === 'onnx'
        ? await onnxRecognizeCrops(batches[b])
        : await recognizeBatch(win as BrowserWindowType, b + 1, batches[b])
    for (const r of results) byIndex.set(r.index, r)
    done += results.length
    if (onProgress) onProgress(done, crops.length)
    diag(`批次 ${b + 1}/${batches.length} 完成（累计 ${done}/${crops.length}）`)
  }
  // 批次全部结束后也释放一次，避免识别完仍占着 GB 级内存
  if (currentOcrEngine() !== 'onnx') destroyWorker()

  /*
   * ==========================================================================
   * **曲名增强：PaddleJS 为主 + ONNX 补曲名**（2026-04，"各取其长"方案）
   *
   * ## ⚠ **坐标系必须统一**（用户实测暴露的严重 bug）
   *
   * 用户的测试图暴露出"**曲名被配到别的格位**"：
   * ```
   * #13 应是 singularity → 被配成 #28 的 Capella
   * #16 应是 Breach of faith → 被配成 #17 的 DREAD AREA
   * #26 应是 Chronicle → 被配成 #11 的 Crimson Throne
   * ```
   * 根因是**两个坐标空间混用**：
   *   - PaddleJS 的槽位（`finalGrid.slots[].text`）是在**下采样图**
   *     上算的（`capForOcr` 把 1920→1200，比例 0.625）；
   *   - 我给 ONNX 的若是**原图**，它返回的行坐标就是原图坐标。
   *
   * 两者相差 1.6 倍，于是每行的 y 都偏了约 60%，一行会被算进
   * **下方另一格**的范围 → 系统性错配。
   *
   * 修法：**把 ONNX 的行换算到槽位所在的坐标空间**再分派
   * （见下方 `scaleItems`）。
   * ==========================================================================
   */
  const extraTitles = new Map<number, string[]>()
  /* PTT 补读得到的 Potential 行文本（按格） */
  const potExtra = new Map<number, string[]>()
  /* 独立定数带得到的候选文本（不混入整卡 OCR） */
  const constantExtra = new Map<number, string[]>()
  // 已配置隔离判定字段的版式始终禁用整行回退，包括模型缺失或增强关闭时。
  const faultExtra = new Map<number, string[]>()
  if (profile.fields) {
    for (const slot of finalGrid.slots) faultExtra.set(slot.index, [])
  }
  if (titlesEngine() === 'onnx') {
    try {
      if (onStage) onStage('正在用 ONNX 补充分表曲名…')
      /*
       * ⚠ **换算坐标系**：ONNX 在 `rawImageForLines`（原图）上检测，
       * 而槽位在 `image`（可能已下采样）上算。两者尺寸不同时必须缩放，
       * 否则曲名会被系统性地配到**下方另一格**（用户实测暴露的 bug）。
       */
      const linesOnRaw = await onnxLinesFromFullImage(rawImageForLines)
      const lines = scaleItemsToImage(linesOnRaw, rawImageForLines, image)
      const bySlot = assignItemsToSlots(
        lines,
        finalGrid.slots.map((s) => ({ rect: s.text }))
      )
      /**
       * 是否"纯曲名块"（**一个数字都不许有**）。
       *
       * ## ⚠ 这里必须极严（第一版放松了，结果反而变差）
       *
       * 第一版只要求"字母 ≥3 且没有 6 位以上连续数字"。结果 ONNX 把
       * **Potential 行切成的碎片**也混了进来：
       * ```
       * #7 块: "OTENTIAL10.111.3" | "2TA"     ← 完整的 10.1113 被切成两块
       * ```
       * 这些**残缺数字块**污染了候选池，使 PaddleJS 原本正确的
       * `extractPotential` 读数被挤掉 → **PTT 从 50 掉到 24**。
       *
       * 而我们要 ONNX 补的**只是曲名**，曲名永远不会含数字，
       * 所以判据收紧到"**不含任何阿拉伯数字**"即可干净地把数字类碎片挡掉。
       */
      const looksLikeTitle = (t: string): boolean => {
        if (/\d/.test(t)) return false
        const letters = (t.match(/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/g) || []).length
        return letters >= 3
      }
      /**
       * ⚠ **ONNX 的块必须与 PaddleJS 的块分开解析**（实测踩坑）。
       *
       * 第一版我把 ONNX 块直接 `push` 进 PaddleJS 的 items，
       * 结果 **PTT 从 50 掉到 24**。原因不在文本，而在**坐标**：
       * 解析器开头有 `mergeLineFragments(items)`，它按 y 坐标把
       * "同一行横向相邻的碎片"合并。两个引擎的坐标系不同
       * （ONNX 用全分辨率整图坐标，PaddleJS 用卡片裁剪内坐标），
       * 混在一起就产生**错误合并与错误丢弃**。
       *
       * 所以这里改成：
       *   1. ONNX 的**曲名**单独解析，只取它的曲名结果；
       *   2. 分数/PTT/定数/难度**全部保持来自 PaddleJS**（不动它的坐标体系）。
       *
       * 这样"各取其长"是真正隔离的——ONNX 只贡献它更强的那一项。
       */
      let added = 0
      for (let i = 0; i < finalGrid.slots.length; i++) {
        const slot = finalGrid.slots[i]
        const extra = (bySlot.get(i) ?? []).filter((it) => looksLikeTitle(it.text))
        if (extra.length === 0) continue
        /*
         * 把 ONNX 的曲名文本记到 `extraTitleTexts` 里，
         * 稍后在逐卡解析时通过 `parseCardItems` 的第 6 个参数注入。
         *
         * ⚠ **不能直接 `entry.items.push(...)`**：两个引擎坐标系不同，
         * 混进 items 会被解析器开头的 `mergeLineFragments` 错误合并
         * —— 实测这样会让 **PTT 从 50 掉到 24**。
         */
        if (!extraTitles.has(slot.index)) extraTitles.set(slot.index, [])
        extraTitles.get(slot.index)!.push(...extra.map((it) => it.text))
        added++
      }
      diag(`ONNX 曲名增强：整图 ${lines.length} 行，为 ${added} 张卡提供备选曲名`)
    } catch (error) {
      // 增强失败不能影响主流程（PaddleJS 的结果仍然可用）
      diag(`ONNX 曲名增强失败（已忽略）：${(error as Error).message}`)
    }
  }

  // 在原图上按相对字段位置裁带，补足检测器漏掉的曲名和小字。
  // 曲名原文与去位次尾部的形式都参与匹配，避免剥尾误删合法数字。
  // ONNX 主流程也需要运行独立的日文标题模型。`titlesEngine()` 在
  // ONNX 主流程中会返回 off（避免重复），但它会把假名曲名补读一起关掉；
  // 这里按实际能力单独判断，数字字段仍沿用主流程结果。
  const titleEnhanceEnabled = currentOcrEngine() === 'onnx' || titlesEngine() === 'onnx'
  if (titleEnhanceEnabled && profile.fields) {
    try {
      /*
       * ⚠ `CardSlot` 的几何存在 `text` 字段里（历史命名），不是 `rect`，
       * 所以这里手动映射一次。
       */
      const sourceSize = image.getSize()
      const targetSize = rawImageForLines.getSize()
      const activeFields = profile.fieldsByFamily?.[finalGrid.family] ?? profile.fields
      const bands = await onnxTitleBands(
        rawImageForLines,
        finalGrid.slots.map((slot) => ({ index: slot.index, rect: {
          x: slot.text.x * targetSize.width / sourceSize.width,
          y: slot.text.y * targetSize.height / sourceSize.height,
          w: slot.text.w * targetSize.width / sourceSize.width,
          h: slot.text.h * targetSize.height / sourceSize.height
        } })),
        /*
         * **按检测到的版式族选字段表**。
         *
         * Arcaea 的两条查分途径卡片样式差别很大（第三方 bot 是横卡、
         * 官方订阅是竖卡），字段在卡内的相对位置完全不同，
         * 共用一张表必然裁错。查不到覆盖项时回落 `profile.fields`，
         * 行为与改动前完全一致。
         */
        activeFields
      )
      let n = 0
      let nPot = 0
      for (const [slotIndex, band] of bands) {
        // ---- 曲名：原文与"剥掉位次尾部"两种形式都作为候选 ----
        if (!extraTitles.has(slotIndex)) extraTitles.set(slotIndex, [])
        const arr = extraTitles.get(slotIndex)!
        for (const cand of band.titles.flatMap((text) => [text, stripRankTail(text)])) {
          if (cand && (cand.length >= 3 || /[\u3040-\u30ff\u3400-\u9fff]{2}/u.test(cand)) && !arr.includes(cand)) arr.push(cand)
        }
        // ---- PTT：同样按几何读，避免跨格取到邻卡的值 ----
        if (band.potential || band.potentialTexts.length > 0) {
          if (!potExtra.has(slotIndex)) potExtra.set(slotIndex, [])
          const parr = potExtra.get(slotIndex)!
          for (const text of band.potentialTexts.length > 0 ? band.potentialTexts : [band.potential]) {
            if (text && !parr.includes(text)) parr.push(text)
          }
          nPot++
        }
        // ---- 定数：独立几何带优先于整卡文本，避免 PTT 粘连污染 ----
        if (band.constant || band.constantTexts.length > 0) {
          if (!constantExtra.has(slotIndex)) constantExtra.set(slotIndex, [])
          const carr = constantExtra.get(slotIndex)!
          for (const text of band.constantTexts.length > 0 ? band.constantTexts : [band.constant]) {
            if (text && !carr.includes(text)) carr.push(text)
          }
        }
        // ---- 判定数（F/L）：右边界已收窄，时间标在带外 ----
        if (band.faults) {
          if (!faultExtra.has(slotIndex)) faultExtra.set(slotIndex, [])
          const farr = faultExtra.get(slotIndex)!
          if (!farr.includes(band.faults)) farr.push(band.faults)
        }
        n++
      }
      diag(`几何带：曲名 ${n} 格、PTT ${nPot} 格（按 slot 几何直读，无跨格归属）`)
    } catch (error) {
      diag(`几何曲名带失败（已忽略）：${(error as Error).message}`)
    }
  }

  /*
   * ==========================================================================
   * ⚠ **已移除"跨格归属的 PTT 补读"**（2026-04，用户实测反馈驱动）
   * ==========================================================================
   *
   * ## 为什么移除（实测证据）
   *
   * 用户实测时报告：**11 格的 PTT 是"周围另一张卡的值"**，并给出了对应关系
   * （#1→#6、#9→#4、#16→#11、#28→#23、#42→#37…），**偏移基本恒为 ±5**。
   *
   * 我按他给的清单核对了 dump，发现**有 4 对完全相同的 PTT 值**：
   * ```
   * #9  PTT=11.8342    #4  PTT=11.8342
   * #16 PTT=11.5377    #11 PTT=11.5377
   * #28 PTT=11.41651   #23 PTT=11.41651
   * #42 PTT=11.3212    #37 PTT=11.3212
   * ```
   * 同一张卡不会有两条相同的 Potential，所以这是**同一行被多个格子
   * 重复取用**——正是原先那套"整图分行 → `assignItemsToSlots` 归属"
   * 造成的：这个图上的 slot 几何（145×62、行距正好 62）与真实卡位
   * 严重不符，归属必然出错。
   *
   * ## 现在的做法
   *
   * **不再做跨格归属**。PTT 的两个来源都改成"**每格只读自己的**"：
   *   1. PaddleJS 的**逐卡裁剪识别**（每格的裁剪本来只含这一张卡，
   *      天然没有跨格问题）——这是主力；
   *   2. **几何 PTT 带**（`onnxTitleBands` 里按 `slot.rect` 直接读，
   *      见上文的"几何带"一节）——只补 PaddleJS 没读出的格子。
   *
   * 这样"同一行被多格取用"在原理上就不可能出现。
   */


  /*
   * 版式 B（锚点网格）的卡面 PTT 只显示 2 位小数（如 `12.39`），
   * 而版式 A 同时有 3/4 位（`11.418` / `12.4924`）。默认的 4 位口径会让版式 B
   * 的 PTT 一个都读不到（实测 30 格全 null），所以按版式传不同的最少小数位要求。
   * 提到循环外是因为**第二遍的联合分配**也要用它重跑校验。
   */
  const activeFields = profile.fieldsByFamily?.[finalGrid.family] ?? profile.fields
  const minPotentialDecimals = activeFields?.potential.potentialDecimals ?? 4

  const cards: CardOcrResult[] = finalGrid.slots.map((slot) => {
    const r = byIndex.get(slot.index)
    const items = r?.items ?? []
    /*
     * 注入曲名打分函数，启用"多块拼接择优"。
     * Phigros 的曲名常被 OCR 切成多块（`ethe` + `Miserable`），
     * 只取单块匹配不上；实测这样能把曲名匹配率从 17/36 提到 21/36。
     */
    const candidate = parseCardItems(
      items,
      gameId,
      (t) => matchTitle(table.table, t, gameId).score,
      minPotentialDecimals,
      /*
       * 第 6 个参数：ONNX 曲名增强提供的**额外曲名候选**（纯文本）。
       *
       * 走这个通道而不是塞进 `items`，是因为两个引擎坐标系不同，
       * 混进 items 会被 `mergeLineFragments` 错误合并（实测 PTT 会从
       * 50 掉到 24）。分数/PTT 等数字字段仍完全来自 PaddleJS。
       */
      extraTitles.get(slot.index),
      /*
       * 第 7 个参数：**PTT 定向补读**得到的 Potential 行文本。
       *
       * 与曲名增强同理，走"纯文本注入"通道（不进坐标体系）。
       * 这些文本来自 ONNX v5，而 v5 的优势正是"能读对小数点"——
       * PaddleJS 在这些格子上丢了小数点，所以 `extractPotential`
       * （要求的最少小数位取决于版式）解不出来。
       *
       * ⚠ 只注入 **Potential 行**：分数/曲名/定数仍完全来自 PaddleJS，
       * 因为实测那些字段 PaddleJS 明显更好（分数 50 vs 23）。
       */
      potExtra.get(slot.index),
      /*
       * 第 8 个参数：**判定带**（F/L）的文本。
       *
       * 由 `onnxTitleBands` 按几何裁一条**右边界收窄到 0.85** 的带单独识别，
       * 目的是把右下角的"最后更新时间"（`17d` / `9h`）挡在带外——
       * 否则整行识别会得到 `L:39h`，而 `L:3`+`9h` 与 `L:39`+`h`
       * 在字符串上无法区分（用户实测反馈）。
       */
      faultExtra.get(slot.index),
      constantExtra.get(slot.index)
    )
    // 与定数表交叉校验：这是"OCR 提示 + 人工复核"能用的关键一步
    // 比对容差也按卡面显示精度走（版式 B 是 2 位，见 validateCandidate 注释）
    const validation = validateCandidate(
      table.table,
      candidate,
      gameId,
      knownDifficulty,
      minPotentialDecimals
    )
    return {
      index: slot.index,
      row: slot.row,
      col: slot.col,
      rect: slot.text,
      items,
      candidate,
      validation,
      ...(r && !r.ok ? { error: r.error ?? '识别失败' } : {})
    }
  })

  /*
   * ---------------- 第二遍：跨格**联合**分配曲名 ----------------
   *
   * ## 为什么需要（实测结论）
   *
   * Phigros 用**精确窄框**（几何正确、单格只剩一个候选）时曲名只有 27/36，
   * 而**跨卡宽框**（单格能看到多个候选）有 32/36。
   * 说明瓶颈不在裁剪几何，而在"逐格独立决策用不上全局约束"——
   * 最明显的是"同一首曲目不该同时出现在两格"
   * （实测 `#35`/`#36` 都读成 `Cthugha` 系，逐格决策会把两格判成同一首）。
   *
   * ## 保守地替换
   *
   * 只把**逐格跑不出匹配**（`matchedTitle === null`）的格交给联合分配去试。
   * 逐格已经匹配上的格**保持不动**——它们已经拿到了定数表里确实存在的曲目，
   * 全局重排反而可能把对的换成错的。
   * 所以这条路**只可能新增匹配，不会破坏已有匹配**（有单测守着这条性质）。
   */
  const unmatched = cards.filter((c) => c.validation.matchedTitle === null)
  if (unmatched.length > 0 && table.table.entries.length > 0) {
    try {
      const inputs = unmatched.map((c) => ({
        id: c.index,
        candidates: c.candidate.titleCandidates ?? [],
        constant: c.candidate.constant,
        // 分数用于消重：分数不同的两格不可能是同一首歌
        score: c.candidate.score,
        /*
         * 卡面**读到的**定数（不是查表得到的）作为消重的第二判据。
         * ⚠ 必须用 `candidate.constant`（OCR 结果），
         * 不能用 `validation.constant.value`（那是查表/反推的结果）——
         * 后者是分配之后才有的，会产生循环论证。
         */
        cardConstant: c.candidate.constant
      }))
      const assigned = assignTitlesGlobally(inputs, table.table, gameId)
      let filled = 0
      for (const card of unmatched) {
        const title = assigned.byId.get(card.index)
        if (!title) continue
        // 用分配到的曲名重跑校验（定数/难度/PTT 都要跟着重算）
        const candidate2 = { ...card.candidate, title }
        const validation2 = validateCandidate(
          table.table,
          candidate2,
          gameId,
          knownDifficulty,
          minPotentialDecimals
        )
        // 只有真的匹配上了才替换
        if (validation2.matchedTitle === null) continue
        card.candidate = candidate2
        card.validation = validation2
        filled++
      }
      diag(
        `跨格联合分配：未匹配 ${unmatched.length} 格，按全局最优补上 ${filled} 格（总权重 ${assigned.totalWeight.toFixed(2)}）`
      )
    } catch (error) {
      diag(`跨格联合分配失败（不影响其余结果）：${(error as Error).message}`)
    }
  }

  /*
   * ---------------- 第二遍的补充：拆开"已匹配"的重复 ----------------
   *
   * ## 为什么需要
   *
   * 上面只把 `matchedTitle === null` 的格送进联合分配（保守设计）。
   * 但**两格各自独立匹配到同一首**的情况进不了消重——
   * 实测 `arcaea分表01.jpg` 有 `Singularity` ×2、`Arcana Eden` ×2，
   * 两组的**分数都不同**（9914990/9906721、9901128/9605836），
   * 有的连**卡面定数也不同**（10.5 vs 11.6），判据充分，本应被拆开。
   *
   * ## 做法：只对"涉事格"做受限重解
   *
   * 1. 找出同名重复的组，且组内**分数或卡面定数不同**（否则不动，无依据）；
   * 2. 把"这一组之外已经占用的曲名"作为**禁选集合**；
   * 3. 只把这一组的格送进联合分配，并告诉它"别选这些已被占用的曲名"；
   * 4. 只有重解出的结果**与原结果不同且仍能匹配上**时才替换。
   *
   * 这样**其它格完全不动**（安全），只有确实重复的那几格参与重解。
   */
  if (cards.length > 0 && table.table.entries.length > 0) {
    try {
      const groups = new Map<string, CardOcrResult[]>()
      for (const c of cards) {
        const t = c.validation.matchedTitle
        if (!t) continue
        if (!groups.has(t)) groups.set(t, [])
        groups.get(t)!.push(c)
      }
      let fixed = 0
      for (const [title, list] of groups) {
        if (list.length < 2) continue
        /*
         * 判据：组内**分数不同**或**卡面定数不同**才说明是两首不同的歌。
         * 两者都相同就不动——没有可靠依据。
         */
        const scores = new Set(list.map((c) => c.candidate.score ?? null))
        const consts = list
          .map((c) => c.candidate.constant ?? null)
          .filter((v) => v !== null)
        const constsDiffer = new Set(consts).size >= 2
        if (scores.size < 2 && !constsDiffer) continue
        /*
         * 同一首歌的不同难度是合法的重复标题（Arcaea B50 常见 FTR + BYD）。
         * 先用校验层已经得到的难度，再回退到卡面定数判断；只有确认是同一
         * 谱面重复时才进入“拆重复”，避免把 Arcana Eden FTR/BYD 改成别曲。
         */
        const entry = table.table.entries.find(
          (e) => e.title === title && (!e.game || e.game === gameId)
        )
        if (
          gameId === 'arcaea' &&
          entry &&
          hasDistinctChartVariants(
            list.map((c) => ({
              difficulty: c.validation.difficulty,
              constant: c.candidate.constant,
              chartLevel: c.candidate.chartLevel
            })),
            entry
          )
        ) {
          diag(
            `拆重复：曲名「${title}」的 ${list.length} 格对应不同谱面，保留同名（${list
              .map((c) => c.validation.difficulty ?? '?')
              .join('/')})`
          )
          continue
        }
        // 这一组之外已占用的曲名 → 禁选
        const external = new Set(
          cards
            .filter((c) => !list.includes(c) && c.validation.matchedTitle)
            .map((c) => c.validation.matchedTitle as string)
        )
        const inputs = list.map((c) => ({
          id: c.index,
          candidates: c.candidate.titleCandidates ?? [],
          score: c.candidate.score,
          cardConstant: c.candidate.constant,
          // 禁止重解时又选中"别人已经占着"的曲名
          bannedTitles: [...external]
        }))
        const assigned = assignTitlesGlobally(inputs, table.table, gameId)
        for (const card of list) {
          const t2 = assigned.byId.get(card.index)
          if (!t2 || t2 === card.validation.matchedTitle) continue
          const candidate2 = { ...card.candidate, title: t2 }
          const validation2 = validateCandidate(
            table.table,
            candidate2,
            gameId,
            knownDifficulty,
            minPotentialDecimals
          )
          if (validation2.matchedTitle === null) continue
          /*
           * ⚠ **接受条件**：重解结果必须"自洽"，不能只为了消重就把格子推到错名字上。
           *
           * 实测教训：没有这条时，`#37` 被从 `Singularity` 推到了
           * `I've heard it said`——复核原因直接指出 `PTT 12.1336 与公式算出的
           * 9.6336 不一致`（差 2.5），明显是错的。
           *
           * 判据用 `validateCandidate` 自己给出的 reasons：
           *   - 不得含 `与公式` 不一致（说明定数/状态与该曲目不匹配）
           *   - 不得含 `无法确定难度`（说明卡面定数与候选曲目对不上）
           *
           * 宁可留着重复（由人工复核处理），也不要**静默写错曲名**。
           */
          const bad = (validation2.reasons ?? []).some(
            (r) => r.includes('与公式') || r.includes('无法确定难度')
          )
          if (bad) {
            diag(
              `拆重复：拒绝把 #${card.index} 推给「${t2}」（校验不自洽：${(validation2.reasons ?? [])[0]?.slice(0, 40) ?? ''}）`
            )
            continue
          }
          card.candidate = candidate2
          card.validation = validation2
          fixed++
        }
        diag(
          `拆重复：曲名「${title}」有 ${list.length} 格（#${list.map((c) => c.index).join(',#')}），重解后调整 ${fixed} 格`
        )
      }
    } catch (error) {
      diag(`拆重复失败（不影响其余结果）：${(error as Error).message}`)
    }
  }

  /*
   * 诊断落盘：设置 BEST30_DUMP_OCR=1 时把完整结果写到 _ocr-dump.json。
   * 为什么需要它：用 CDP 探针读返回对象时，探针侧的 awaitPromise 与
   * 结果对象会出现竞态（我在这上面误判过两次），而主进程自己落盘是权威的。
   */
  if (process.env.BEST30_DUMP_OCR === '1') {
    try {
      const { writeFileSync: wf } = require('node:fs') as typeof import('node:fs')
      wf(
        join(process.cwd(), '_ocr-dump.json'),
        JSON.stringify(
          {
            family: finalGrid.family,
            rows: finalGrid.rows,
            cols: finalGrid.cols,
            cards,
            /*
             * **诊断用**：把两条"增强通道"的内容也落盘。
             *
             * 为什么必须记：它们走**纯文本注入**，不进 `items`，
             * 所以只看 `items` 会误判"PTT 值不在自己的块里"。
             * 我自己就被这个绊住过一次——诊断工具看不到数据源，
             * 于是把正确的行为误当成 bug。
             */
            diagnostics: {
              extraTitles: Object.fromEntries(extraTitles),
              potExtra: Object.fromEntries(potExtra),
              /*
               * **每条带的裁剪矩形 + 原始读数**（版式B 调参的关键证据）。
               *
               * 只有文本时无法判断带偏了多少——这正是版式B 的字段带
               * 反复盲调、直到第 4 轮才找到根因（参照系混用）的原因。
               */
              bands: takeBandDebug()
            }
          },
          null,
          0
        ),
        'utf8'
      )
      diag(`结果已落盘 _ocr-dump.json（${cards.length} 张卡）`)
    } catch (e) {
      diag(`落盘失败：${(e as Error).message}`)
    }
  }

  return {
    ok: true,
    /*
     * ⚠ 这里必须用 `finalGrid` 而不是 `grid`。
     * 早期写成 `grid`——那是**锚点路径之前**的结果，于是虽然识别用的是 30 格，
     * 回报给界面的却是兜底的 `generic-grid 7 行 × 0 列`，
     * 界面按 0 列渲染，用户看到"成功但什么都没有"。
     * 这类"内部用对了、回报用错了"的错最难发现，因为它只在统计字段上表现出来。
     */
    family: finalGrid.family,
    rows: finalGrid.rows,
    cols: finalGrid.cols,
    confidence: finalGrid.confidence,
    cards,
    ms: Date.now() - t0
  }
}
