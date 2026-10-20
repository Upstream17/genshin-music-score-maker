# 原神乐器音色采样的合规获取路径（调研报告）

> 任务：`task-1`
> 结论面向：**本地网页播放器（`file://` 双击可开）是否/如何复用原神音色**
> 调研时间：2026-10-18
> 说明：每条结论后附 URL 证据。**凡本报告未直接抓取到原文的，明确标注「未验证」**；找不到公开来源的，写「未找到公开来源」。
> 本报告的推荐路径直接影响 `player/js/audio-engine.js` 的默认行为（见 §6）。

---

## 0. 一句话结论

**没有**找到任何「许可清晰、可直接随播放器分发的风物之诗琴 21 音采样集」。
社区确实存在**从游戏包提取的 21 个单音 mp3**（公开仓库里可下载），但这些仓库**没有给出任何许可声明**，音频版权属于 miHoYo，**不能作为交付物的一部分再分发**。
因此推荐路径 = **播放器只内置程序合成音色（默认、零资源、无版权问题）+ 提供 `loadSampleFiles()` 让用户用自己手上的文件（自己的游戏、自己的录音）在本地加载，音频永不上传、永不进仓库。**

---

## 1. 原神音频能否从游戏包提取？

### 1.1 能。技术链路已成熟

原神的音频以 **Wwise** 打包的 `.pck` 形式随游戏分发，位置公开在导出工具的 README 里：

> "The audio files are saved as `.pck` data files within the Genshin Impact game data directory.
> `C:\Program Files\Genshin Impact\Genshin Impact Game\GenshinImpact_Data\StreamingAssets\AudioAssets`"

- 证据：<https://github.com/dvingerh/genshin-audio-exporter>（README，MIT license，191 stars）
  该工具支持导出 `.wav` / `.mp3` / `.ogg` / `.flac`，单文件 exe，无需命令行。

同类可用工具链（均已确认仓库存在）：

| 工具 | 用途 | URL | 许可 |
|---|---|---|---|
| `dvingerh/genshin-audio-exporter` | 直接读原神 `.pck` 导出多格式 | <https://github.com/dvingerh/genshin-audio-exporter> | MIT（README 标注） |
| `Escartem/AnimeWwise` | 提取 hoyo 游戏音频，**保留原始文件名与路径**（Genshin / StarRail / Zenless / Endfield） | <https://github.com/Escartem/AnimeWwise> | 未验证（未抓取 LICENSE 文件） |
| `Vextil/Wwise-Unpacker` | 通用 Wwise `.pck` / `.bnk` 解包 | <https://github.com/Vextil/Wwise-Unpacker> | 未验证 |
| `vgmstream/vgmstream` | 游戏流式音频解码库，**支持 Wwise 格式**，`foo_input_vgmstream` 是其 foobar2000 组件 | <https://github.com/vgmstream/vgmstream> ；组件页 <https://www.foobar2000.org/components/view/foo_input_vgmstream> | 未验证（未抓取 LICENSE） |
| `bnnm/wwiser` | 解析 Wwise `.bnk` 内部事件/媒体 ID 与名字，便于定位具体音效 | <https://github.com/bnnm/wwiser> | 未验证 |

> 社区工具生态证明：**"从自己的游戏安装提取风物之诗琴音频"在技术上完全可行**，且不需要任何付费工具。

### 1.2 风物之诗琴（Windsong Lyre）的 Wwise 事件 ID / 媒体 ID

- **未找到公开来源。**
- 我在公开检索中没有找到任何文档、wiki 或仓库列出「风物之诗琴」对应的 Wwise Event ID / Media ID / SoundBank 名。
- 与之最接近的公开资料是 Windblume 活动期间 `wwiser` 这类 `.bnk` 解析器的用法本身（先解出 ID→名字映射，人肉定位），而不是现成的 ID 清单：
  - <https://github.com/bnnm/wwiser/blob/master/doc/WWISER.md>（说明其可按 bank 分组列出 names 与 IDs）
- 官方侧唯一相关的公开材料是 AudioKinetic 对原神音频团队的访谈（只讲设计，不含 ID）：
  - <https://www.audiokinetic.com/community/wwisetour/jvp397t6iqg>

**诚实结论：** 想精确定位"风物之诗琴这一件乐器的 21 个采样"，需要自己用 `wwiser` + `AnimeWwise`/`genshin-audio-exporter` 现场比对试听，**没有捷径可抄**。这是"用户自备采样"路径的**主要摩擦点**，必须在交付时如实告知用户。

### 1.3 乐器条目背景（非音频）

风物之诗琴的获取方式与外观（说明这是**常驻可得的乐器**，不是限时独占）：
- <https://genshin-impact.fandom.com/wiki/Windsong_Lyre>
- <https://game8.co/games/Genshin-Impact/archives/322600>

---

## 2. 是否已有社区提取/重打包的「风物之诗琴 21 音」采样集或 soundfont？

### 2.1 找到了：**21 个单音 mp3**，在公开仓库里（但无许可声明）

`haveyouwantto/WindsongLyre-Sim`（原神风物之诗琴模拟器，51 stars，**已于 2023-06-24 归档只读**）的 `instruments/` 下按乐器分目录存放音频，其中 `windsong_lyre/audio/` 的实际文件（GitHub Contents API 实抓）：

```
1.mp3   1+.mp3   1-.mp3
2.mp3   2+.mp3   2-.mp3
3.mp3   3+.mp3   3-.mp3
4.mp3   4+.mp3   4-.mp3
5.mp3   5+.mp3   5-.mp3
6.mp3   6+.mp3   6-.mp3
7.mp3   7+.mp3   7-.mp3      → 7 × 3 = 21 个单音，每个约 18–47 KB
```

- 证据（仓库）：<https://github.com/haveyouwantto/WindsongLyre-Sim>
- 证据（音频目录 API 实抓）：<https://api.github.com/repos/haveyouwantto/WindsongLyre-Sim/contents/instruments/windsong_lyre/audio>
- 同一仓库还含 `floral_zither/`（镜花之琴）、`floral_zither_old/`、`vintage_lyre/`（老旧的诗琴），每种同样是 21 音。
- **命名法**：`1`–`7` = do–si（简谱），`+` = 升号，`-` = 降号。**这是"每个音符一个独立采样"的方案，不是 soundfont。**
- **许可：无。** 仓库根目录只有 `README.md`、`_config.yml`、`index.html`、`manifest.json` 等，**没有 LICENSE 文件**（仓库头部的 "Resources" 区块未出现 license 标注）。→ **没有授予任何再分发许可。**

### 2.2 找到了：另一个网页版自带 PCK 提取器 + 音频目录

`System233/system233.github.io` —「风物之诗琴网页版，支持 osu!std 模式、**PCK资源提取器**」（7 stars）：

> "此工具用于读取由 wwise 打包的 PCK 音频文件，支持在线播放，也支持下载已解析的 wav 音频。"

- 证据：<https://github.com/System233/system233.github.io>
- 仓库内含 `assets/sounds/`、`pck-reader/`、`windsong/` 三个目录。
- **许可：无。** 仓库根目录没有 LICENSE 文件（只有 `README.md`、`_config.yml`、`index.md`）。→ **无再分发许可。**
- 这个项目的意义在于：**它把"用户自己丢 PCK 进来 → 网页里解出 wav → 直接弹"做成了产品**，等于用工程手段绕开了"随包分发音频"的版权问题。**这是我们推荐路径的现实先例。**

### 2.3 未找到：风物之诗琴的 `.sf2` / soundfont

- 我针对 "genshin lyre soundfont sf2"、"原神 音源 采样 sf2" 等做多轮检索，**未找到任何公开的、把风物之诗琴做成 `.sf2` / `.sfz` soundfont 的项目**。
- 命中的都是**无关乐器**，不要误引：
  - Polyphone 的 "Harp Strings" → <https://www.polyphone.io/en/soundfonts/plucked-strings/438-harp-strings>（普通竖琴，非原神，许可见 §5）
  - Polyphone 的 "Ancient Instruments Of The World"（含 Lyre Harp / Bone Flute）→ <https://www.polyphone.io/en/soundfonts/soundscapes/530-ancient-instruments-of-the-world>（非原神）
  - "Celtic Harp [Haug Harp] SoundFont" → <https://www.polyphone.io/en/soundfonts/plucked-strings/557-celtic-harp-haug-harp-soundfont>（非原神）

**结论：原神风物之诗琴的 soundfont 版本 —— 未找到公开来源。可用的只有"21 个裸 mp3"，且无许可。**

---

## 3. GitHub 上现有网页端原神琴/风物之诗琴模拟器，各自用什么音色方案？

| # | 仓库 / 站点 | 音色方案 | 许可 | 证据 |
|---|---|---|---|---|
| 1 | **`haveyouwantto/WindsongLyre-Sim`**<br>在线版 <https://haveyouwantto.github.io/WindsongLyre-Sim/> | **采样**：`instruments/<乐器>/audio/{1..7}{,+,-}.mp3`，每种乐器 21 个**游戏提取的 mp3 单音**，`manifest.js` 索引 | **无 LICENSE**（已归档） | <https://github.com/haveyouwantto/WindsongLyre-Sim> ；音频目录 <https://api.github.com/repos/haveyouwantto/WindsongLyre-Sim/contents/instruments/windsong_lyre/audio> |
| 2 | **`System233/system233.github.io`**（风物之诗琴网页版）<br>在线版 <https://system233.github.io/windsong> | **采样 + 自带 Wwise PCK 解析器**：`assets/sounds/` 放音频，`pck-reader/` 让用户**在线解 .pck 并播放/下载 wav** | **无 LICENSE** | <https://github.com/System233/system233.github.io> |
| 3 | **`Specy/genshin-music`**（Genshin Music Nightly）<br>在线版 <https://genshin-music.specy.app/> | **WebAudio**（技术栈含 WebAudio；仓库含 `static/assets/audio/reverb4.wav`、`reverb5.wav` 卷积混响 IR + `MetronomeSFX/`）。**注意：`static/assets/audio/` 下只有混响 IR 与节拍器，我未在该目录中找到乐器采样文件**；乐器采样是否随包分发、从何处来 —— **未验证**，不要臆断 | **AGPL-3.0**（代码） | 仓库 <https://github.com/Specy/genshin-music> ；`static/assets/audio` 目录 API 实抓 <https://api.github.com/repos/Specy/genshin-music/contents/static/assets/audio> |
| 4 | **`TKanX/lyre-together`**（LyreTogether，多人合奏） | README 自述为模拟器；**Acknowledgments 明确写着参考了 `WindsongLyre-Sim`**，故音色方案高度可能相同（沿用 mp3 采样）；我**未逐个核对其 `public/` 内容** | **MIT**（已归档 2025-06-20） | <https://github.com/TKanX/lyre-together> |
| 5 | **`sabihoshi/GenshinLyreMidiPlayer`** | 面向**真机自动演奏**（MIDI → 按键）的桌面工具，**不是发声模拟器**，不含音色 | 未验证 | <https://github.com/sabihoshi/GenshinLyreMidiPlayer> |
| 6 | **`luern0313/WindSong-Lyre-Genshin-Impact`** | 曲谱（`.mid`）资源库，**非播放器** | 未验证 | 见本项目 `README.md`「曲谱来源」表 |

**规律：** 所有"能发声"的网页模拟器，路线几乎只有两种 ——
**（A）直接打包游戏提取的 mp3 采样**（1、2、4，均无许可或弱许可）；
**（B）纯 WebAudio 程序合成**（3 的节拍器/混响部分确定是 WebAudio；乐器部分未验证）。
**没有任何一个是"合法分发的 soundfont"路线。**

### 3.1 附：曲谱解析类（非发声方案，供参考）

- `TibixDev/GenshinLyreParser` —— 从视频里解析琴键（提到于 <https://www.libhunt.com/compare-genshin-audio-exporter-vs-GenshinLyreParser>）
- 相关讨论帖：<https://www.reddit.com/r/Genshin_Impact/comments/vc8j6w/i_made_a_website_that_parses_notes_from_genshin/>

---

## 4. 合规判断：该不该把游戏提取音频打包进交付物？

### 4.1 结论：**不该。**

技术可行 ≠ 可以分发。理由：

1. **版权归属**：原神的音频资源版权属于 miHoYo / HoYoverse，**不在任何开源许可之下**。
2. **没有任何一个社区采样仓库给出再分发许可**（§2.1、§2.2 均为"无 LICENSE 文件"）。
   即便某个仓库标注了 MIT/AGPL，那也只是**代码**许可，**不覆盖其打包的游戏音频**。
3. **实际风险路径**：
   - 仓库被 DMCA / 下架（同类仓库已有归档前例：WindsongLyre-Sim、lyre-together 均已归档只读）；
   - 交付物若含提取音频，等于**把风险焊死在我们的包里**，且用户在 `file://` 下双击即分发完成，无法撤回。
4. **API 敏感性**：本项目是"给曲库加播放器"的本地工具，**没有理由**为了一点音色便利承担版权风险。

### 4.2 推荐路径（三档，按合规性从高到低）

| 档 | 做法 | 合规性 | 用户体验 | 是否采用 |
|---|---|---|---|---|
| **A（推荐，默认）** | **只内置程序合成音色**（`windsong` / `piano` / `musicbox` / `harp`），**零音频资源**，双击即响 | ✅ 完全干净 | 立即能听，音色是"近似"不是"原版" | **✅ 采用，作为默认** |
| **B（推荐，可选）** | 提供 `loadSampleFiles(files)`：用户用 `<input type=file>` 选**自己**从自己游戏/自己录音得到的采样，走 `FileReader`/`arrayBuffer()` → `decodeAudioData`。**播放器不打包、不上传、不缓存到仓库** | ✅（用户自担，权责清晰） | 能拿到"原版音色"，但需要用户自己准备 21 个文件 | **✅ 采用** |
| **C（不采用）** | 播放器仓库内直接放提取好的 mp3/`.sf2` | ❌ 侵权风险 | 最佳 | **❌ 不采用** |

### 4.3 为什么不能靠 `fetch` / CDN 绕开

`file://` 协议下 `fetch` 会被 CORS 拦（跨源请求被拒），所以 **B 档只能走 `File` 对象 → `FileReader`/`arrayBuffer()` → `decodeAudioData`**，不能靠 URL 加载。
→ 这直接决定了 `audio-engine.js` 的接口形态：**加载入口必须接收 `File` 对象数组**，而不是 URL 列表。

### 4.4 给用户的诚实说明（必须写进交付/UI 文案）

- 内置 `windsong` 是**程序合成的近似音色**，不是游戏原声；
- 想要原声，需要自己从**自己的游戏安装**提取（§1 工具链），或用 `WindsongLyre-Sim` 这类文件**但请自行确认其版权状态**；
- 我们**不提供、不托管、不分发**任何游戏音频。

---

## 5. 许可友好的近似替代音色（免费 harp / plucked-string / pizzicato）

想比"纯合成"更进一步、又要许可干净时，可用下列库**自己**导出/转换采样，或由用户自备：

| 库 | 内容 | 许可 | 下载 / 仓库 |
|---|---|---|---|
| **FreePats Concert Harp** ⭐ 最贴合 | 竖琴 sound bank，2 力度层，SF2 / SFZ(FLAC/WAV)，另有 small 版 4.9 MiB | **CC0 1.0（公有领域奉献）** | 页面 <https://freepats.zenvoid.org/OrchestralStrings/harp.html> ；SF2 <https://freepats.zenvoid.org/OrchestralStrings/ConcertHarp/ConcertHarp-SF2-20200702.tar.xz> |
| **VSCO 2 Community Edition** | 开源管弦采样库（含 harp），SFZ / soundfonts / GM | **CC0**（页面原文 "Licensed under CC0 … you can do whatever you want with these samples"） | <https://versilian-studios.com/vsco-community/> ；仓库 <https://github.com/sgossner/VSCO-2-CE> ；原采样库 VCSL <https://github.com/sgossner/VCSL> |
| **Sonatina Symphonic Orchestra (SSO)** | 免费管弦采样库（含 harp），Mattias Westlund | **CC Sampling Plus 1.0** | <https://github.com/peastman/sso> ；索引 <https://sfzinstruments.github.io/orchestra/sso/> ；<https://musical-artifacts.com/artifacts/81> |
| **FluidR3_GM** | Frank Wen 的 GM/GS soundfont，含 Harp(46) / Pizzicato Strings(45) | **MIT** | 说明与下载 <https://musical-artifacts.com/artifacts/1229>（原文 "Distributed under the MIT license"）；镜像仓库 <https://github.com/pianobooster/fluid-soundfont>（148 MB，超 GitHub 单文件限制，用 Release） |
| **MuseScore_General.sf2 / FluidR3Mono** | MuseScore 自带声库，源自 FluidR3 | **MIT** | 许可文件 <https://github.com/musescore/MuseScore/blob/main/share/sound/FluidR3Mono_License.md> ；拆分版 <https://github.com/jiyimeta/musescore-general-sf2-split> ；Debian 包 <https://packages.debian.org/sid/fluidr3mono-gm-soundfont> |
| **GeneralUser GS** | 另一套流行的 GM soundfont（S. Christian Collins） | 下载包内附许可；**具体条款本报告未逐字核验** | <https://www.schristiancollins.com/generaluser> ；仓库 <https://github.com/mrbumpy409/GeneralUser-GS> |
| **Salamander Grand Piano** | Yamaha C5 大钢琴采样（做 `piano` 音色参考） | **CC BY 3.0** | <https://github.com/sfzinstruments/SalamanderGrandPiano> ；<https://sfzinstruments.github.io/pianos/salamander/> |
| Polyphone "Harp Strings" / "Celtic Harp" / "Ancient Instruments" | 单件竖琴类 soundfont | **许可未在列表页明示 —— 未验证，采用前必须逐个核对** | <https://www.polyphone.io/en/soundfonts/plucked-strings/438-harp-strings> ；<https://www.polyphone.io/en/soundfonts/plucked-strings/557-celtic-harp-haug-harp-soundfont> ；<https://www.polyphone.io/en/soundfonts/soundscapes/530-ancient-instruments-of-the-world> |

**采用建议：**
- 若要给用户一个"许可干净的更好听的选项"，**首选 FreePats Concert Harp（CC0）** —— 竖琴音色 + 公有领域，转换/再分发都无约束。
- **注意**：`.sf2` 是采样库容器，**浏览器 WebAudio 不能直接读 `.sf2`**（没有内置 soundfont 解析器）。要用就得先离线把需要的音转成 `.wav`/`.mp3`，或者干脆让用户自备 wav。
- **即使 CC0，也不要默认塞进仓库**：本项目是"双击 `file://` 就能用"的轻量工具，**默认零资源**是第一原则（用户痛点就是"费时费内存"）。CC0 素材适合作为**用户可选下载**，不适合作为默认负担。

---

## 6. 对本项目 `player/js/audio-engine.js` 的直接约束（调研→实现）

由以上调研，实现被约束为：

1. **默认必须零音频资源。** 默认音色 = 程序合成的 `windsong`，双击 `file://` 立刻能听。→ 不依赖任何 mp3/sf2/CDN。
2. **加载入口只收 `File` 对象**（`loadSampleFiles(files)`），走 `FileReader`/`arrayBuffer()` → `decodeAudioData`；**绝不 `fetch`**。
3. **文件名 → 音高自动映射**要同时兼容多种社区命名，因为社区命名极不统一（§2.1 用 `1`–`7` + `+`/`-`，其它场景用科学音高记号 / MIDI 号 / 键字母）：
   - 科学音高记号 `C3.mp3`、`A4.wav`、`C#3`、`Db3`
   - BetterGI 键字母 `Z.wav` … `U.wav`（21 键 = C 大调白键 C3–B5 = MIDI 48–83）
   - MIDI 号 `48.wav`
   - 简谱 `do.wav`（+ `1`–`7` 与 `+`/`-` 升降号，覆盖 §2.1 的命名法）
4. **缺音用邻近采样 `playbackRate` 变调兜底** —— 因为用户手上的采集几乎不可能刚好 21 个音齐全；不兜底就会出现"21 键只响几个"。
5. **合规文案**：播放器/README 必须写明"内置音色为程序合成近似，非游戏原声；原声采样需用户自备"。

---

## 7. 明确「未找到公开来源」的条目（供 lead 决策，不要当成已解决）

| 想找的东西 | 结论 |
|---|---|
| 风物之诗琴的 Wwise Event ID / Media ID / SoundBank 名清单 | **未找到公开来源**（需自建 `wwiser` 流程现场比对，§1.2） |
| 风物之诗琴 21 音的 `.sf2` / `.sfz` soundfont | **未找到公开来源**（只有裸 mp3，§2.3） |
| 带**明确再分发许可**的原神乐器采样集 | **未找到公开来源**（所有命中的仓库均无 LICENSE，§2.1/§2.2） |
| `Specy/genshin-music` 乐器采样的实际来源与分发方式 | **未验证**（`static/assets/audio/` 只有混响 IR 与节拍器；AGPL-3.0 仅覆盖代码） |
| `Escartem/AnimeWwise`、`vgmstream`、`Vextil/Wwise-Unpacker`、`TKanX/lyre-together` 的 `public/` 内容、Polyphone 各 soundfont 的确切许可 | **未验证**（仓库/页面存在，但本轮未逐个抓取许可原文） |

---

## 8. 证据索引（全部为本次调研实抓或检索命中）

**提取工具**
- <https://github.com/dvingerh/genshin-audio-exporter>
- <https://github.com/Escartem/AnimeWwise>
- <https://github.com/Vextil/Wwise-Unpacker>
- <https://github.com/vgmstream/vgmstream>
- <https://www.foobar2000.org/components/view/foo_input_vgmstream>
- <https://github.com/bnnm/wwiser> ；<https://github.com/bnnm/wwiser/blob/master/doc/WWISER.md>
- <https://www.audiokinetic.com/community/wwisetour/jvp397t6iqg>

**社区采样 / 网页模拟器**
- <https://github.com/haveyouwantto/WindsongLyre-Sim>
- <https://api.github.com/repos/haveyouwantto/WindsongLyre-Sim/contents/instruments/windsong_lyre/audio>
- <https://haveyouwantto.github.io/WindsongLyre-Sim/>
- <https://github.com/System233/system233.github.io> ；<https://system233.github.io/windsong> ；<https://system233.github.io/pck-reader>
- <https://github.com/Specy/genshin-music> ；<https://genshin-music.specy.app/> ；<https://api.github.com/repos/Specy/genshin-music/contents/static/assets/audio>
- <https://github.com/TKanX/lyre-together>
- <https://github.com/sabihoshi/GenshinLyreMidiPlayer>
- <https://github.com/topics/lyre>

**乐器条目**
- <https://genshin-impact.fandom.com/wiki/Windsong_Lyre>
- <https://game8.co/games/Genshin-Impact/archives/322600>

**许可友好替代音色**
- <https://freepats.zenvoid.org/OrchestralStrings/harp.html>
- <https://versilian-studios.com/vsco-community/> ；<https://github.com/sgossner/VSCO-2-CE> ；<https://github.com/sgossner/VCSL>
- <https://github.com/peastman/sso> ；<https://sfzinstruments.github.io/orchestra/sso/>
- <https://musical-artifacts.com/artifacts/1229> ；<https://github.com/pianobooster/fluid-soundfont>
- <https://github.com/musescore/MuseScore/blob/main/share/sound/FluidR3Mono_License.md> ；<https://github.com/jiyimeta/musescore-general-sf2-split>
- <https://www.schristiancollins.com/generaluser> ；<https://github.com/mrbumpy409/GeneralUser-GS>
- <https://github.com/sfzinstruments/SalamanderGrandPiano> ；<https://sfzinstruments.github.io/pianos/salamander/>
- <https://www.polyphone.io/en/soundfonts/plucked-strings/438-harp-strings>
