/**
 * 主进程 IPC 通道名常量。
 *
 * 主进程与渲染进程共用，避免字符串写错导致静默失败。
 */
export const IPC = {
  /** 打开对话框选择文件（可多选） */
  pickFiles: 'dialog:pickFiles',
  /** 打开工程文件 */
  pickProject: 'dialog:pickProject',
  /** 选择保存路径（导出视频用） */
  pickSavePath: 'dialog:pickSavePath',
  /** 选择目录（导出分层素材用） */
  pickDirectory: 'dialog:pickDirectory',
  /** 保存工程到指定路径（未指定则弹保存框） */
  saveProject: 'project:save',
  /** 读取工程文件 */
  loadProject: 'project:load',
  /** 探测媒体文件信息（时长、分辨率）—— 依赖 ffprobe */
  probeMedia: 'media:probe',
  /** 检查文件是否存在 */
  checkFiles: 'media:checkFiles',
  /** 导出一张版面预览图（返回 PNG 的 base64） */
  renderPreview: 'render:preview',
  /** 开始导出视频（进度通过 onExportProgress 推送） */
  startExport: 'export:start',
  /** 取消导出 */
  cancelExport: 'export:cancel',
  /** 主进程 → 渲染进程：导出进度 */
  onExportProgress: 'export:progress',
  /** 获取应用信息（版本、平台、ffmpeg 是否可用） */
  appInfo: 'app:info',
  /** 触发一次界面缩放重算 */
  setUiZoom: 'ui:setZoom',
  /** 读取当前窗口宽度（像素），用于初始化界面缩放 */
  getUiScale: 'ui:getScale',
  /** 主进程 → 渲染进程：窗口尺寸变化，附带新的窗口宽度 */
  uiScaleChanged: 'ui:scaleChanged',
  /** 读取窗口是否处于最大化/全屏状态 */
  getMaximized: 'window:getMaximized',
  /** 切换全屏 */
  toggleFullScreen: 'window:toggleFullScreen',
  /** 主进程 → 渲染进程：最大化/全屏状态变化 */
  maximizedChanged: 'window:maximizedChanged',
  /** 读取定数表（用户目录优先，没有则用内置种子） */
  loadTiers: 'tiers:load',
  /** 保存定数表到用户目录 */
  saveTiers: 'tiers:save',
  /** 把定数表恢复为内置种子 */
  resetTiers: 'tiers:reset',
  /** 导入定数表文件（弹出文件选择框并解析） */
  importTiersFile: 'tiers:importFile',
  exportTiersFile: 'tiers:exportFile',
  /** 主进程 → OCR worker：派发一次识别任务 */
  ocrJob: 'ocr:job',
  /** OCR worker → 主进程：回传识别结果 */
  ocrResult: 'ocr:result',
  /** 渲染进程 → 主进程：识别一张长分表 */
  recognizeSheet: 'ocr:recognizeSheet',
  /** 渲染进程 → 主进程：识别一张单曲结算图 */
  recognizeSettlement: 'ocr:recognizeSettlement',
  /** 读取文本文件（用于导入定数表等） */
  readTextFile: 'fs:readText',
  /** 写入文本文件 */
  writeTextFile: 'fs:writeText',
  /** 在系统文件管理器中显示文件 */
  revealFile: 'fs:reveal',
  /** 递归扫描本地素材目录，返回可匹配的媒体文件 */
  scanAssets: 'assets:scan',
  /** 列出随应用提供的 Arcaea 风格背景预设 */
  listBuiltinBackgrounds: 'assets:listBuiltinBackgrounds'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface PickedFile {
  path: string
  name: string
  size: number
}

export interface MediaProbeResult {
  path: string
  exists: boolean
  /** 时长（秒） */
  duration?: number
  width?: number
  height?: number
  /** 是否含音频轨 */
  hasAudio?: boolean
  /** 是否含视频轨 */
  hasVideo?: boolean
  fps?: number
  error?: string
}

export interface ExportProgress {
  /** 0–1 */
  ratio: number
  stage: string
  /** 当前正在处理的条目序号（1-based），无则为 0 */
  entryIndex: number
  entryTotal: number
  message?: string
  done?: boolean
  error?: string
}

export interface AppInfo {
  version: string
  platform: string
  electron: string
  node: string
  chrome: string
  /** ffmpeg 可执行文件路径（null 表示未找到） */
  ffmpegPath: string | null
  /** ffprobe 可执行文件路径 */
  ffprobePath: string | null
  /** 应用是否处于开发模式 */
  isDev: boolean
  /** 主进程实际监听的文件服务端口（用于渲染进程加载本地素材） */
  mediaPort: number
}

export interface BuiltinBackground {
  id: string
  label: string
  path: string
}
