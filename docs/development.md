# 开发与扩展指南

本文对应 0.5.17。应用使用原生 JavaScript ES Modules、少量 TypeScript OCR 适配代码和 Electron IPC，没有前端组件框架。

## 运行关系

```text
main/bootstrap.cjs
  ├─ --arc-ocr-worker → ocr-worker.cjs → dist/*.cjs → ONNX 模型
  └─ main/index.cjs → BrowserWindow → renderer/index.html → app.mjs
                        ↓ preload.cjs 白名单 IPC
       本地媒体授权、工程读写、FFprobe、OCR、对齐、响度、导出

shared/core.mjs → 工程校验 / 输入与迁移
shared/rating.mjs → 单曲 Potential / 去重 / Best 排名
shared/timeline.mjs → 统一 scenes + audio + issues
shared/transitions.mjs → 黑场、音乐淡化、留白和模糊
                        ↓
      renderer 成片预览              main/exporter.cjs 固定帧导出
      frame.mjs / scene.css          同一个画面渲染入口 + FFmpeg
```

`main/index.cjs` 提供文件选择、工程保存和素材授权。不要在渲染页直接引入 Node 文件系统或放开任意 URL 对本地文件的访问。

## 模块索引

| 路径 | 职责 |
| --- | --- |
| `renderer/app.mjs` | 导航、成绩列表、导入、OCR 校对、设置与工程状态 |
| `renderer/workbench.mjs` | 排序、逐段媒体 / 时间 / 转场、动画、共同配乐与试听 |
| `renderer/source-trimmer.mjs` | 原片预览、波形选区、标记开始结束、循环和异步定位 |
| `renderer/timeline-player.mjs` | 成片播放状态、统一时钟、切卡与资源生命周期 |
| `renderer/preview-{audio,video,scene,payload}.mjs` | 音频调度、视频预加载、场景准备、精简跨窗口数据 |
| `renderer/layout-editor.mjs` | 组件拖动、尺寸、显隐、黑底、图片与深度 |
| `renderer/text-style-editor.mjs` | 逐曲全部文字和单组件属性覆盖 |
| `renderer/comment-editor.mjs` | 短评编辑、Apple 效果区、输入法与粘贴反馈 |
| `renderer/frame.mjs` / `scene.css` | 成片场景；修改后要同时验证预览与导出 |
| `main/poster-ocr.ts` / `player-enhance.ts` | 长图切卡、识别增强与曲库匹配 |
| `shared/ocr-slot-assignment.mjs` | 空间槽位与字段归属，避免跨卡污染 |
| `main/audio-tools.cjs` / `alignment-worker.cjs` | 波形、特征分析、离线音画对齐 |
| `main/loudness.cjs` | 所选范围的静态响度增益与缓存 |
| `main/preview-audio-cache.cjs` | PCM 准备、任务取消与缓存预算 |
| `main/project-media.cjs` | 遍历持久化媒体字段，供重定位与授权使用 |
| `shared/media-check.mjs` | 文件、音轨、源范围、校准状态预检 |
| `shared/default-layout.mjs` | 新工程默认布局；不应覆盖旧工程显式布局 |
| `shared/layout.mjs` / `text-styles.mjs` | 版本迁移、规范化、图层与样式继承 |

## 新增组件

1. 在 `shared/layout.mjs` 定义组件及规范化规则，在 `shared/default-layout.mjs` 提供默认值。
2. 在 `renderer/layout-editor.mjs` 暴露选项，复用坐标、尺寸、字体与显隐机制。
3. 在 `renderer/frame.mjs` 和 `scene.css` 渲染，避免另写只供预览的画面。
4. 引用文件时同步修改 `main/project-media.cjs` 和 `shared/media-check.mjs`，否则换电脑后可能丢失授权或漏掉预检。
5. 定义旧工程缺少组件时的迁移行为，不覆盖现有自定义布局。
6. 补充持久化、默认值与层级测试，用实际场景检查文字边界和导出。

## 修改时间与音频

时间线由 `shared/timeline.mjs` 统一规划。不要在预览、导出端各自重新计算顺序。

- `start` / `audioStart` 对应原素材；`duration` 是取用时长，影片位置由时间线决定。
- 留白是额外黑屏静音时间，淡入淡出在片段内部完成。
- 画面直切与音乐淡化独立。共同音源内部切换不得重启音轨。
- 共同配乐成员必须相邻，待校准的录像确认对应后才可导出。
- 末曲音乐延续到总览；总览页数或秒数变化后重新检查音源余量。
- 模糊使用覆层避免边缘露黑，不靠放大整张画布遮掩。
- 异步定位 / 解码任务要丢弃过期结果；播放中不反复重建编辑区，不因暂时的媒体时钟回退切回旧卡。

相关测试覆盖留白、模糊边缘、帧数、总览、音源范围、预加载和响度。影响媒体流程的修改还需导出包含该接点的短片，试听并逐帧检查。

## OCR、曲库与 Potential

OCR 不能确定时保留空值和候选。先按空间归属分卡，再匹配字段；不要让相邻卡片的曲名、定数与分数混入。

`data/songs.json` 是手动维护的离线快照，不是实时官方数据。增补曲目时保持结构，更新 `updatedAt`，检查不同难度、假名、别名和特殊符号。公开回归数据应使用允许发布的样例或合成图，不提交玩家截图。

显示四位小数时只修正舍入边界的浮点噪声；排名和均值保留计算精度。界面统一称 Potential，`ratingOverride` 等持久化键用于旧工程兼容。

## 验证与发布

```powershell
npm ci
npm run resources -- --emoji
npm run verify
npm run pack
```

`verify` 严格校验模型、工具和完整 emoji，再测试与构建。只研究逻辑时可 `npm test`；没有工具时媒体测试会标记 `SKIP`，不能把它称为完整媒体验证。

固定测试数据位于 `tests/fixtures/`，临时输出在忽略目录。打包只收集当前代码、资源、文档及无媒体示例，不扫描用户目录。

公开前检查 `git ls-files`、文件大小、第三方许可。共享 `.arcshow` 前移除绝对路径、OCR 原文 / 缩略图、玩家信息和私人短评。含 FFmpeg 或第三方图像的便携包应另外满足各自分发要求。
