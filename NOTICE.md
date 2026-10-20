# NOTICE — 来源、许可与版权声明

本文件说明本仓库里**哪些是我们的、哪些是别人的**。开源前请务必读一遍。

## 1. 与游戏/上游的关系

本项目是**非官方**的个人工具，与 miHoYo / HoYoverse、与 [BetterGI](https://github.com/babalae/better-genshin-impact)
的开发者、与下列任何第三方项目**均无隶属或背书关系**。
「原神 / Genshin Impact / 风物之诗琴 / 琴」等名称归其权利人所有，此处仅作**说明性使用**。

## 2. 代码许可：GPL-3.0

本仓库的**代码与文档**以 [GNU GPL v3](LICENSE) 发布。

> **为什么是 GPL-3.0 而不是 MIT**：本项目的曲谱解析器
> （`app/js/bettergi-parse.js`）是**照 [BetterGI](https://github.com/babalae/better-genshin-impact)
> 的解析语义复刻**的（三种 `type` 的词法、`ApplyRepeatedKeyGap`、`Normalize`、
> 21 键映射与折叠规则）。BetterGI 以 GPL-3.0 发布，为了让整个项目与上游许可兼容、
> 也为了不绕开别人的劳动成果，这里选择同样的 GPL-3.0。

如果你只想用其中一部分，请注意 GPL-3.0 的传染性。

## 3. 音频：**不随仓库分发**

`app/js/samples*.js` 里的乐器采样来自第三方项目
[WindsongLyre-Simulator](https://github.com/JularDepick/WindsongLyre-Simulator.fork)，
其**原始音频是游戏资源，版权归 miHoYo 所有**。

因此：

- 这些文件**已被 `.gitignore` 排除**，不在本仓库中；
- 想在本机启用真实音色，请自己运行 `python tools/fetch_samples.py`
  （脚本会下载并转码，产物只落在你本地）；
- **不要**把它们提交到任何公开仓库，也不要分发。

没有采样时，播放器会自动回退到内置合成音色，其余功能不受影响。

## 4. 曲谱：`library/converted/`

`library/converted/` 里的 21 键曲谱是**我们从第三方 MIDI / 光遇 Sky 谱等来源转换**得到的。
**转换不等于授权**：这些曲目本身的词曲著作权仍归原作者/权利方所有，我们
**不对其中的音乐作品主张任何权利**，也不提供任何商业性授权。

放置这些文件的意图仅限于：演示工具链的输出形态、便于同好学习交流。
如果你认为某个文件侵犯了你的权益，请开 Issue 说明，我们会**直接删除**，不做争辩。

若你不想承担任何风险，可以只用代码与工具，曲库在你本机自行生成。

## 5. 主要上游来源

| 来源 | 用途 | 许可状态 |
|---|---|---|
| [BetterGI](https://github.com/babalae/better-genshin-impact) | 曲谱格式与演奏语义的事实标准；解析器按其语义复刻 | GPL-3.0 |
| [bettergi-scripts-list](https://github.com/babalae/bettergi-scripts-list) | 官方曲库（**不 vendor**，脚本拉取） | 未提供 LICENSE 文件 |
| [WindsongLyre-Simulator](https://github.com/JularDepick/WindsongLyre-Simulator.fork) | 8 种乐器的 21 音采样（**不 vendor**） | 未提供 LICENSE 文件；音频版权 miHoYo |
| [Ai-Vonie/Sky1984-Sheets-Collection](https://github.com/Ai-Vonie/Sky1984-Sheets-Collection) | 光遇 Sky 谱（**不 vendor**） | 站点声明数据部分公有领域 |
| [luern0313/WindSong-Lyre-Genshin-Impact](https://github.com/luern0313/WindSong-Lyre-Genshin-Impact) | MIDI 源（**不 vendor**） | 未提供 LICENSE 文件 |
| [MRevenger/GenshinAutoPlayLyre](https://github.com/MRevenger/GenshinAutoPlayLyre) | `.txt` 键谱（**不 vendor**） | 未提供 LICENSE 文件 |

「不 vendor」= 仓库里没有这些文件，`tools/download_sources.sh` 会把它们下载到你本地的
`publicsource/`（已被 gitignore）。

## 6. 免责

本项目按「现状」提供，不附带任何担保。使用本工具造成的任何后果（包括但不限于
游戏账号风险、版权纠纷）由使用者自行承担。
