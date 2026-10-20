/**
 * **ONNX Runtime 共享运行时**：模块加载与模型目录解析。
 *
 * 检测（`onnx-detect.ts`）与识别（`onnx-ocr.ts`）都要用这两件事，
 * 抽出来避免各写一份（两处不一致会很难查）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type OrtModule = typeof import('onnxruntime-node')

let ort: OrtModule | null = null

/**
 * 加载 `onnxruntime-node`。
 *
 * ⚠ 它是**原生模块**（含 `.node` 二进制），必须由 Node 直接加载，
 * 不能让 Vite/esbuild 打包进去。所以用动态 `require`，
 * 并在打包配置里把它标为 external。
 */
export async function loadOrtModule(): Promise<OrtModule> {
  if (ort) return ort
  const { createRequire } = await import('node:module')
  const req = createRequire(__filename)
  ort = req('onnxruntime-node') as OrtModule
  return ort
}

/**
 * 模型目录。
 *
 * 优先级：
 *   1. `BEST30_ONNX_MODELS` 环境变量（测试脚手架 / 部署覆盖）
 *   2. `process.resourcesPath/onnx-models`（electron-builder 打包后）
 *   3. `<应用根>/resources/onnx-models`（开发态）
 *
 * ⚠ 第 3 条用 `app.getAppPath()` 而不是 `__dirname`：
 * 主进程产物在 `<root>/out/main`，`__dirname/../..` 在**打包后**
 * 会指进 asar（那里没有模型）；`app.getAppPath()` 两种形态都能定位应用根。
 */
export function modelDir(): string {
  const envDir = process.env.BEST30_ONNX_MODELS
  if (envDir) return envDir
  const packaged = process.resourcesPath ? join(process.resourcesPath, 'onnx-models') : ''
  if (packaged) {
    try {
      readFileSync(join(packaged, 'rec_ch.onnx'))
      return packaged
    } catch {
      /* 继续尝试开发态路径 */
    }
  }
  try {
    const { app } = require('electron') as typeof import('electron')
    return join(app.getAppPath(), 'resources', 'onnx-models')
  } catch {
    // 非 Electron 环境（单元测试 / 脚手架）：退回 __dirname 推导
    return join(__dirname, '..', '..', 'resources', 'onnx-models')
  }
}
