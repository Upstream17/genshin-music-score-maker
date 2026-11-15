# tools/ — MIDI 制谱与构建脚本

围绕「`.mid` → BetterGI 可演奏 21 键 `midi` JSON」提供转换、移调、试听与静态站构建工具。
所有脚本的 `ROOT` 都自动指向项目根目录，在项目根或 `tools/` 下执行均可。

## 运行环境

| 需求 | 说明 |
|---|---|
| Python | **3.11 / 3.12+**。仅 `render_preview.py` 需要额外安装 `numpy` 与 `ffmpeg` |
| numpy / ffmpeg | 仅 `render_preview.py`（及 `fetch_samples.py` 可选转码）需要 |

其余转换与构建脚本**仅使用 Python 标准库**（自带 SMF 解析器，不依赖 `mido` / `pretty_midi`）。

## 脚本一览

| 脚本 | 作用 | 典型命令 |
|---|---|---|
| **`midi_to_midijson.py`** | **核心转换器**：`.mid` → `type:"midi"` JSON。自带 SMF 解析、八度折叠 + 半音吸附、30 ms 连按间隔与解析器强校验 | `python tools/midi_to_midijson.py song.mid --outdir output` |
| `add_songs.py` | **MIDI 单曲/目录转换**：支持列出音轨统计、按轨筛选、限制最大同按、整体移调、强校验并写盘 | `python tools/add_songs.py song.mid --name "曲名" --outdir output` |
| `transpose_midijson.py` | **整体移调**：对已生成的 `midi` JSON 做整体平移（如 `-12` 降八度引入低音区），过三道校验才写盘 | `python tools/transpose_midijson.py output/ --semitones -12 --outdir output_shifted` |
| `render_preview.py` | **本地音频预览**：把 `midi` JSON 合成为 mp3（本地拨弦合成音色，便于快速核对旋律） | `python tools/render_preview.py output/曲名.json --outdir output_audio` |
| `fetch_samples.py` | **可选本地采样准备**：从开源模拟器拉取 21 音采样生成 `app/js/samples*.js`（仅供本地自用，已 gitignore） | `python tools/fetch_samples.py` |
| `build_site.py` | **构建纯静态站**：打包 `app/` + `library/` 到 `site/` 并生成 `library/manifest.json`（适配 Cloudflare 部署） | `python tools/build_site.py` |

## 依赖关系

```
midi_to_midijson.py  ←── 核心（被以下工具复用）
   ├── add_songs.py          （spec 方式载入，同目录）
   ├── transpose_midijson.py （sys.path 导入，同目录）
   └── render_preview.py     （sys.path 导入，同目录）
```

> 这些工具需要保持在同一个目录 `tools/` 下。

## 关键约定

- **`D` = 按下，`U` = 抬起**；同键重击间隔 ≥ 30 ms；同刻事件先 `U` 后 `D`。
- 输出格式统一采用 `type:"midi"`、`ticks=1000`、`bpm=60`（**1 tick = 1 ms**，时刻精确对应毫秒）。
- **写盘前必须过强校验**：使用复刻的 `ParseMidiJsonTimeline` 重放按下区间并逐键比对，偏差 ≤ 2 ms。
