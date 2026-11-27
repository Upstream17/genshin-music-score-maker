# NOTICE — 来源、许可与版权声明

本文件说明本仓库中**哪些属于本项目原创或衍生代码，哪些属于第三方资源与上游规范**。

## 1. 与游戏/上游的关系

本项目是**非官方**的个人工具，与 miHoYo / HoYoverse、与 [BetterGI](https://github.com/babalae/better-genshin-impact)
的开发者、与下列任何第三方项目**均无隶属或背书关系**。
「原神 / Genshin Impact / 风物之诗琴 / 老旧的诗琴 / 镜花之琴 / 谐律键琴 / 跃律琴 / 悠可琴 / 余音 / 晚风圆号」等游戏与乐器名称归其权利人所有，此处仅作**说明性使用**。

## 2. 代码许可：GPL-3.0

本仓库的**代码与文档**以 [GNU GPL v3](LICENSE) 发布。

> **为什么是 GPL-3.0 而不是 MIT**：本项目的曲谱解析器
> （`app/js/bettergi-parse.js`）按 [BetterGI](https://github.com/babalae/better-genshin-impact)
> 的解析语义复刻（三种 `type` 的词法、`ApplyRepeatedKeyGap`、`Normalize`、
> 21 键映射与折叠规则）。BetterGI 以 GPL-3.0 发布，为与上游许可兼容，本项目同样采用 GPL-3.0。

## 3. 音频：**不随仓库分发**

`app/js/samples*.js` 里的本地可选乐器采样来自第三方开源项目
[WindsongLyre-Simulator](https://github.com/JularDepick/WindsongLyre-Simulator.fork) 与
[genshin-music](https://github.com/Specy/genshin-music)（晚风圆号），
其**原始音频是游戏资源，版权归 miHoYo 所有**。

因此：

- 这些文件**已被 `.gitignore` 排除**，不会出现在公开仓库或在线部署站中；
- 如需在本机离线启用这些采样，可自行运行 `python app/scripts/fetch_samples.py` 在本机生成；
- **不要**将提取或转换的游戏音频采样提交到公开仓库或对外分发。

没有采样文件时，播放器会以内置 WebAudio 合成音色（竖琴 / 钢琴 / 音乐盒）开箱可用，并支持用户自行加载本地自定义采样文件夹。

## 4. 示范曲谱：`library/`

`library/` 里的 28 首 21 键示范曲谱是**从公开 MIDI 等来源转换并人工筛选**的展示曲目。
**转换不等于授权**：这些曲目本身的词曲著作权仍归原作者/权利方所有，我们
**不对其中的音乐作品主张任何权利**，也不提供任何商业性授权。

放置这些文件的意图仅限于演示工具链的输出形态、便于同好学习交流。
如果你认为某个文件侵犯了你的权益，请开 Issue 说明，我们会**直接删除**。

## 5. 主要上游参考

| 来源 | 用途 | 许可状态 |
|---|---|---|
| [BetterGI](https://github.com/babalae/better-genshin-impact) | 曲谱格式与演奏语义标准；解析器按其语义复刻 | GPL-3.0 |
| [WindsongLyre-Simulator](https://github.com/JularDepick/WindsongLyre-Simulator.fork) | 本地可选采样下载源（**不 vendor**，由 `fetch_samples.py` 按需下载到本地） | 未提供 LICENSE 文件；音频版权归 miHoYo |
| [Specy/genshin-music](https://github.com/Specy/genshin-music) | 晚风圆号（NightwindHorn）本地可选采样下载源（**不 vendor**，由 `fetch_samples.py` 按需下载到本地） | 仓库代码 AGPL-3.0；音频版权归 miHoYo |

## 6. 免责

本项目按「现状」提供，不附带任何担保。使用本工具造成的任何后果（包括但不限于游戏账号风险、版权纠纷）由使用者自行承担。
