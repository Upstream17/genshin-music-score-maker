# 原神琴谱制谱器 · Genshin Music Score Maker

一套面向 **原神 21 键乐器（兼容 BetterGI 自动弹奏 `midi` JSON 规范）** 的开源制谱工作流与网页预览编辑台：

- **AI 制谱与编配工作流（`skill/`）**：沉淀多轨 MIDI 旋律抽取、判调移调、织体缩编、局部微调与交付前硬校验方法论——下载一首 `.mid`，交给 AI 即可结合工具链产出高质量 21 键谱面。
- **MIDI 转谱工具链（`tools/`）**：专注于 **`.mid` / `.midi` → 21 键 `midi` JSON** 转换、整体移调、本地试听渲染与强校验。
- **网页预览与编辑台（`app/`）**：零依赖、无构建的浏览器端播放器与卷帘编辑器，支持多音色试听、键盘弹奏/录制、音符精细编辑与 BetterGI JSON 导出；支持本地双击打开或部署到 Cloudflare 静态托管（在线地址：`https://yuanqin.upstream.eu.cc`）。

> 非官方个人工具，与 miHoYo / HoYoverse、与 BetterGI 开发者均无隶属关系。
> 代码以 **GPL-3.0** 发布；**不含游戏音频**；示范曲谱的版权状态见 [NOTICE.md](NOTICE.md)。

---

## 它解决什么问题

原神中的 21 键旋律乐器（如**风物之诗琴、老旧的诗琴、镜花之琴、谐律键琴、跃律琴、悠可琴、晚风圆号、余音**等）均共用同一套 **纯 C 大调、C3–B5、无半音键** 的 21 键映射。现成的 MIDI 文件几乎都超出这个音域与音阶——带升号的音会被**静默丢弃**，音域超界会被折叠，导致「导入后大量漏音」或「听着走调」。

本项目的工具链与 AI 工作流把这条路走通：

1. **判调与移调** → 将全曲整体移调至白键调（保持音程完整，不直接用变调半音硬裁）
2. **多轨分析与主旋律抽取** → 在多轨 MIDI 中识别主旋律与伴奏轨，清理回声轨与冗余叠音
3. **织体缩编与八度适配** → 控制音符密度与最大同按，让谱面真正贴合 21 键听感
4. **解析器级强校验** → 复刻 BetterGI 解析器语义逐键重放按下区间，偏差 ≤2 ms

生成后的 `.json` 可直接放进 `app/` 在线试听与精细编辑，省去反复切进游戏试弹的调试循环。

---

## 日常使用工作流

### A. 在线试听与编辑 → 打开演奏台

- **在线访问**：`https://yuanqin.upstream.eu.cc`（自动载入 `library/` 中的 18 首示范曲）
- **本地离线使用**：直接双击 [`app/index.html`](app/index.html)，将你的曲谱目录或单个 `.json` 文件拖进页面即可

主要功能：

- **21 键实时高亮**、音符合成卷帘、点击跳转
- **变速 0.5×–2×（不变调）**、列表循环 / 单曲循环 / 顺序播放
- **键盘弹奏与录制**：支持 `QWERTYU` / `ASDFGHJ` / `ZXCVBNM` 实时弹奏及按住录制
- **音符编辑**：点击落音、增删音符、改音高/时值、撤销、**导出 BetterGI JSON**
- **多乐器与多音色**：公开网页版开箱内置 **3 种 WebAudio 合成音色（竖琴 / 钢琴 / 音乐盒）** 并支持**导入自定义采样文件夹**；本机也可按需运行 `tools/fetch_samples.py` 生成 7 套游戏采样在本地离线切换

### B. 有一首 MIDI 想转成原琴谱子

**方式一：AI 驱动编配与微调（推荐，日常主力工作流）**

把 `skill/bettergi-genshin-music-scores/` 加载为 AI 助手的 Skill，直接发一首 `.mid` 文件给 AI：

1. AI 会先运行结构扫描与音轨分析脚本（`scan_midi_structure.py`、`list_midi_gm_tracks.py`）评估调性与主旋律；
2. 根据曲风自动确定移调、抽轨、和弦裁剪或局部八度微调方案，调用转换与强校验工具输出 JSON；
3. 生成后可直接在 `app/` 演奏台试听或 `render_preview.py` 导出试听音频，并按 `verify_delivery.py` 完成验收。

**方式二：命令行直接转换单曲 / 目录**

```bash
python tools/add_songs.py "path/to/song.mid" --name "曲名" --outdir output
# → output/曲名.json（默认输出到 ./output/，附带音轨统计与解析器强校验）
```

---

## 目录结构

```
.
├── app/                  ★ 网页演奏台与编辑台（零依赖、无构建；支持本地双击或静态托管）
│   ├── index.html        （CSS 已内联；classic script 直接加载）
│   ├── js/               解析器 / 音频引擎 / 界面（本地可选启用 samples*.js，不进 git）
│   └── tests/            5 套自动化测试 + 截图工具 + 采样生成器
├── skill/                ★ AI 驱动 MIDI → 21 键 JSON 编配与验收 Skill（方法论与分析脚本）
├── tools/                MIDI 转换、整体移调、试听渲染与静态站构建工具
├── library/              ★ 人工挑选的成品示范曲库（18 首，供工具演示与网页端在线试听）
├── LICENSE               GPL-3.0
└── NOTICE.md             ★ 来源与版权声明，开源前必读
```

---

## 工具一览

| 脚本 | 作用 |
|---|---|
| `tools/midi_to_midijson.py` | **核心转换器**：`.mid` → `type:"midi"` JSON（自带 SMF 解析、折叠/吸附、强校验） |
| `tools/add_songs.py` | **MIDI 单曲/批量转换**：支持 `--list-tracks`、`--tracks`、`--melody-only`、`--transpose`、`--max-keys` 与自定义输出目录 |
| `tools/transpose_midijson.py` | **整体移调**：对 21 键 `midi` JSON 做八度/半音平移并过三道强校验 |
| `tools/render_preview.py` | **音频预览**：把 `midi` JSON 合成为 mp3/wav 试听音频（合成音色） |
| `tools/fetch_samples.py` | **可选本机采样**：从开源模拟器仓库下载并生成本地 `app/js/samples*.js`（仅限本地自用，不随仓库分发） |
| `tools/build_site.py` | **构建静态站**：打包 `app/` 与 `library/` 到 `site/`（生成 `library/manifest.json`，适配 Cloudflare 托管） |

---

## 测试

```bash
node app/tests/integration.test.js       # 契约 + 示范库不变量
node app/tests/parse.test.js library     # 解析器回归（18 首示范曲 / 20,551 音符）
node app/tests/audio.test.js             # 音频引擎 / 文件名→音高映射
node app/tests/realtime.test.js          # 真实时间端到端（Chrome + CDP）
node app/tests/ui.test.js                # 音色 / 键盘弹奏 / 编辑 / 连播（Chrome + CDP）
```

---

## 关于版权

- **代码**：GPL-3.0。解析器语义按 GPL-3.0 协议开源的 BetterGI 复刻，因此本项目代码同样以 GPL-3.0 发布。
- **游戏音频不随仓库分发**：公开仓库与线上网页版仅提供内置 WebAudio 合成音色，并支持用户自行加载本地采样文件夹；游戏采样版权归 miHoYo 所有。
- **`library/` 示范曲目**：人工挑选的 18 首成品展示曲谱，用于演示工具链输出效果与网页端直接试听。词曲著作权归原作者/权利方所有，如权利人有异议，请提 Issue，我们会直接移除对应文件。

详见 [NOTICE.md](NOTICE.md)。

---

## 相关项目

- [BetterGI](https://github.com/babalae/better-genshin-impact) — 曲谱格式与演奏语义的事实标准
- [WindsongLyre-Simulator](https://github.com/JularDepick/WindsongLyre-Simulator.fork) — 乐器采样参考来源
