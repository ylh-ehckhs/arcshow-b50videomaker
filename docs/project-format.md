# 成绩与工程格式

JSON 接受直接数组，或包含 `entries` / `scores` / `records` 等数组的对象。CSV 为 UTF-8，首行是字段名。

```json
[{"title":"Example Song","difficulty":"FTR","constant":10.5,"score":9900000,"clear":"NC","far":3,"lost":1,"comment":"示例 😡😭🤓😰🤔"}]
```

| 字段 | 含义 |
| --- | --- |
| `title` / `songId` | 曲名 / 可选稳定歌曲 ID；同曲同难度去重 |
| `difficulty` | `PST`、`PRS`、`FTR`、`BYD`、`ETR`、`INS` |
| `constant` / `score` | 定数 / 整数分数 |
| `clear` | `UNKNOWN`、`TL`、`EC`、`NC`、`HC`、`TC`、`FR`、`PM` |
| `far` / `lost` | 非负整数；未知留空不等于 0 |
| `ratingOverride` | 单曲 Potential 覆盖；清空恢复自动，也接受 `potentialOverride` 导入别名 |
| `video` / `audio` | 本地录像 / 独立音频 |
| `background` / `jacket` | 本曲背景 / 供图片组件使用的本曲图片；不自动回退到曲绘 |
| `audioMode` | `auto`、`video`、`audio`、`silent` |
| `start` / `duration` | 原录像开始位置 / 展示时长（秒） |
| `audioStart` | 独立音频起点；录像原声随录像开始位置 |
| `comment` | Unicode 文本，最多 500 个 UTF-16 单位；不拆开组合 emoji |

完整别名以 `shared/core.mjs` 为准。导入文件的相对媒体路径以该文件所在目录解析。

## .arcshow 工程

工程是 JSON，当前格式 `arcshow-b50videomaker`、结构版本 `2`。

- `entries`：成绩、裁剪、背景、短评与逐曲文字覆盖。
- `sequence`：单曲和动画的手动顺序；拖动不改变 Best 排名。
- `audioGroups`：共同音源、成员、起点、偏移和待确认对应。
- `excludedEntryIds`：从影片移除但保留的成绩。
- `settings`：规则、主题、输出、总览、时间声音与布局。
- `settings.sceneTransitions`：进入卡片的逐接点覆盖。
- `settings.componentLayout`：单曲 / 总览组件、黑底、图片及深度。

界面叫 Potential，旧持久化键仍用于兼容，请勿直接批量重命名。账号 `potential` 是选填文本，不等于 Best50 平均值。

## 共享与相对路径

`main/project-media.cjs` 遍历媒体字段；打开工程时按工程目录解析相对路径。本示例使用 `assets/gameplay/`、`assets/unlocks/`、`assets/backgrounds/`。

普通保存保留当前已解析路径，可能为绝对路径；保存工程不会打包素材。公开前移除 `sourceThumbnail`、`ocrRaw`、玩家信息、私人短评与本地路径。

示例时间针对参考录像，自己的录像若带不同长度片头、加载或结算画面，必须重新调整。
