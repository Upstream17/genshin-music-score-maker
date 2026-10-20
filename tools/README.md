# tools/ — 脚本清单

把「源 → BetterGI 可演奏曲谱」的整条流水线拆成 8 个可单独跑的小工具。
所有脚本的 `ROOT` 都自动指向**本目录的上一级**（项目根），所以在项目根或 tools/ 里跑都行。

## 运行环境

| 需求 | 说明 |
|---|---|
| Python | **3.11 / 3.12**（本机建议 `D:\ProgramData\anaconda3\python`）。⚠ 系统默认的 `python` 是 3.14，**没有 numpy**，`render_preview.py` 会起不来 |
| numpy | 只有 `render_preview.py` 需要 |
| ffmpeg | 只有 `render_preview.py` 需要（在 PATH 里） |

除了 `render_preview.py`，其余脚本**只用标准库**（自带 SMF 解析器，不依赖 mido/pretty_midi）。

## 脚本一览

| 脚本 | 干什么 | 典型命令 |
|---|---|---|
| **`midi_to_midijson.py`** | **核心转换器**：`.mid` → `type:"midi"` JSON。自带 SMF 解析、八度折叠 + 半音吸附、30 ms 连按间隔、解析器级强校验 | `python tools/midi_to_midijson.py --mode snap` |
| `add_songs.py` | **单曲/批量入库**：任意源（`.mid`/`.midi`/`.json`/光遇 `.txt`）→ 转换 → 强校验 → 写进 `library-private/` 并更新清单 | `python tools/add_songs.py 歌曲.mid --name "曲名" --to 05_我的新增` |
| `sky_batch_migrate.py` | **光遇 Sky 整库迁移**：批量吃 Sky Studio 谱，按可弹性自动分档落盘 | `python tools/sky_batch_migrate.py --src <Songs> --out 试验_Sky` |
| `transpose_midijson.py` | **整体移调**（换八度 / 换调性）：每首过三道校验才写盘 | `python tools/transpose_midijson.py <目录> --semitones -12 --outdir <输出>` |
| `merge_library.py` | **合并成正式曲库**：各来源 → `library-private/`，统一命名、补原作者（`ARTISTS` 字典） | `python tools/merge_library.py` |
| `convert_dedupe.py` | **键谱转换 + 去重**：MRevenger `.txt` 键谱 → JSON；跨来源按规范化曲名去重 | `python tools/convert_dedupe.py` |
| `render_preview.py` | **试听**：把曲谱加性合成为 mp3（本地音色，非游戏音色） | `python tools/render_preview.py <文件或目录> --outdir 试听` |
| `download_sources.sh` | **拉源**：用 `git sparse-checkout` 下载各开源曲库到 `publicsource/sources/` | `bash tools/download_sources.sh` |

## 依赖关系

```
midi_to_midijson.py  ←── 核心（被下面三个复用）
   ├── add_songs.py          （spec 方式载入，同目录）
   ├── sky_batch_migrate.py  （sys.path 导入，同目录）
   ├── transpose_midijson.py （sys.path 导入，同目录）
   └── render_preview.py     （sys.path 导入，同目录）
```

⚠️ 它们**必须待在同一个目录里**（互相按「同目录」定位）。

## 目录约定

所有脚本的输入/输出都按项目标准目录定位：

| 路径 | 用途 |
|---|---|
| `library-private/` | 正式曲库（只有 `merge_library.py` / `add_songs.py` 会写） |
| `publicsource/sources/` | 原始下载的源文件（`download_sources.sh` 下载到这里） |
| `reports/` | 全部报告 CSV |
| `archive/中间产物/` | 转换的中间产物（`去重后曲库/`、`8_MIDI转换_MidiJson/`），`merge_library.py` 的输入 |
| `archive/非BetterGI格式/` | 不兼容格式的归档 |

## 关键约定（改代码前必读）

- **`D` = 按下，`U` = 抬起**；同键重击间隔 ≥30 ms；同刻事件先 `U` 后 `D`。
- 发射格式统一 `type:"midi"`、`ticks=1000`、`bpm=60` → **1 tick = 1 ms**，时刻 = 毫秒，零累计漂移。
- **写盘前必须过强校验**（复刻 `ParseMidiJsonTimeline` 重放 + 逐键比对按下区间，偏差 ≤2 ms），不过就不写。
- 命名：`name` 只写曲名；`author` = `原作者 | Hermes 转换`；技术细节全进 `description`。

更多细节（为什么丢音、30 ms 陷阱、整库降八度、外部钢琴谱怎么转）→ skill `bettergi-genshin-music-scores`。
