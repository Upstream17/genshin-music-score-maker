# 原神琴谱制谱器 · Genshin Music Score Maker

> **在线体验演奏台**：[https://yuanqin.upstream.eu.cc/](https://yuanqin.upstream.eu.cc/) （打开即用，自动加载 31 首示范曲目，支持桌面 / 平板 / 手机自适应与夜间模式，自动缓存个人修改草稿）

一套面向 **原神 21 键乐器（兼容 BetterGI 自动弹奏 `midi` JSON 规范）** 的开源制谱工作流与网页预览编辑台：

- **AI 制谱 Skill 工具包（`skills/genshin-music-scores/`）**：自包含全部 `.mid` / `.midi` → 21 键 `midi` JSON 工具与编配方法论（分析、转换、移调、试听渲染、交付验收全收于一套统一工具）——下载一首 `.mid`，交给 AI 即可产出高质量 21 键谱面。
- **网页预览与编辑台（`app/`）**：零依赖、无构建的浏览器端播放器与卷帘编辑器，支持多音色试听、键盘弹奏/录制、音符精细编辑与 BetterGI JSON 导出；支持本地双击打开或部署到 Cloudflare 静态托管（[在线演奏台](https://yuanqin.upstream.eu.cc/)）。

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

- **在线访问**：[https://yuanqin.upstream.eu.cc/](https://yuanqin.upstream.eu.cc/)（自动载入 `library/` 中的 31 首示范曲）
- **本地离线使用**：直接双击 [`app/index.html`](app/index.html)，将你的曲谱目录或单个 `.json` 文件拖进页面即可

主要功能：

- **21 键实时高亮**、音符合成卷帘、点击跳转
- **变速 0.5×–2×（不变调）**、列表循环 / 单曲循环 / 顺序播放
- **键盘弹奏与录制**：支持 `QWERTYU` / `ASDFGHJ` / `ZXCVBNM` 实时弹奏及按住录制
- **音符编辑**：点击落音、增删音符、改音高/时值、撤销、**导出 BetterGI JSON**
- **多乐器与多音色**：公开网页版开箱内置 **3 种 WebAudio 合成音色（竖琴 / 钢琴 / 音乐盒）** 并支持**导入自定义采样文件夹**；本机也可按需运行 `app/scripts/fetch_samples.py` 生成 8 套游戏采样（含晚风圆号）在本地离线切换

### B. 有一首 MIDI 想转成原琴谱子

**方式一：AI 驱动编配与微调（推荐，日常主力工作流）**

把 `skills/genshin-music-scores/` 加载为 AI 助手的 Skill（或直接在仓库根目录呼出 AI），发一首 `.mid` 文件给它：

1. AI 会先用 `score_cli.py inspect` 一次分析音轨角色、调性与移调候选；
2. 简单曲目直接用 `score_cli.py convert`，复杂曲目自动编写单曲 Python 微调脚本并复用 `midi_to_midijson` 引擎与强校验；
3. 交付前用 `score_cli.py verify` 完成硬验收，然后拖进 `app/` 演奏台试听（或用 `excerpt` + `preview` 对比局部分歧）。

**方式二：命令行直接转换单曲 / 目录**

```bash
python skills/genshin-music-scores/scripts/score_cli.py convert "path/to/song.mid" --name "曲名" --verify --outdir output
# → output/曲名.json（支持 --transpose / --tracks / --melody-only / --trim-start / --max-keys）
```

---

## 目录结构

```
.
├── skills/genshin-music-scores/  ★ 自包含 AI 制谱工具包（Skill + 统一 CLI + 核心引擎 + 参考手册）
│   ├── SKILL.md
│   ├── scripts/                  score_cli.py / midi_to_midijson.py / inspect_midi.py / verify_score.py / audio_preview.py
│   └── references/               多轨抽取 / 转调改编 / 局部外科手术指南
├── app/                          ★ 网页演奏台与编辑台（零依赖、无构建；支持本地双击或静态托管）
│   ├── index.html                （CSS 已内联；classic script 直接加载）
│   ├── js/                       解析器 / 音频引擎 / 界面（本地可选启用 samples*.js，不进 git）
│   ├── scripts/                  网页工程脚本（build_site.py 构建静态站 / fetch_samples.py 拉取可选采样）
│   └── tests/                    5 套自动化测试 + 截图工具 + 采样生成器
├── library/                      ★ 人工挑选的成品示范曲库（31 首，供工具演示与网页端在线试听）
├── LICENSE                       GPL-3.0
└── NOTICE.md                     ★ 来源与版权声明，开源前必读
```

---

## 命令行工具一览

| 入口 / 模块 | 作用 |
|---|---|
| `skills/.../scripts/score_cli.py` | **统一制谱 CLI**：集成 `inspect`（轨与调性诊断）/ `convert`（转换）/ `transpose`（整体移调）/ `verify`（硬验收与区外零改动证明）/ `excerpt`（A/B 剪辑）/ `preview`（MP3 预览） |
| `skills/.../scripts/midi_to_midijson.py` | **核心引擎 & Python SDK**：唯一 SMF 解析、21 键映射、D/U 防漂移序列化与 `verify_intervals` 强校验 |
| `app/scripts/fetch_samples.py` | **可选本机采样**：从开源模拟器仓库下载并生成本地 `app/js/samples*.js`（仅限本地自用，不随仓库分发） |
| `app/scripts/build_site.py` | **构建静态站**：打包 `app/` 与 `library/` 到 `site/`（生成 `library/manifest.json`，适配 Cloudflare 托管） |

---

## 测试

```bash
node app/tests/integration.test.js       # 契约 + 示范库不变量
node app/tests/parse.test.js library     # 解析器回归（31 首示范曲 / 36,455 音符）
node app/tests/audio.test.js             # 音频引擎 / 文件名→音高映射
node app/tests/realtime.test.js          # 真实时间端到端（Chrome + CDP）
node app/tests/ui.test.js                # 音色 / 键盘弹奏 / 编辑 / 连播（Chrome + CDP）
```

---

## 关于版权

- **代码**：GPL-3.0。解析器语义按 GPL-3.0 协议开源的 BetterGI 复刻，因此本项目代码同样以 GPL-3.0 发布。
- **游戏音频不随仓库分发**：公开仓库与线上网页版仅提供内置 WebAudio 合成音色，并支持用户自行加载本地采样文件夹；游戏采样版权归 miHoYo 所有。
- **`library/` 示范曲目**：人工挑选的 31 首成品展示曲谱，用于演示工具链输出效果与网页端直接试听。词曲著作权归原作者/权利方所有，如权利人有异议，请提 Issue，我们会直接移除对应文件。

详见 [NOTICE.md](NOTICE.md)。

---

## 相关项目

- [BetterGI](https://github.com/babalae/better-genshin-impact) — 曲谱格式与演奏语义的事实标准
- [WindsongLyre-Simulator](https://github.com/JularDepick/WindsongLyre-Simulator.fork) — 乐器采样参考来源
- [Specy/genshin-music](https://github.com/Specy/genshin-music) — 晚风圆号（NightwindHorn）采样参考来源
