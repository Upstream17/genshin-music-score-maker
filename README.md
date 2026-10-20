# 原神琴谱制谱器 · Genshin Lyre Score Maker

把 **MIDI / 光遇 Sky 谱 / 键谱** 转成 **BetterGI 能自动演奏的 21 键曲谱**，
并提供一个**双击就能用的网页演奏台**：试听、编辑、导出，不用开游戏。

> 非官方个人工具，与 miHoYo / HoYoverse、与 BetterGI 开发者均无隶属关系。
> 代码以 **GPL-3.0** 发布；**不含游戏音频**；部分曲谱的版权状态见 [NOTICE.md](NOTICE.md)。

---

## 它解决什么问题

原神的风物之诗琴只有 21 个键（纯 C 大调、C3–B5、无半音键）。现成的 MIDI 和曲谱
几乎都超出这个范围——带升号的音会被**静默丢弃**，音域超界会被折叠，结果就是
「导入了一片空白」或「听着跑调」。

本项目的工具链把这条路走通：

1. **判调性** → 整首移到白键调（移调保音程；「降半个八度」这种操作会毁掉音名，不做）
2. **选主旋律** → 多轨 MIDI 里认轨、补互补段落、剔除延迟回声轨
3. **缩编** → 控制密度与最大同按，让它真的**弹得动**
4. **强校验** → 复刻 BetterGI 的解析器重放，逐键比对按下区间，偏差 ≤2 ms

然后由 `app/` 提供本地试听与编辑，省掉「改一版就开一次游戏」的循环。

---

## 三分钟上手

### A. 只想听/改谱 → 打开演奏台

```
双击 app/index.html
```

把 `library/`（或你自己的 `library-private/`）拖进页面即可。支持：

- **21 键实时高亮**、音符合成卷帘、点击跳转
- **变速 0.5×–2×（不变调）**、循环、**歌单连播**
- **键盘弹奏**：`QWERTYU` / `ASDFGHJ` / `ZXCVBNM` 直接弹
- **音符编辑**：点选、增删、改音高/时值、撤销、**导出 BetterGI JSON**
- 8 种真实乐器音色（需先跑一次 `tools/fetch_samples.py`，见下）

### B. 有一首 MIDI 想转成谱子

```bash
python tools/add_songs.py "路径/歌.mid" --name "曲名"
# → library-private/05_我的新增/曲名.json
```

### C. 拉第三方源 / 启用真实音色（都可选）

```bash
bash tools/download_sources.sh      # 各开源曲库 → publicsource/（不进 git）
python tools/fetch_samples.py       # 游戏音频采样 → app/js/samples*.js（不进 git）
```

---

## 目录结构

```
.
├── app/                  ★ 演奏台（双击 index.html；零依赖、无构建、零网络请求）
│   ├── index.html        （CSS 已内联；只剩 4 个 JS 请求）
│   ├── js/               解析器 / 音频引擎 / 界面 / 采样（采样不进 git）
│   └── tests/            5 套测试 + 截图工具 + 采样生成器
├── tools/                转换与维护脚本（8 个）
├── skill/                给 AI agent 用的 skill（完整踩坑手册）
├── library/              ★ 可公开的曲谱（converted/ 共 47 首）
├── docs/                 BetterGI 源码级规格 / 音源调研 / 曲库盘点 / 验证报告
├── LICENSE               GPL-3.0
├── NOTICE.md             ★ 来源与版权声明，开源前必读
│
└── （以下全部 gitignore，只在你本地）
    ├── publicsource/     第三方原始下载（sky/ + sources/）
    ├── library-private/  含版权作品改编的曲库（BetterGI 挂这个目录）
    ├── archive/  reports/  dist/
    └── app/js/samples*.js
```

> `library-private/` 的内部子目录（`01_`/`02_`/`04_`/`05_`）与文件名**刻意保持不变**：
> BetterGI 的逐曲设置按 `RelativePath`（相对挂载根）存，内部结构不动就不会丢设置，
> 只需在 BetterGI 里把曲谱目录重新指一次。

---

## 工具一览

| 脚本 | 作用 |
|---|---|
| `midi_to_midijson.py` | **核心转换器**：`.mid` → `type:"midi"` JSON（自带 SMF 解析、折叠/吸附、强校验） |
| `add_songs.py` | **单曲入库**：任意源 → 转换 → 校验 → 写进曲库 |
| `transpose_midijson.py` | **整体移调**（换八度 / 换调），每首过三道校验才写盘 |
| `merge_library.py` | 合并各来源 → 正式曲库，统一命名、补原作者 |
| `convert_dedupe.py` | 键谱 `.txt` → JSON；跨来源去重 |
| `sky_batch_migrate.py` | 光遇 Sky 谱整库批量迁移 + 自动分档 |
| `render_preview.py` | 合成为 mp3（AB 试听用；不是游戏音色） |
| `download_sources.sh` | 拉各开源曲库到 `publicsource/` |
| `fetch_samples.py` | 下载游戏乐器采样 → 生成 `app/js/samples*.js`（本机自用） |

---

## 测试

```bash
node app/tests/integration.test.js       # 契约 + 全库不变量
node app/tests/parse.test.js             # 解析器全库（307 首 / 321,330 音符）
node app/tests/audio.test.js             # 音频引擎 / 文件名→音高映射
node app/tests/realtime.test.js          # 真实时间端到端（Chrome + CDP）
node app/tests/ui.test.js                # 音色 / 键盘弹奏 / 编辑 / 连播
```

当前状态：`integration 62` · `parse 307 首 0 失败` · `audio 165` · `realtime 32` · `ui 29`，全部 0 失败。

---

## 关于版权（请认真读）

- **代码** GPL-3.0。解析器语义来自 GPL-3.0 的 BetterGI，所以这里也用 GPL-3.0。
- **音频不随仓库分发**：游戏乐器采样版权归 miHoYo，由 `fetch_samples.py` 在你本机生成。
- **`library/converted/` 里的曲子**：由第三方 MIDI/Sky 谱转换而来，**词曲著作权归原作者**，
  我们不对其主张任何权利。转换不产生授权——把别人的 MIDI 换成 JSON 并不会让作品变成可自由分发。
  如权利人有异议，开 Issue，我们会直接删除。
- 想零风险：只用代码与工具，曲库在你本机自行生成。

详见 [NOTICE.md](NOTICE.md)。

---

## 相关

- [BetterGI](https://github.com/babalae/better-genshin-impact) — 曲谱格式与演奏语义的事实标准
- [bettergi-scripts-list](https://github.com/babalae/bettergi-scripts-list) — 官方曲库
- [WindsongLyre-Simulator](https://github.com/JularDepick/WindsongLyre-Simulator.fork) — 乐器采样来源
