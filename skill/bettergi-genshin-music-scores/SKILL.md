---
name: bettergi-genshin-music-scores
description: Use when converting, arranging, or repairing BetterGI 21-key Genshin music scores (.mid -> midi JSON) with project tools and custom Python post-processing.
---

# BetterGI 原神自动演奏曲谱制作规范

## 触发场景
收到「把 `.mid` 转成原琴谱 / 制作或精调 BetterGI 自动演奏 JSON / 修掉丢音、跑调、空白、抢拍、缺低音」等任务时加载本 skill。
默认工作流：**用脚本分析 MIDI → 能用工具直出就用 CLI → 需要编曲/精修时写单曲脚本并复用 `tools/midi_to_midijson.py` → 跑完硬验收后交付 `.json` 到 `app/index.html` 试听。**

---

## 一、核心约束（动手前先记住）

1. **琴的物理边界**：BetterGI 标准 21 键映射（`Z–M / A–J / Q–U`）= **C3–B5（MIDI 48–83，共 36 半音），纯 C 大调 7 个白键，无半音黑键**。
   - 原生 `.mid` 直接进游戏会只做八度折叠、不吸附半音 → 所有升号音静默丢失。
   - 带和弦排的特殊乐器（如上排为固定和弦按钮的乐器）只剩 2 个音区（48–71），通用制作一律默认输出标准 21 键原琴版。
2. **推荐输出格式**：优先输出 `type: "midi"` 的 BetterGI JSON，固定时间基准 `ticks: 1000, bpm: 60`（即 **1 tick = 1 ms**）。
3. **协议硬陷阱**：
   - `D` = 按下、`U` = 抬起；同刻事件必须 **先 `U` 后 `D`**。
   - 单音最短时长 `30ms`（在区间阶段钳位，不要在发射阶段才改）。
   - 同键连续击键间隔必须 **≥ 30ms**（脚本精修建议留 `35ms`），并在同键 `U -> D` 间插入占位符 `U@0`，否则会触发 BetterGI 解析器的 30ms 全局游标偏移导致整首“越弹越快”。
   - **单位陷阱**：`tools/midi_to_midijson.py` 核心函数全部吃**秒（float）**；`scripts/make_ab_excerpt.py` 的 `--win` 吃**毫秒**。导出后务必核对末事件时刻是否与源曲时长同量级。

---

## 二、已有工具能做什么（不要重复造轮子）

### 1. 仓库工具（`tools/`）

| 工具 | 用途 | 常用命令（在项目根目录执行） |
|---|---|---|
| `tools/add_songs.py` | **单首快速转换**：将 `.mid/.midi` 转为 `type:"midi"` JSON，支持选轨、移调、限制最大并发键数 | `python tools/add_songs.py "歌.mid" --name "曲名" --outdir output` |
| `tools/midi_to_midijson.py` | **批量转换 & 核心编译底座**：同上，批量将目录内 `.mid` 按 `snap/drop/raw` 转出（同时供自定义脚本 `import`） | `python tools/midi_to_midijson.py midi_dir/ --mode snap --outdir output` |
| `tools/transpose_midijson.py` | **已有 JSON 整体移调**：对现有 `type:"midi"` JSON 整体平移半音并做重放强校验（最常用于 `±12` 升降八度） | `python tools/transpose_midijson.py score.json --semitones -12 --outdir output` |
| `tools/render_preview.py` | **快速渲 MP3 试听**（需 `numpy` + `ffmpeg`）：加性合成仅用于对比同一片段差异，实际音色以 `app/` 或游戏为准 | `python tools/render_preview.py score.json --outdir output/audio --bitrate 64k` |
| `app/index.html` | **交互式演奏与微调台**：本地静态网页（或部署站点），拖入 `.json` 即可直接选音色试听与微调 | 浏览器打开 `app/index.html` 或使用预览站点 |

> **CLI 关键参数速览**：`add_songs.py` 支持 `--list-tracks`、`--tracks 0,3`、`--melody-only`、`--transpose N`、`--max-keys K`、`--dry-run`、`--outdir`、`--name`。

### 2. 分析与门禁脚本（`skill/bettergi-genshin-music-scores/scripts/`）

| 脚本 | 作用 | 命令 |
|---|---|---|
| `scan_midi_structure.py` | **陌生 MIDI 首选第一步**：一次输出轨概要、分桶密度、调性中心、`-11..+11` 移调黑键率表、顶声部音区与重复段检测 | `python skill/bettergi-genshin-music-scores/scripts/scan_midi_structure.py "歌.mid"` |
| `list_midi_gm_tracks.py` | **多轨 GM 盘点**：列出每轨 GM 乐器、通道（标出第 9 通道鼓轨）、时间跨度与并发度，排查主旋律与回声轨 | `python skill/bettergi-genshin-music-scores/scripts/list_midi_gm_tracks.py "歌.mid"` |
| `verify_delivery.py` | **交付前硬门禁**：跑 11 项检查（八度跳、>2s 空档、时长中位数 ≥150ms、同键重击间隔等），有 `FAIL` 退出码为 1 | `python skill/bettergi-genshin-music-scores/scripts/verify_delivery.py "output/成品.json" [--mono]` |
| `diff_press_intervals.py` | **外科手术零误伤证明**：对比修改前后的 `.json`，证明指定 `--windows` 时间窗之外的所有按压区间完全一致 | `python skill/bettergi-genshin-music-scores/scripts/diff_press_intervals.py old.json new.json --tools tools --windows 115.5-117.3` |
| `make_ab_excerpt.py` | **多版争议点 A/B 剪辑**：抽取多个候选 JSON 的指定毫秒区间拼接成短对照 JSON，方便快速对比 | `python skill/bettergi-genshin-music-scores/scripts/make_ab_excerpt.py output/ab --src A=a.json --src B=b.json --win 56000:62500` |

---

## 三、决策矩阵：直接用工具 vs 另写 Python 脚本微调

### 情况 A：直接用 `tools/` CLI 即可解决
- 单轨独奏 MIDI（或已选好 1–2 条目标轨），全局移调后黑键率为 `0%`（或仅极少量装饰音 `snap` 可接受），且首尾无超长空白、结构无重复拼接。
- 只需整体升降八度（`transpose_midijson.py --semitones -12`）。

### 情况 B：必须另写针对性 Python 脚本（何时写 & 怎么写）
只要源 MIDI 或用户反馈出现以下任一情况，**不要硬调 CLI 参数**，应针对该曲目编写独立的 Python 处理脚本：

1. **多轨编曲旋律轮换 / 存在延迟回声轨**：主旋律分散在不同乐器的多个轨道中互补，或同音色副轨是带延迟的回声（需去重而非合并）。详细步骤见 [`references/multitrack-gm-midi-melody-extraction.md`](references/multitrack-gm-midi-melody-extraction.md)。
2. **单轨高密度素材 / 双手钢琴谱需织体缩编**：
   - 单轨塞满全声部且跨 5–6 个八度（或把全曲复制弹了两遍）：需裁掉重复半场、按顶声部主音区带抽旋律。
   - 双手钢琴谱做三层缩编：右手按每个音头取主旋律 + 内声部（内声部低于当前响着的旋律音，若旋律含八度加倍通常取低八度副本），左手低音折入 `C3–B3`；若左手琶音塌成同键高频连击，需给出“局部手术 vs 低音分箱减薄”的取舍，不擅自把织体变薄。
3. **带弯音轮（Pitch Bend）的旋律**：`m2.parse_smf()` 会跳过 `0xE0` 弯音字节与 RPN；当某轨呈现“同音高频重复但原始听感有音高起伏”时，必须自写轻量 SMF 读入逻辑累加 `0xE0` 偏移（并检查 RPN 弯音范围是否非默认 ±2 半音）。
4. **精细音乐性清理与开头裁剪**：
   - **前导静音裁剪**：源 MIDI 从第 2–3 小节起音时，将首音时刻整体平移至约 `0.30s`（只调整首事件 delta 或在区间阶段统一平移）。
   - **短半音倚音簇**：含移调后黑键的短滑音簇（时长 ≤ 250ms、间距 < 150ms），整簇删除并将被占时长还给目标音（提前目标音起点）。
   - **同键重击拆解**：拨奏琴上两声部撞到同键或间隔 `< 35ms` 时，保留后一次击键并把前音截止时刻提前至 `next_start - 0.035`（不得合并成单长音而吞掉节奏）。
   - **按主旋律完整度与“零折叠”选移调**：先求旋律音高在 `[48, 83]` 内的可行移调集合，再按“旋律完整 > 保留总音数 > 黑键最少”选定移调量；同余类多个八度备选时，保留候选供试听定案，绝不把伴奏与旋律拆开按排硬折（会破坏音程关系）。
5. **中途转调歌曲**：全曲音级超过 7 个时，按时间切分段落分段移调或做音区替代改编（先向用户说明代价）。详细路线见 [`references/modulated-song-arrangement.md`](references/modulated-song-arrangement.md)。
6. **用户点名微调局部 / 调整整体速度**：
   - **局部外科手术**（「某分某秒删掉某音」「空白段用低音脉冲和声填掉，其余别动」）：直接在已确认版本上按 [`references/surgical-edit-on-landed-json.md`](references/surgical-edit-on-landed-json.md) 修改，并用 `diff_press_intervals.py` 证明窗外音符 0 变化。
   - **速度偏快 / 偏慢**：**禁止缩放所有音符时间戳**（防舍入漂移）。只修改 JSON 顶层 `ticks` 和 `bpm`（`1 tick = 60000 / (bpm * ticks)` ms），`notes` 数据一字不动（注意 `render_preview.py` 不读 `bpm`/`ticks`，若需渲染慢放 MP3 需先按比例缩放间隔再渲染试听副本）。

### 自定义微调脚本的标准复用骨架（核心原则）
**自己写“选轨/移调/缩编/局部改音”逻辑，但永远把 `tools/midi_to_midijson.py` 当作编译器后端与校验器：**

```python
import sys, json
sys.path.insert(0, "tools")
import midi_to_midijson as m2

# 1. 解析源 MIDI -> [(start_s, end_s, pitch, track_idx, channel), ...]
smf = m2.parse_smf("input.mid")
raw_notes = smf["notes"]

# 2. 在此编写定制精调逻辑，输出五元组 notes_for_convert（单位：秒）
#    或直接构造合法白键区间 intervals = [(start_s, end_s, pitch_in_KEYMAP), ...]
intervals, st = m2.convert(notes_for_convert, mode="snap", transpose=best_tr)

# 3. 序列化（返回 (notes_str, events)，自动处理 D/U、30ms 间隔与 U@0 防漂移占位）
notes_str, _ = m2.to_midijson(intervals)

# 4. 强校验（必跑，ok == True 即偏差 <= 2ms 且无漏音才允许写出）
ok, max_dev, pairs, miss = m2.verify_intervals(intervals, notes_str)
assert ok, (max_dev, pairs, miss)

doc = {
    "name": "曲名",
    "description": "来源、移调量、是否含半音吸附/分段说明",
    "type": "midi",
    "bpm": 60,
    "ticks": 1000,
    "notes": notes_str,
}
with open("output/曲名.json", "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False)
```

---

## 四、交付验收与文件管理规范

### 1. 交付前硬验收（每次出谱必跑）
1. **协议校验**：脚本内 `m2.verify_intervals()` 通过（`ok == True`）。
2. **听感与结构门禁**：运行 `scripts/verify_delivery.py <成品.json>`（纯单旋律加 `--mono`）：
   - 无 `FAIL`（重点核对：**同句八度跳比例**、**折叠数**、**>2s 长空档是否为原曲自然停顿**、**时长中位数 ≥ 150ms**、**前 30 音是否吻合主题**）。
3. **试听交付方式**：
   - **优先交付 `.json`**：提醒用户在 [`app/index.html`](../../app/index.html) 拖入试听（零等待、音色接近实机），并**明确告知重点检查的时间点**（如「重点听 1:12–1:28 主旋律衔接、2:19 句尾是否断音」）。
   - 若涉及全局无损/有损替换（如存在半音吸附或删减片段），在 `description` 与回复中**如实写明**，不虚标“无损”。

### 2. 文件与目录管理纪律
- **`output/`（默认临时与工作目录，已由 `.gitignore` 忽略）**：
  - 常规批量转换直接输出到 `output/`。
  - **单曲多轮打磨**时，集中放到独立子目录 `output/<曲名>/`，存放源 `.mid`、精调脚本、各候选 `.json` 及对比 `.mp3`。
  - 候选文件名**写清实际处理方案**（例如 `传奇_-4调_原版短音.json`、`传奇_+8调.json`），不要用 `v1/v2/新版/最终版` 等含糊命名。
- **`library/`（仓库公开精选示范库）**：
  - **只存放已确认定稿的 `.json` 成品**，一首歌一个主文件（不放中间 `.mid`、草稿或 `.mp3`）。
  - 同一首歌若同时保留多个改编路线，文件名与 JSON 内部 `name` 都必须带清楚限定词（如 `《XX（同调版）》`），方便在播放器与 BetterGI 列表中区分。
  - 修订定稿时**直接覆盖目标成品文件**，清理临时调试脚本或仅留在 `output/<曲名>/` 中，不污染项目根目录与 git 提交区。
