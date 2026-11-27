---
name: genshin-music-scores
description: Use when analyzing, converting, arranging, or repairing Genshin music scores (.mid -> BetterGI 21-key midi JSON) using the built-in CLI and Python SDK.
---

# 原神琴谱制谱工具包（Genshin Music Scores）

## 定位与工作流
本 Skill 自包含全部制谱、诊断、编排、预览与验收脚本（位于同目录 `scripts/` 下）。
默认工作流：**`score_cli.py inspect` 看清底细 → 简单谱直接 `score_cli.py convert` → 复杂谱编写单曲 Python 脚本并 `import midi_to_midijson` → `score_cli.py verify` 过硬门禁 → 交付 `.json` 到 `app/index.html` 试听。**

---

## 一、核心约束（动手前先记住）

1. **琴的物理边界**：BetterGI 标准 21 键映射（`Z–M / A–J / Q–U`）= **C3–B5（MIDI 48–83，共 36 半音），纯 C 大调 7 个白键，无半音黑键**。
   - 原生 `.mid` 直接进游戏只做八度折叠、不吸附半音 → 升号音静默丢失。
   - 带和弦排的特殊乐器（上排为固定和弦按钮）仅剩 2 个音区（48–71），通用制作一律默认输出标准 21 键版。
2. **标准输出格式**：`type: "midi"` JSON，固定 `ticks: "1000", bpm: "60"`（1 tick = 1 ms）。
3. **协议硬陷阱**：
   - `D` = 按下、`U` = 抬起；同刻事件必须 **先 `U` 后 `D`**。
   - 单音最短时长 `30ms`；同键连续击键间隔必须 **≥ 30ms**（精修建议留 `35ms`），且在同键 `U -> D` 之间必须保留 `U@0` 占位符，防止触发 BetterGI 解析器的 30ms 游标漂移。
   - **单位规范**：`midi_to_midijson` 转换接口均使用**秒（float）**；`score_cli.py excerpt --win` 与 `decode_events()` 内部事件使用**毫秒（int）**。
   - **同音高叠置（长音未松 + 同刻重击）**：源 MIDI 常见「长音还按着、同一音高再击一次」（钢琴踏板/连奏）。拨弦琴一个键一次触键，做法是**把长音提前 35ms 松开，再从重击时刻按下**，保留成两个首尾相接的音块（前短、后长接到原长音结尾）——两次触键都留下来了。解析侧同理：同轨同通道同音高的 on/off 按 **LIFO 栈**配对（`parse_smf` 已如此实现），先读到的长音才不会被后来的重击顶掉。

---

## 二、统一命令行工具（`scripts/score_cli.py`）

以下子命令均通过统一入口 `python skills/genshin-music-scores/scripts/score_cli.py <子命令>` 执行（若 Skill 被复制到独立目录，改用对应目录路径即可，无需任何外部脚本依赖）：

| 子命令 | 作用 | 常用示例 |
|---|---|---|
| `inspect` | **陌生 MIDI 首选诊断**：一次输出 GM 轨角色/通道（自动标出通道 9 鼓轨）、分桶密度、24 调覆盖、`-6..+6` 移调黑键扫描表、顶声部音区与重复半场检测 | `score_cli.py inspect "歌.mid"`（可加 `--tracks-only` / `--structure-only`） |
| `convert` | **MIDI 转 21 键 JSON**：支持单首/批量、选轨、移调、限制同按、裁剪开头空拍与转换后顺带验收 | `score_cli.py convert "歌.mid" --name "曲名" --transpose -4 --trim-start --verify --outdir output` |
| `transpose` | **已有 JSON 整体平移**：最常用于 `±12` 升降八度，自带键合法性与重放强校验 | `score_cli.py transpose score.json --semitones -12 --outdir output` |
| `verify` | **交付前硬验收 / 外科手术对比**：跑 11 项硬指标（`FAIL` 退出码为 1）；传 `--diff-base` 证明编辑窗外零改动 | `score_cli.py verify "output/曲名.json" --mono`<br>`score_cli.py verify new.json --diff-base old.json --windows 115.5-117.3` |
| `excerpt` | **多版争议点 A/B 剪辑**：截取多份候选的指定毫秒区间拼成短对照 JSON | `score_cli.py excerpt output/ab --src A=a.json --src B=b.json --win 56000:62500` |
| `preview` | **快速渲 MP3 试听**（需 `numpy` + `ffmpeg`）：合成为加性拨弦音频用于多版差异对比 | `score_cli.py preview output/ab --outdir output/audio --bitrate 64k` |

---

## 三、决策矩阵：直接用 CLI vs 另写 Python 脚本精修

### 情况 A：直接用 `score_cli.py convert` 即可解决
- 单轨独奏或已明确选好目标轨（`--tracks 0,3` / `--melody-only`），整首移调后黑键率为 `0%`（或仅极少量装饰音 `snap` 可接受），配合 `--trim-start`、`--max-keys` 即可交付。

### 情况 B：必须另写针对性 Python 脚本（何时写 & 怎么写）
出现以下任一情况，**不要硬调 CLI 参数**，应编写独立的单曲 Python 处理脚本，并**直接复用同目录 `midi_to_midijson` SDK 作为编译与校验底座**：

1. **多轨编曲旋律轮换 / 存在延迟回声轨**：主旋律在不同乐器轨道间互补接力，或存在带延迟的复制回声轨。详见 [`references/multitrack-gm-midi-melody-extraction.md`](references/multitrack-gm-midi-melody-extraction.md)。
2. **高密度单轨 / 双手钢琴谱三层缩编**：
   - 单轨跨 5–6 个八度且全曲被复制两遍时，截去重复半场、按顶声部主音区过滤抽旋律。
   - 双手钢琴谱推荐按三层结构提取声部：
     - **主旋律层**：锁定右手主音区；遇到八度双音峰值超出 `B5(83)` 时，优先取同组内范围内（`C3–B5`）的八度音，或将整句小过门平移八度、用下方和弦音填充支撑，保持旋律轮廓连贯。
     - **句间过门层**：主旋律空档期保留中音区（如 `G3–G4`）的连接音与分解和弦，保持乐句衔接流畅。
     - **和弦与低音层**：在主旋律下方适度保留 1 个右手内声部和弦音（距主旋律 ≥ 3 半音）与折入 `C3–B3` 的低音根音/五度支撑（控制 `max_keys <= 4`）；左手琶音塌陷同键连按时，给出“局部手术 vs 分箱减薄”代价供用户选择。
3. **带弯音轮（Pitch Bend）的旋律**：`parse_smf()` 默认跳过 `0xE0` 字节与 RPN；当单音高频重复而原音频有音高起伏时，需自写小型 SMF 解析读取 `0xE0` 累加音高偏移。
4. **精细音乐性清理**：
   - **短半音倚音簇**：含移调后黑键的短滑音（时长 ≤ 250ms、间距 < 150ms），整簇删除并将时长提前归还给目标音。
   - **同键重击拆解**：拨奏琴上两声部撞到同键或间隔 `< 35ms`，调用 `m2.split_retriggers()` 缩短前音尾巴；遇到「长音 + 同音高重击」的叠置，按 35ms 间隔把长音断开再重按，让两次触键都留下，而不是并成一条长音。
   - **移调选定原则**：先求旋律不超出 `[48, 83]` 的可行移调集合，按“旋律完整 > 总保留音数 > 黑键最少”选定，绝不拆开伴奏和旋律单独按排硬折。
5. **中途转调歌曲**：`inspect` 提示最高调式覆盖率 `< 95%` 或全曲音级 `> 7` 个时，建议先按 `5s/10s` 时间窗扫描 24 大小调命中率以精确定界，再按时间切段分段移调或采用音区替代改编；同时向用户说明白键物理上限与听感取舍，直接提供可试听对照版。详见 [`references/modulated-song-arrangement.md`](references/modulated-song-arrangement.md)。
6. **多源谱面协同**：同时拥有 MIDI 与五线谱 PDF 时，推荐以 MIDI 的精确时间轴与音高作为主源，五线谱 PDF 用于核对调号、转调边界与主旋律轮廓。
7. **用户点名微调局部 / 整体调速**：
   - **局部外科手术**（「某秒删音」「空白段用低音脉冲和声填掉」）：直接在已确认的 `.json` 上按 [`references/surgical-edit-on-landed-json.md`](references/surgical-edit-on-landed-json.md) 修改，并用 `score_cli.py verify --diff-base` 证明窗外零变化。
   - **无损调速**：整体偏快或偏慢时**严禁缩放所有音符时间戳**，只修改 JSON 顶层 `bpm`/`ticks`（`1 tick = 60000 / (bpm * ticks)` ms），`notes` 原封不动。

### 自定义微调脚本的标准复用骨架

```python
import sys, json
sys.path.insert(0, "skills/genshin-music-scores/scripts")
import midi_to_midijson as m2

# 1. 解析源 MIDI（返回的 notes 均为秒单位 5 元组）
smf = m2.parse_smf("input.mid")
notes = smf["notes"]

# 2. 编写单曲编排逻辑，可选复用内置积木：
#    notes, _ = m2.trim_leading_silence(notes, target_start_s=0.30)
#    notes, _ = m2.cap_polyphony(notes, max_keys=6)
intervals, st = m2.convert(notes, mode="snap", transpose=-4)
#    如需要拨奏拆重击：intervals = m2.split_retriggers(intervals, gap_s=0.035)

# 3. 序列化与强校验（返回 4 元组，ok == True 才允许写出）
notes_str, _ = m2.to_midijson(intervals)
ok, max_dev, pairs, miss = m2.verify_intervals(intervals, notes_str)
assert ok, (max_dev, pairs, miss)

doc = m2.build_score_doc(
    "曲名", notes_str,
    description="来源、移调量、是否含半音吸附/裁剪说明",
)
with open("output/曲名.json", "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=1)
```

---

## 四、交付验收与文件管理规范

1. **交付硬门槛**：每次交付前必须同时满足 `m2.verify_intervals()` 通过且 `score_cli.py verify <成品.json>` 无 `FAIL`（纯单声部加 `--mono`）。
2. **试听交付方式**：优先交付 `.json` 引导用户在网页端 `app/index.html` 拖入直接试听，并**明确列出重点检查时间点**；需要对比局部版本差异时，再用 `excerpt` + `preview` 剪出短 MP3 对照；存在半音吸附或改编删减时如实写入 `description`。
3. **目录管理纪律**：
   - `output/`（已被 `.gitignore` 忽略）：默认转换输出目录；单曲多轮打磨放入独立子目录 `output/<曲名>/`，候选文件名写明具体处理做法（如 `传奇_-4调.json`、`传奇_+8调.json`），避免 `v1/v2/新版` 等模糊命名。
   - `library/`：公开示范曲库，**只存放确认定稿的 `.json`**，一首一档；同曲多改编在文件名和 `name` 字段带清楚限定词；覆盖修订后清理临时脚本或留在 `output/<曲名>/`，不污染仓库根目录。
