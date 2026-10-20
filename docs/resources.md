# 资源准备与离线使用

运行时不会下载模型、调用在线识别或上传媒体。首次开发配置需要自行准备以下资源。

| 资源 | 仓库内容 | 准备方式 |
| --- | --- | --- |
| OCR ONNX 模型与字典 | 固定快照约 40 MiB 和 SHA-256 清单 | `npm run resources` 校验 |
| FFmpeg / FFprobe | 无二进制 | 脚本下载固定上游包，或从自己的工具目录复制 |
| Apple emoji PNG | 只有映射、来源和哈希 | `npm run resources -- --emoji` 本地准备 |
| Electron / ONNX Runtime / esbuild | 精确版本与 lockfile | `npm ci` |
| 录像、解锁动画、背景、歌曲音频 | 不提供 | 自行准备并关联 |

## 一次准备

```powershell
npm ci
npm run resources -- --emoji
npm run verify
npm start
```

Python 3.10+ 脚本下载到 `.cache/`，校验固定 SHA-256 后复制指定文件，不执行安装器。FFmpeg 下载来源为 Gyan 固定版 `8.1.2-essentials_build`。历史开发基线 `6.1.1` / `4.0.2` 的构建输出保留在 `data/ffmpeg-build.txt`、`ffprobe-build.txt`，不表示公开源码附带它们。

已经有工具的电脑可执行：

```powershell
py -3 scripts/prepare-resources.py --ffmpeg-dir "D:\tools\ffmpeg\bin" --emoji
```

或者手动放置 `resources/bin/ffmpeg.exe`、`ffprobe.exe`。FFmpeg 需支持 `libx264`、`ebur128`、`gblur` 等功能。自选版本先校验，再运行媒体测试。

## emoji 外观

固定效果以 `emoji-datasource-apple@3.0.0` 为基础，用 `16.0.0` 补充新增组合，共 3,784 图。映射位于 `shared/comment-emoji-data.mjs`，来源与逐图哈希位于 `resources/emoji/apple/manifest.json`。

Apple 仍拥有图像权利。数据包 MIT 许可不授予 Apple 图片的公共或商业再分发权，所以公开 Git 历史不含 PNG。准备脚本供用户本地获取所选外观，不应把 `images/` 或含它的便携包当作 MIT 素材再次发布。

短评保存原始 Unicode。输入框使用系统字形，下方“显示效果 · Apple”、成片预览和导出使用本地图像。未知的新表情保留原文并后备显示。

## 完全离线迁移

1. 联网 Windows x64 电脑完成依赖、资源、校验和 `npm run pack`。
2. 复制完整 `portable/arcshow-b50videomaker-0.5.17/`，不能只复制 EXE。
3. 单独复制自己的工程和媒体；程序不会嵌入工程素材。
4. 打开工程，必要时重新关联文件。
5. 导出前检查缺失、音轨长度与校准状态。

直接迁移开发目录还需平台一致的 `node_modules/` 和 Node.js。没有本地缓存时，`npm ci` 仍需联网。

## 更新资源

同时修改下载来源、固定哈希和许可。不要用 `latest` 替代固定版本。换 OCR 模型要核对字典，换 FFmpeg 要跑实际媒体测试，换 emoji 要同时生成映射和 manifest 并检查旧字符外观。
