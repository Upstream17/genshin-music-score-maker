# docs/ — 规格与调研

这些文档是项目推进过程中形成的**事实记录与规格**，不是营销材料。三份内容：

| 文件 | 内容 |
|---|---|
| `bettergi-spec.md` | BetterGI 曲谱格式与演奏语义的**源码级规格**（三种 `type` 的词法、`ApplyRepeatedKeyGap`、`Normalize`、21 键映射与折叠规则），每条结论附上游 raw 源码 URL |
| `audio-sources.md` | 游戏乐器音源的合规调研：能否从安装包提取、社区有无可用采样、许可状态、推荐路径 |
| `local-inventory.md` | 本地 307 首曲库的**全量实测盘点**：`type` 分布、异常文件、各 `type` 的词法实测 |
| `verification.md` | 见仓库根的 `app/VERIFICATION.md`（独立红队复核） |

## ⚠️ 路径说明

**这些文档写于仓库重构之前**，正文里的目录名是当时的名字。对应关系：

| 文档里写的 | 现在叫 |
|---|---|
| `完整曲库/` | `library-private/` |
| `player/` | `app/` |
| `scores/` | `publicsource/sources/` |
| `试验_Sky/` | `publicsource/sky/` |
| `_archive/` | `archive/` |
| `research/` | `docs/` |

**刻意没有批量替换**：这些报告里的数字（如「307 首」「321,330 音符」）都附带当时的路径上下文，
改路径而不改上下文会让记录变得不可信。读的时候按上表换算即可。
