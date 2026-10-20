# arcshow-b50videomaker

**在本机把 Arcaea 成绩、谱面录像与解锁动画剪成一支 Best50 展示视频。**

当前版本 **0.5.17**，面向 **Windows 10 / 11 x64**。支持长分表 OCR、JSON / CSV 导入、手动校对、逐段裁剪、动画插入、自由排序、音频衔接与可编辑画面布局。素材、识别、预览和导出都在本地处理；准备依赖后可离线使用，无需账号、API Key 或云端识别服务。

> 仓库保存当前源码和不含媒体的完整示例工程。不会附带玩家的录像、歌曲音频、解锁动画、背景、原始分表截图、历史便携版或个人缓存。请自行准备有权使用的素材。

## 目录

- [能做什么](#能做什么)
- [从源码运行](#从源码运行)
- [基本使用](#基本使用)
- [完整影片示例](#完整影片示例)
- [项目结构](#项目结构)
- [想扩展功能，改哪里](#想扩展功能改哪里)
- [常见问题](#常见问题)
- [开发与打包](#开发与打包)
- [致谢与许可](#致谢与许可)

## 能做什么

| 部分 | 功能 |
| --- | --- |
| 成绩输入 | 长分表本地 OCR，拖放图片、JSON / CSV、手动新增；逐卡核对曲名、难度、定数、分数、通关状态、FAR / LOST 与 Potential |
| 剪辑 | 逐段开始 / 结束时间、原片波形与循环试听、拖动排序、插入解锁动画、从所选卡片连续预览 |
| 音乐 | 录像原声、独立音频、动画原声、共同音源连续播放、离线对齐候选、接点试听、逐接点音乐淡化 |
| 转场 | 独立片段黑场与静音留白；连续难度 / remix / 动画接谱面可 0 秒直切并显示短暂模糊；总览逐页模糊 |
| 画面 | 暮光 / 白昼、四套角色印象配色、全局 / 逐曲背景、逐曲文字覆盖、可拖动的组件、独立黑底与图片图层 |
| 短评 | Unicode 文本和 emoji；文字输入保持原生编辑，固定 Apple 图形效果需在本地另行准备资源 |
| 导出 | 本地 FFmpeg 合成 MP4；1080p、60 FPS、自动硬件编码探测、软件编码回退、素材范围与音画校准预检 |

没有片头或角色立绘组件。印象配色只使用颜色，不包含游戏立绘。界面称为 **Potential**；少量源码字段沿用 `rating`，用于兼容既有工程。

## 从源码运行

需要 **Node.js 24 LTS、npm、Python 3.10+**。以下命令在仓库根目录执行；首次安装依赖和准备外部资源需要联网。

```powershell
npm ci
npm run resources
npm run build
npm start
```

`npm run resources` 校验仓库内的 OCR 模型，并从固定版本的上游包准备 FFmpeg / FFprobe。可在另一台电脑准备完整目录后复制离线使用。

若需要本项目选定的 Apple emoji 图形，请先阅读[资源说明](docs/resources.md)，再在本地执行：

```powershell
npm run resources -- --emoji
```

这些图片不在公开源码或示例中；数据包的 MIT 许可不等于 Apple 图像的再分发许可。未准备时短评文字仍可编辑，固定图形显示不完整，因此正式预览 / 出片前应准备并运行 `npm run verify`。

已有 FFmpeg / FFprobe 的离线电脑可执行：

```powershell
py -3 scripts/prepare-resources.py --ffmpeg-dir "D:\tools\ffmpeg\bin"
```

这里是用户自行选择的工具目录。两个可执行文件应来自兼容版本，FFmpeg 需要包含 `libx264`、`ebur128`、`gblur` 等功能。详见[资源与离线迁移](docs/resources.md)。

## 基本使用

1. **导入和核对成绩**：在“成绩与剪辑”打开“长分表 OCR”，选择或拖入图片；也可导入 JSON / CSV。所有识别值都应与原卡核对，尤其是 FAR / LOST、同曲不同难度、日文曲名与通关状态。Potential 不一致时先核对输入与规则，再使用覆盖值。
2. **关联素材**：扫描自己的素材目录，再“自动匹配空白素材”。检查匹配的确是对应难度的谱面录像，解锁动画需要单独插入。
3. **剪辑和排序**：在顺序卡片中拖动排序，为每段选择原始文件的开始、结束时间。独立曲目通常展示约 20 秒；同曲不同难度、remix 与动画可以相邻连续播放。
4. **处理接点**：普通曲目使用留白与淡化；连续组可选择“直接切换（0 秒）”。需要原声无缝衔接时，将该接点“音乐淡出／淡入”也设为 `0`，再试听。
5. **调整画面**：影片设置选择主题与全局背景；本曲背景和文字在剪辑中覆盖。视频布局中修改位置、字号、显隐、难度色、独立黑底和自选图片的深度。
6. **收尾和导出**：选中“结尾总览”，设置每页时长、Potential 排列与翻页模糊。试听末曲延续到总览的结尾，确认所有预检通过后导出。

操作细节见[完整示例教程](examples/full-b50-tutorial/README.md)。输入字段见[数据与工程格式](docs/project-format.md)。

## 完整影片示例

[`examples/full-b50-tutorial/`](examples/full-b50-tutorial/) 包含一部已经人工调整并实际导出验证过的完整工程的公开副本：

- `example.arcshow`：50 张成绩、6 段解锁动画、逐段时间、背景分配、单曲 / 总览布局与所有接点设置；玩家信息和短评已改为示例内容。
- `README.md`：从成绩导入、素材匹配到每一组动画 / 双难度连接、背景、短评、总览和导出的逐步教程。
- `timeline.csv`、`clip-settings.csv`：最终影片位置与每个原素材的裁剪范围。
- `assets-required.md`、`assets-required.json`：必须自行准备的素材、相对路径、用途和时长要求。
- `scores.json`、`scores.csv`：可单独导入的示例成绩数据。

**示例不附带任何媒体。** 打开后出现缺失素材提示是预期现象。按清单把自己的文件放到示例的 `assets/` 下，或逐项重新选择。换录像版本后要重新试听并调整选段；示例秒数依赖原录像开头的时间位置。

## 项目结构

```text
main/         Electron 主进程、IPC、导出、OCR / 对齐工作进程、预览音频缓存
renderer/     界面、剪辑台、布局编辑器、短评编辑、成片预览与画面渲染
shared/       工程校验、Potential、时间线、转场、布局、文本与 emoji 映射
vendor/ocr/   本地 Best30 Studio OCR 适配所需的识别与解析模块
data/         离线曲库、OCR 模型校验清单、开发基线的 FFmpeg 构建记录
resources/    OCR 模型与 emoji 来源清单；本地准备的工具和图像由 Git 排除
scripts/      构建、启动、资源准备、资源校验和当前版便携包生成
tests/        自动测试与脱离私人工作目录的固定测试数据
docs/         开发、资源、数据格式和版本说明
examples/     不含媒体的完整示例、教程和素材清单
licenses/     第三方许可文本
```

## 想扩展功能，改哪里

| 你想修改 | 主要入口 | 一起检查 |
| --- | --- | --- |
| 界面字号、排布和印象配色 | `renderer/app.css`、`impression.css`、`shared/impression.mjs` | `readability.css`、`workbench.css`，亮 / 暗背景下可读性 |
| 新增成绩字段 / 导入来源 | `shared/core.mjs`、`renderer/app.mjs` | 工程保存、CSV 别名、OCR 校对、`main/preload.cjs` 的 IPC 白名单 |
| Potential 公式 / 排名 | `shared/rating.mjs`、`shared/core.mjs` 中 `fmtRating` | 旧工程兼容、显示四位小数与排序精度、公式回归测试 |
| OCR 版式 / 假名曲名 | `main/poster-ocr.ts`、`shared/ocr-slot-assignment.mjs`、`vendor/ocr/` | 槽位边界、跨卡污染、候选曲名、`data/songs.json` |
| 时间线、动画和音源连接 | `shared/timeline.mjs`、`renderer/workbench.mjs` | 自动对齐、末曲延续到总览、素材预检、保存重开 |
| 预览性能和接点 | `renderer/timeline-player.mjs`、`preview-video.mjs`、`preview-audio.mjs` | 视频预加载、单一时钟、取消播放、`main/preview-audio-cache.cjs` |
| 黑场 / 模糊 / 留白 | `shared/transitions.mjs`、`renderer/preview-scene.mjs` | `main/exporter.cjs`，接点帧数、黑边与音频连续性 |
| 默认组件布局 / 增加组件 | `shared/default-layout.mjs`、`shared/layout.mjs`、`renderer/layout-editor.mjs` | `renderer/frame.mjs`、`scene.css`，预览和导出必须一致 |
| 图片层级 / 逐曲文字 | `shared/layout.mjs`、`shared/text-styles.mjs` | `renderer/text-style-editor.mjs`、媒体路径遍历与导出校验 |
| emoji / 短评输入 | `shared/comments.mjs`、`comment-emoji.mjs`、`renderer/comment-editor.mjs` | 原始 Unicode、输入法、剪贴板、整字素截断、资源许可 |
| 编码 / 响度 / 打包 | `main/exporter.cjs`、`main/loudness.cjs`、`scripts/pack.mjs` | CPU / 硬件回退、资源清单、第三方许可、真实短片验证 |

更详细的依赖关系与开发检查见[开发指南](docs/development.md)。

## 常见问题

**为什么识别出 50 张卡仍要核对？** OCR 识别和字段匹配都有误差。缩小长图中的相邻字段很容易相似，程序不会把未确认的候选当作可靠成绩。请逐卡对照原图，核对后再保存。

**Potential 相差 0.0001 怎么办？** 先核对定数、分数、通关状态与规则；界面采用四位小数显示，排序保留计算精度。需要采用可信外部值时填写单曲 Potential 覆盖，清空可恢复自动。账号 Potential 需手动填写，不等于本工程 Best50 的平均值。

**动画为什么没有跟着下一曲的音乐？** “动画原声”和“提前播放下一首”是不同选择。动画有自身配乐剪辑时优先试听原声衔接；只有明确需要同一音源时才建立共同配乐组，并完成音画对应确认。

**为什么直切仍能听到音量凹陷？** 画面直切与音乐淡化分别设置。连续接点可以把“音乐淡出／淡入（每侧秒数）”设为 `0`；普通独立曲目仍保留全片留白与淡化。

**预览会卡，能代表导出吗？** 第一次预览需测量响度并准备音轨，高清视频解码也受电脑性能影响。重要接点先做短片导出确认；本地离线导出按固定帧数合成，不依赖实时预览帧率。

**换背景后文字看不清？** 添加一个独立黑底并调整宽高 / 不透明度，或在“本曲文字”中覆盖颜色与阴影。不必给每个文字组件叠一个底框。未覆盖的属性继续继承全局。

**换电脑后素材找不到？** 工程保存的是媒体引用，不会把媒体嵌进去。复制工程和素材并重新关联；本示例使用相对路径，按素材清单目录放置即可。

**在 Windows 输入框里 emoji 外观不同？** 输入框使用系统字形，下面“显示效果 · Apple”和成片使用本地图像。复制的是 Unicode 字符；仅有截图的剪贴板无法恢复成表情文字。

## 开发与打包

```powershell
npm test                 # 逻辑测试；未准备工具时媒体测试会标记为跳过
npm run verify           # 严格资源检查（含完整 emoji），然后运行测试与构建
npm run pack             # 生成当前版本便携目录，要求资源准备完整
```

便携目录输出到 `portable/arcshow-b50videomaker-0.5.17/`，仅包含当前程序和无媒体示例。打包不会自动收集你的工程、视频或浏览器数据。整个目录复制后才能运行，不能只复制 EXE。自行分发含 FFmpeg 或第三方图像的包时还须遵守各自许可；公开源码没有附带这些二进制和图像。

仓库包含固定版本 `package-lock.json`。`npm ci`、构建和测试是开发基线；真实导出仍建议在 Windows 本机执行。版本说明见 [CHANGELOG](docs/CHANGELOG.md)。

当前桌面依赖沿用已验证版本，npm 存在安全告警；公开整理未进行破坏性的依赖升级。平台、网络和依赖维护限制见[已知限制](docs/known-limitations.md)。

本次整理的 209 项测试、资源校验与实际短片检查见[验证记录](docs/validation.md)。公共 CI 不下载 Apple 图像，对应检查会明确跳过。

## 致谢与许可

- 工作流参考 [Nick-bit233/mai-gen-videob50](https://github.com/Nick-bit233/mai-gen-videob50)。
- README 的“功能 → 使用 → 构建 → 开发扩展 → 许可”组织方式参考 [CialloKing/ba-click-fx](https://github.com/CialloKing/ba-click-fx)。
- OCR 使用本地 Best30 Studio 的适配代码、RapidOCR / PaddleOCR 模型与 ONNX Runtime；桌面框架为 Electron，媒体处理为 FFmpeg。

本项目源码采用 [MIT](LICENSE)。Arcaea 是 lowiro 的游戏，游戏名称、曲目、背景与其他素材归相应权利人所有；本工具非官方产品。MIT 不授予第三方素材的使用或再分发权。详细组件来源与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
