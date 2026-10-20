# `player/` 独立验证报告（红队 / 对抗性复核）

> ⚠️ **2026-10-20 更新（重要）**
> index.html / css/style.css / js/app.js 已**整体重做**：全新扁平化界面（纸白 / 墨字 / 青瓷绿），
> 并新增「键盘弹奏」「音符编辑」「歌单连播」与内联真实音源 js/samples.js。
> 因此本报告 §0 冻结的**这三个文件的哈希已失效**，针对它们的界面层结论不再适用。
> **bettergi-parse.js 与 audio-engine.js 未改动** —— 关于解析保真度（§5）与音频引擎的结论仍然成立。
> 新版界面与功能的验证见 player/README.md §6.2 与 player/tests/ui.test.js（24 PASS / 0 FAIL）。


**v2 — 第二轮复核**：第一轮的 🟡1/🟡2 已被修复，本文件已按新版本重新冻结结论并更新。
第一轮的全部原始结论与「我作废的自己的结论」保留在 §8，不删改。

- 验证者：teammate `verify`（独立于 Lead 与各实现者）
- 第一轮：2026-10-18 22:25 – 22:43 (+08:00) · 第二轮：2026-10-18 22:59 – 23:15 (+08:00)
- 环境：Windows · PowerShell 5.1.26100.9444 · Node v24.15.0 · Chrome 155.0.8059.80 · .NET runtime **8.0.31**（已装，无 SDK）
- 被验证文件：`player/**`（只读）。**本报告是本次验证唯一写入的文件。**

> **重要：验证期间被验证文件一直在改。**
> `bettergi-parse.js` 改 2 次、`app.js` 改 3 次、`headless.html` 改 2 次、`realtime.test.js` 改 1 次。
> 每一轮的结论都**只对该轮冻结的哈希**负责（§0）。凡被后续版本推翻的结论，都在 §8 明确作废。

## 0. 冻结版本

### R2（本轮，结论以此为准）

| 文件 | SHA-256（前 16） |
|---|---|
| `player/index.html` | `87DDBC4101148479` |
| `player/css/style.css` | `166FFC7BCB566C43` |
| `player/js/app.js` | `B0A2FAACFC0CC289` |
| `player/js/audio-engine.js` | `312A783EDA0942D8` |
| `player/js/bettergi-parse.js` | `BE89302C7752A590` |
| `player/tests/integration.test.js` | `678E702C3F5235CD` |
| `player/tests/parse.test.js` | `D1DA4DA425F2E3FA` |
| `player/tests/audio.test.js` | `A3EC3413716EBF07` |
| `player/tests/realtime.test.js` | `F03808F1DA70D2A5` |
| `player/tests/headless.html` | `D50D594E10D57868` |

与 Lead 给出的冻结表**逐条一致**（我独立算的 SHA-256）。`player/README.md` 也变了（`E499CC99BF116509`），不在验证范围内，只在 §7-🟢14 记一句。

### R1（第一轮，已被 R2 取代）

`app.js F849A53B682D3359` · `bettergi-parse.js 3F53341137EEACF1` · `realtime.test.js 5E77418A631CD2F1` · 其余同 R2。

---

## 1. 结论：**可以交付**（唯一遗留是 🟢 级、可忽略的 tick 取整口径差异）

**🔴 0 条 · 🟡 0 条 · 🟢 若干。** 第一轮的两条 🟡 经我独立复测**确认已闭环**（§5、§7）。

核心承诺「双击 `player/index.html` 就能用」我用**运行时证据**确认（不是读 README、不是读测试）：

- 真实 Chrome 载入 `file://…/player/index.html`，走完「导入 → 播放 → 变速 → 跳转 → 停止 → 循环」，全程只发 **6 个 `file://` 请求，`http(s)` 0 个**，无加载失败、无页面异常；
- AudioContext 时钟真实推进，**1.0× / 2.0×** 速率实测 `1.13× / 2.00×`，跳转/停止/循环绕回全部正确；
- 4 种合成音色都出声且基频误差 0.05%–0.78%；
- 全库 **307/307** 首 JSON 解析成功，**321,330** 个音符，0 越界 / 0 非法键 / 0 非正时长 / 0 个 `start < end` 违反；
- 三个 js 都是 classic script，`index.html` 无任何外部依赖。

**为什么从「有条件交付」升为「可以交付」**：第一轮的 🟡1（缺 `Normalize()`）已补齐，我用**独立参照实现**复测：结构性差异（音符条数）从 **4 首 → 0 首**，偏差音符从 **389 → 53**（>0.6ms）、**302 → 11**（>30ms），原最小复现已**逐音完全一致**。剩下的 53 个音（占 321,330 的 **0.016%**）只差**时值**、不差音高与起音，根因是 1 tick（0.0001ms）的取整口径（见 §5.5）——对拨弦音色不可闻，故不再构成交付条件。

**若要与 BetterGI 做到逐 tick 一致**，只需把 `quantizeTicks` 的 `Math.round` 换成 `Math.trunc`（§5.5 给了完整证据与代价），但这会同时改掉作者自己那条回归护栏的期望值；我认为**不值得改**。

---

## 2. 复跑全部已有测试（R2）

### 2.1 `node player/tests/integration.test.js`
```
============================================================
PASS 62   FAIL 0   SKIP 0
============================================================
```
**判定：✅ 通过。** 注意 `✓ index.html 没有外部 http(s) 资源引用` 是**源码正则**；运行时证据见 §2.4 与我自己的 §4.4。

### 2.2 `node player/tests/parse.test.js "完整曲库"`
```
  扫描 JSON 文件      : 307
  解析成功 (ok:true)  : 307
  不变量失败          : 0
  总音符数            : 321330          ← R1 为 321246（+84，Normalize 补齐后的真实值）
  总事件数(down+up)   : 642766
  warnings 总条数     : 26              ← R1 为 29
  全库用到的键        : 21/21
  最大同刻键数        : 20  (【原神演奏】Lemon 欢快的版本.json)   ← R1 为 63（记录口径）
  零/负时长音符       : 0
  超出 48..83 的音符  : 0
  [7] BGIParse.selfTest()  passed: 53   failed: 0     ← R1 为 50/0
 结论：PASS   解析失败 0 / 不变量失败 0 / selfTest 失败 0
```
**判定：✅ 通过。** 「最大同刻键数 63 → 20」正是 🟢8 被采纳的效果（口径从「音符记录数」改为「同时按下的不同键数」，我独立复算确认，见 §7-🟢8）。
`warnings` 里**新出现 1 条**退化音符告警，见 §7-🟢12。

### 2.3 `node player/tests/audio.test.js`
```
TOTAL: passed=165 failed=0 skipped=3
RESULT: PASS
```
**判定：✅ 通过**，与 R1 一致。3 个 skip 是 Node 无 AudioContext 的诚实跳过，浏览器里由 `headless.html` 真解码覆盖（`passed=41 failed=0 skipped=1`）。**不是假通过。**

### 2.4 `node player/tests/realtime.test.js`（真实时间，Chrome + CDP）
```
PASS 27 → 32   （FAIL 0）
PASS  播放后时间轴前进：0.5 -> 2.2 -> 3.9
PASS  1.0× 速度下推进速率 ≈1（实测 1.13×）  -> 1.133
PASS  播放中有琴键高亮：39/40 次采样有高亮，最多同时 1 个  -> litSamples=39 maxLit=1
PASS  播放中显示过音名（A3）
PASS  2.0× 速度下推进速率 ≈2（实测 2.00×）  -> 2.000
PASS  拖到 60% 后时间 ≈ 21.6s（实测 22.2s）  -> 22.2
PASS  停止后时间归零 / 停止后无残留高亮
PASS  循环勾选状态已生效（checkbox = true）
PASS  已跳到接近曲尾（35.8s / 36s）  -> 35.8
PASS  循环开启时播到曲尾会绕回开头（35.8s 之后最低回退到 0.2s）
PASS  windsong 出声 A4/C4/C3/B5：误差 0.12% / 0.34% / 0.78% / 0.05%
PASS  四种音色出声（RMS 0.0692–0.1111）
=== 运行时网络审计（CDP Network 域）===
  实际请求 6 个：file:// 6 · http(s) 0 · 其它 0
  ✓ 运行时零 http(s) 请求 / ✓ 运行时零非 file:// 请求
====================================================
PASS 32   FAIL 0
```
**判定：✅ 通过，且第一轮的 🟡2 已真正闭环**——我逐行核对了两条新断言（§7-🟡2 已解决）。

### 2.5 无头 DOM / E2E
```powershell
$txt = (& $chrome --headless --disable-gpu --no-sandbox `
  --virtual-time-budget=600000 --allow-file-access-from-files `
  --autoplay-policy=no-user-gesture-required `
  --dump-dom 'file:///E:/HuJingwen/%E5%8E%9F%E7%A5%9E%E6%9B%B2%E8%B0%B1_20260921/player/tests/headless.html' 2>$null | Out-String)
```
```
PASS 40   FAIL 0   SKIP 1
SKIP  播放后时间在走  (虚拟时间下 AudioContext 真实时钟不前进；已由 realtime.test.js 覆盖)
BGIParse.selfTest(): passed=53 failed=0
```
**判定：✅ 通过。** 该 SKIP 原因真实（`--virtual-time-budget` 快进虚拟时间、AudioContext 走真实时钟），且已由 §2.4 覆盖。
（「index.html 读取成功（5563 字节）」vs 文件 6519 字节 = UTF-16 字符数 vs UTF-8 字节数，**不是 bug**。）

---

## 3. 我自己写的新反例测试（12 组，全部在仓库外临时目录运行）

| 脚本 | 覆盖 | R1 结果 | R2 结果 |
|---|---|---|---|
| `falsify-parse.js` | 畸形输入 / 恶意对象 / pitchName / 三种 type / 超大输入 / JArray | PASS 212 FAIL 2 | **PASS 212 FAIL 2（同一批，无回归）** |
| `reattack-activeAt.js` | `activeAt` 全库真值比对 | 漏亮 0 | **漏亮 0** |
| `falsify-app.js` | 从 `app.js` 原文抽取函数做反例 | 见 §4.1 | 同代码，结论不变 |
| `reference-diff.js` | **独立参照实现**（逐行移植 BetterGI 源码） | 210/307 一致 | 见 §5 |
| `refined-diff.js` / `trunc-diff.js` | 差异分桶 + 取整模式敏感性 | — | 见 §5 |
| `rounding-sensitivity.js` | 取整模式（排除伪因） | — | 见 §5.4 |
| `minimal-repro.js` / `tick-debug.js` | 最小复现 + tick 级根因 | — | 见 §5.3、§5.5 |
| `round2-checks.js` | trunc 参照自校验 + `maxDistinctKeys` + 退化音符 | — | 见 §7 |
| `network-audit.js` | **运行时**零网络审计 | 6 file:// / 0 http | **6 file:// / 0 http** |
| `validate-and-sample.js` / `counts-check.js` / `edge2.js` / `final-scan.js` | 抽查、计数、边界、口径 | — | 见 §6、§7 |

### 3.1 关键反例：`parseScore` 健壮性（任务点名）

36 个畸形输入（`null`/`undefined`/`42`/字符串/数组/函数/`true`/`{notes:123|[]|{}|null|''|'   '|'|||'}`/`{type:'midi',notes:123}`/`{type:'guitar'}`/`{type:''}`/`bpm:0|-120|'abc'|Infinity|NaN`/`ticks:0|-5`/`time_signature:'0/0'`/`Object.create(null)`）→ **全部 `ok:false` 或合法结构，0 次抛异常**。

恶意/奇异对象全部不炸出去：`type` getter 抛异常（→`ok:false`）、`notes.toString()` 抛异常、`Proxy` 的 `get`/`has` 全抛、`opts` 为恶意 Proxy、循环引用。

超大输入：200k 事件 midi（1.6MB）→ 407ms、堆 195MB；300k token yuanqin → 900k 音符 / 1.6s；200 万字符单 token → 快速失败。keyboard 深嵌套 depth 60000 → 栈溢出被 `try/catch` 捕获返回 `ok:false`，**进程存活**。

**判定：`parseScore` 的「绝不抛异常」契约 ✅ 成立**（唯一例外 `pitchName(Symbol())`，且不可达，见 §7-🟢4）。R2 重跑结果与 R1 完全相同 ⇒ **`Normalize` 的加入没有引入任何健壮性回归。**

---

## 4. 对抗性读代码（逐条回答任务点名的问题）

### 4.1 调度器：漏播 / 重复播 / 变速漂移 / seek 后卡住
**重复播 = 无**（`state.cursor` 单调递增，`noteOn` 抛异常也照常前进）。
**seek 后卡住 = 无**（`seekTo` 播放中走 `startPlayback` 重设 base 时钟）。
**变速漂移 = 无**（`scoreMsAt`/`ctxTimeAt` 互逆，实测 1.13×/2.00×）。

**`lowerBoundEnd()` —— 我在 R1 已作废自己的「漏播」结论，结论不变。**
`notes` 按 `start` 排序却在 `end` 上做二分，谓词 `P(i)=end>t` 不单调，数学上无依据（实测 25,981/321,246 个探测点与线性扫描不一致）。但**可证且已实测**不会丢任何 `start ≥ t` 的音符：
```
随机谱面 3,003,000 trial：cursor 越过第一个未来音 = 0    被跳过的未来音符 = 0
真实曲库   321,246 探测点：cursor 越过第一个未来音 = 0    被跳过的未来音符 = 0
```
唯一后果：seek 落在长音中间时，`[want,r)` 内「从 t 之前响到现在」的音不重触发（124,077 次）。
**🟢 代码异味，无功能影响**（§7-🟢3 保留）。

### 4.2 曲尾 / 循环 / 变速 / seek 组合下 `state.cursor` 是否错位
- 曲尾：`nowScore >= duration()+900` → 循环则 `startPlayback(0)` 重建，否则 `stopPlayback()` 置 `cursor=0`。
- 变速：不改 cursor，靠 `scoreMsAt` 连续映射。
- seek：`cursor` 与 `baseCtxTime/baseScoreMs` 用同一个 `engNow()` 采样点，**无错位窗口**。
- R2 新增实测：循环绕回是**真实回退**（35.8s → 0.2s，`realtime.test.js` 断言 `cur < tNearEnd - 1`）。

**判定：✅ 未发现组合态错位。**

### 4.3 `activeAt()` 回溯上限
**R1 我抓到了旧版的悬崖**（硬编码 `idx-i<=260`）：aLIEz 39/266 个整秒采样点漏亮键 E，被漏音符距窗口起点 430 个音。

R2 版本（`state.maxNoteMs` 精确上界 + 3000 硬上限）**全量复攻击**：
```
全库最长单音时值            : 28336.4ms  [纳塔 Natlan - 8Hox91Rl.json]
单次 activeAt 最大向后扫描数 : 272  (代码硬上限 3000)
探测点总数（= 全库音符数）   : 321330
出现「应亮未亮」的探测点     : 0
漏亮键次数                  : 0
其中因 3000 扫描上限导致     : 0
```
**判定：✅ 修复正确且充分。** 证明：`maxNoteMs = max(end-start)`，若某音 `end > t` 则 `start > t - maxNoteMs`，故 break 条件永不先触发在还响着的音上；`i` 递减时 `start` 也递减，一旦某处 break，更早的音必然更早结束。最大扫描 272 步，离 3000 上限余量充足。
残余风险见 §7-🟢3。

### 4.4 `index.html` 是否真零网络（逐行 + 运行时）
**逐行**：全部资源引用只有 4 条，全为相对本地路径（`css/style.css` + 3 个 `js/*.js`）；`http://`/`https://`/`@import`/`url(`/`fetch(`/`XMLHttpRequest`/`WebSocket`/`sendBeacon` 在 `index.html` 与三个 js 中命中 **0** 次。

**运行时（我自己开的 CDP 审计，R2 版本）**：
```
页面内状态: {"keys":21,"title":"小星星","tTotal":"0:36.0","tNow":"0:00.0","items":1}
总请求数: 6     按 scheme: {"file":6}
loadingFailed:（无）      页面异常 / console error:（无）
>>> 非 file/data/blob 的网络请求数: 0  ⇒ 零网络请求成立
```
**判定：✅ 真正零网络。** 🟢10 已被采纳（仓库测试现在自己也有运行时网络断言，且与我的结论一致）。

### 4.5 三个 js 是否真是 classic script
`bettergi-parse.js` / `app.js` 对 `import/export/fetch/require/module/XMLHttpRequest/WebSocket/sendBeacon` **全 CLEAN**；`audio-engine.js` 唯一命中 `\bexport\s` 经人工核对是**注释**（`audio-engine.js:13`）。`index.html` 无 `type="module"`，脚本用 `window.BGIParse`/`window.BGIAudio` 全局挂载。
**判定：✅ 三个都是 classic script。**

---

## 5. 保真度：与 BetterGI 真实源码的独立比对（本轮最重要）

### 5.1 方法
不相信 `research/bettergi-spec.md`（队友写的）。直接拉上游源码：
[`MusicScoreParser.cs`](https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/MusicScoreParser.cs)、
[`MusicTimelineBuilder.cs`](https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/MusicTimelineBuilder.cs)，
逐行移植成独立参照实现（`TimeSpan` 用整数 tick = 1e-4ms 精确建模、稳定排序、`ApplyRepeatedKeyGap`、`Normalize`、三种 type 词法全照抄），对全库 307 首逐音比对。

### 5.2 参照实现的自校验（先证明尺子准）
```
Z[4]X[4] @bpm120（手算 Z:0→500 X:500→1000）   参照 = 交付物 ✅
midi DA0|UA480 @bpm60 ticks480（手算 A:0→1000）参照 = 交付物 ✅
midi 变速 DA0|UA480|*120|DB480|UB480          参照 = 交付物 = A 0→1000 | B 1500→2000 ✅
keyboard 最小复现 ZZZZZZ/ZZ[4] @bpm120         参照 = 交付物 ✅
yuanqin Z[4]Z[4] @bpm80（30ms 重触发）         参照 = 交付物 = Z 0→720 | Z 750→1500 ✅
```
另有 C# 复算确认「连续音的 KeyUp 与下一个 KeyDown 落在同一 tick」这一前提成立。

### 5.3 修复前后对比（同一把尺子、同一个分类器）

| 指标 | R1（旧 `bettergi-parse.js`） | R2（本轮） | 变化 |
|---|---|---|---|
| >0.6ms 差异音符 | 389 | **53** | ↓ 7.3× |
| >30ms 差异音符 | 302 | **11** | ↓ 27× |
| 受影响曲谱（>0.6ms / >30ms） | 20 / 20 | **4 / 2** | ↓ 5× |
| **音符条数不同的曲谱** | **4** | **0** | ✅ 归零 |
| 最小复现 `ZZZZZZ/ZZ[4]` 第 7 音 | 交付物 `3000.500→3500.500`（差 30ms） | **交付物 = 参照 = `3000.500→3470.000`** | ✅ 逐音一致 |

**Lead 声称的 4 首音符数，我独立实测确认全部吻合：**
```
   3893   aLIEz            （R1：参照 3893 / 交付物 3827，差 −66）
   1604   樱花树下的约定     （R1：1604 / 1595，差 −9）
   1508   纳塔 Natlan       （R1：1508 / 1507，差 −1）
   1280   葬花              （R1：1280 / 1272，差 −8）
  全库音符总数 = 321330   解析失败 0   warnings 26
```
且我的参照实现与交付物在**全部 307 首上音符条数一致（0 差异）** ⇒ 结构性问题**已闭环**。

### 5.4 排除「取整模式」这一伪因时，发现我 R1 的尺子本身有错（重要）
R1 我按 .NET **Framework** 的行为给参照实现用了「四舍五入到 tick」。本轮我拉了 .NET 运行时的真实源码，发现**我用错了**：

```csharp
// dotnet/runtime  main 分支 与 release/8.0 分支 均一致（两处都已核对）
public static TimeSpan FromMilliseconds(double value) => Interval(value, TicksPerMillisecond);
private static TimeSpan IntervalFromDoubleTicks(double ticks) {
    if ((ticks > long.MaxValue) || (ticks < long.MinValue) || double.IsNaN(ticks)) ThrowOverflow...;
    return new TimeSpan((long)ticks);     // ← (long) 是向零【截断】，不是四舍五入
}
```
（同一文件里 `operator *` / `operator /` 才用 `Math.Round`，并附注释解释为何那里要 round —— 说明作者是**有意**让 `FromMilliseconds` 走截断。）
本机装的是 **.NET runtime 8.0.31**。BetterGI 用 `[GeneratedRegex]`、record `with`、集合表达式 `[]`、primary constructor ⇒ 确定是 .NET 8+ ⇒ **截断语义**。

我据此把参照实现的 `fromMs` 从 `Math.round` 改成 `Math.trunc`（§5.3 的所有数字都是**截断版**）。这也解释了 R1 的一个观察：当时 round/trunc 两版差异数不同（352 vs 389），我只当成「敏感性检验」，实际是**我的尺子不准**。

### 5.5 残留 53 音的根因（已追到 tick 级，非 `Normalize` 缺口）
```
Bad Apple key=C 3400–3550ms 窗口（tick 级原文）:
[1] 解析器原始产出: D@34285714 U@34628571 D@34628571 U@34971428 D@34971429 U@35314286 D@35314286
                                                          └──── Δtick = 1 ────┘
     U@34971428 → D@34971429   Δtick=1  ⇒ 不同刻 ⇒ 两级 30ms 规则都不触发
```
- **交付物**：`quantizeTicks` 用 `Math.round(x*10000)`，且是「先把 ms 相加、再取整」⇒ `round(a+b)`；
- **BetterGI / .NET 8**：`TimeSpan.FromMilliseconds` 对每一段**分别截断**，`AddNote` 再以整数 tick 相加 ⇒ `trunc(a) + trunc(b)`；
- 两者可差 **1 tick（0.0001ms）**。而 `ApplyRepeatedKeyGap` 与 `Normalize` 阶段 2 都用 **`Time == item.Time` 精确整数相等**作判据 ⇒ 这 1 tick 差会**翻转整条 30ms 规则**，放大成 30ms 的音符时值差。

残留 53 音的构成：**1 音**是文档化的 `start<end` 兜底（§7-🟢12），另 **52 音**是上述 1-tick 翻转，分布在 3 首（Bad Apple 25 / 提瓦特民谣 14 / Counting Stars 13）。

**要不要改**：`Math.trunc` 能把这 52 音也归零，但会同时改掉作者那条回归护栏（`C C C [{C}{C}{C}{C}{C}]` 的期望值）——**因为那条护栏本身编码的是 round 口径**（见 §7-🟢13）。我判断：**不值得改**。0.016% 的音符、只差时值、拨弦音色下不可闻。

---

## 6. 数据一致性抽查

### 6.1 随机抽 20 首（覆盖三种 type）
```
  #  type     音符数 时长(s)  warning  文件
   1 yuanqin    1205   245.9        0   喜欢你 - 2XZcuADm.json
   2 yuanqin     559   127.4        0   退后 - K4oOZ75j.json
   3 yuanqin     404    98.6        0   剑决浮云 - VXTUdfzz.json
   4 yuanqin     764   172.4        0   DAMIDAMI - MzSU9qud.json
   5 keyboard    856   144.2        0   将世事高枕 - SkKqNcUx.json
   6 keyboard   1013   231.2        0   圆号卡农 - 4cTzbVLB.json
   7 keyboard   1818   260.7        0   Counting Stars - 6dKMtoRQ.json
   8 keyboard    210   102.3        0   斯露莎的歌 - 2XOI3XHB.json
   9…20 midi  637–1876  50.6–291.4   0   （普通disco / Cry For Me / 稻香 / 丹砂巍巍 / 不染 /
                                          运动员进行曲 / 爱你 / jojo的黄金之风 / 花之舞 / 菊花台C调弹唱 /
                                          高洁的法皇 / 你的名字）
```
**20/20 不变量全部成立、0 warning。判定：✅**

### 6.2 人工核对按下时刻/音高（3 首）

**C1 `小星星 - 20i9ia3Z.json`（yuanqin，bpm=80）** — 原材料 `"Z[4]Z[4]B[4]B[4]|N[4]N[4]B[2]|…"`
```
解析: Z 0→720 | Z 750→1500 | B 1500→2220 | B 2250→3000 | N 3000→3720 | N 3750→4500
```
手算：bpm=80 ⇒ 一拍 750ms，`Z[4]`=750ms。第 1 个 `Z` 因同键紧邻被 `ApplyRepeatedKeyGap` 从 750 截到 **720**（750−30），第 2 个保持 750ms。**✅ 与语义一致。**

**C2 `Bad Apple - xvgqEYdD.json`（keyboard，bpm=350）** — `"C C C [{C}{C}{C}{C}{C}] C C CCC …"`
```
解析前 8 音: C 0→171.429 | C 342.857→514.286 | C 685.714→857.143
            C 1028.743→1033.029 | C 1063.029→1067.314 | C 1097.314→1101.600
            C 1131.600→1135.886 | C 1165.886→1200.171
```
手算：一拍 = 60000/350 = 171.4286ms；`C C C ` ⇒ 前三个 C 起点应为 0 / 342.86 / 685.71 ✅；`[{C}×5]` 从第 6 拍起均分 5 份、每份 0.2 拍 = 34.286ms，`{` 倚音 +0.001 拍 ⇒ 起点 6.001×171.4286 = 1028.743 ✅。**✅ 与语义逐项一致。**

**C3 `midi` 变速** — 基准 `delay(ms) = deltaTicks × 60000 / (bpm × ticks)`
```
DA0|UA480|*120|DB480|UB480 @bpm60 ticks480
⇒ A 0→1000（480×60000/(60×480)=1000ms）| *120 生效 | B 1500→2000（480×60000/(120×480)=500ms）
参照 = 交付物 = 完全一致  ✅
```

---

## 7. 问题清单

> 严重度：🔴 阻断 / 🟡 影响体验 / 🟢 建议。**本轮 🔴 0 条、🟡 0 条。**

### ✅ 已解决（R1 → R2）

#### 🟡1（原）解析器缺少 BetterGI 的 `MusicTimelineBuilder.Normalize()` 阶段 —— **已闭环**
- **原文覆盖**：`bettergi-parse.js:386 normalize()` + `:448 finalizeEvents()`，三种 type 统一走 `normalize(quantizeTicks(events))`，实现了阶段 1（同键未松开就再按下 ⇒ 插入 `KeyUp@(newStart−30)`、吞掉交叠 KeyUp）与阶段 2（同刻 U/D ⇒ U 提前 30ms），且注释明确警告「两处排序都必须是纯稳定排序，绝不能按 Type 二次排序」——与上游源码注释一致。
- **我的独立复测**：结构性差异 4 首 → **0 首**；偏差音符 389→**53**（>0.6ms）、302→**11**（>30ms）；4 首音符数 **3893/1604/1508/1280 全部吻合**；最小复现 `ZZZZZZ/ZZ[4]` 第 7 音 **`3000.500→3470.000`，与参照逐音一致**（修复前为 `3000.500→3500.500`）。
- **判定：✅ 真正闭环**（不是「验收标准说闭环了」）。残留 53 音的独立根因见 §5.5 / §7-🟢11、🟢12，不再是 `Normalize` 缺口。

#### 🟡2（原）`realtime.test.js` 两条恒真断言 —— **已闭环，我逐行核对**
```js
// L167-168  真断言（不再是 litNow >= 0）
ok('播放中有琴键高亮：' + litSamples + '/40 次采样有高亮，最多同时 ' + maxLit + ' 个',
   litSamples >= 5 && maxLit >= 1 && maxLit <= 21, ...);      // 实测 litSamples=39 maxLit=1
// L218-227  真断言（不再是 ok(..., true)）
for (...) { const cur = sec(...); if (cur < tNearEnd - 1) { wrapped = true; break; } }
ok('循环开启时播到曲尾会绕回开头…', wrapped);                  // 实测 35.8s → 0.2s
```
`litSamples`/`maxLit` 是 40 次采样统计；`wrapped` 要求时间**回退 >1 秒**才会为真——两者都可以失败。作者还在源码里留了注释承认旧断言「恒真断言，等于没测」。
**判定：✅ 真断言，高亮与循环现在真的有覆盖。**

#### 🟢8（原）UI「最大同按」口径 —— **已处理，且与我的口径完全一致**
我从 `app.js` 原文抽出 `maxDistinctKeys()` 与我的独立算法逐首复算：
```
app.js 实现: 同刻先处理「抬起」，held[key] 计数，cnt = 不同键数
我的独立算法全库最大不同键同按 = 20   [【原神演奏】Lemon 欢快的版本.json]
「只在按下时统计」变体          = 20   同一首
0 首超过 21                    : 是（0 首）
两种统计口径不一致的曲谱数      : 0
对照：旧的 stats.maxPolyphony 记录口径全库最大 = 63 [aLIEz]
parse.test.js「最大同刻键数」63 → 20；UI 仍以灰色小字附注旧口径
```
**判定：✅ 算法正确、口径与独立复算一致、不再可能出现 >21 的不可能值。**

#### 🟢9（原）seek 断言容差偏松 —— **已处理**
容差由 `max(3, total*0.08)`（36s 曲子 = ±3s）收紧，并**新增**「已跳到接近曲尾（`tNearEnd > total − 1.5`）」与「循环绕回」两条可失败断言。
**判定：✅ 已处理。**

#### 🟢10（原）仓库测试无运行时网络断言 —— **已处理**
`realtime.test.js:343-398` 新增 `Network.enable` + `Network.requestWillBeSent` 统计，并断言 `httpReqs.length === 0`、`otherReqs.length === 0`、`fileReqs.length > 0`。实测输出与我自己的独立审计（§4.4）**完全一致**（6 个全 `file://`）。
**判定：✅ 已处理，且是真实运行时证据而非源码 grep。**

### 🟢 仍存在 / 新记录（均不影响交付）

#### 🟢3 `activeAt` 的 `state.maxNoteMs` 只有 1 个写入点（未来易回归）
`var limit = state.maxNoteMs || 0;`，而 `limit===0` 时 `t - n.start >= 0` 对第一个候选音恒真 ⇒ 立刻 break ⇒ **高亮全灭**。实测灌异常值：
```
state.maxNoteMs = undefined / 0 / NaN / null ⇒ limit=0 ⇒ activeAt 返回 0 个音
```
**现状安全**：我核实 `state.maxNoteMs` 只在 `selectEntry`（`app.js:419-424`）写入，且有 `if (!(state.maxNoteMs > 0)) state.maxNoteMs = 1;` 兜底；`state.current` 赋值点只有 `L379(null)`/`L416(sc)`/`L888(null)`，**不存在「设了 current 却没设 maxNoteMs」的路径**。
**建议**：把 `maxNoteMs` 与 `current` 打包，或在 `activeAt` 里加 `if (!(limit > 0)) limit = Infinity;` 降级。

#### 🟢4 `pitchName(Symbol())` 抛 `TypeError`（不可达）
`Number(Symbol)` 本身抛。R2 重跑同样只有这一条 `falsify-parse.js` 真 FAIL。`app.js` 只传数字且外层有 try/catch。
**建议**：`if (typeof midi !== 'number') return '';`。

#### 🟢5 `midi` / `keyboard` 对「非空但无内容」的 notes 判为合法空曲，`yuanqin` 报错
```
midi     notes="   " / "|||"   → ok=true notes=0 durMs=0
keyboard notes="|||"           → ok=true notes=0 durMs=0
yuanqin  notes="   " / "|||"   → ok=false 曲谱 notes 为空
```
**建议**：三个 type 统一用「去掉空白与 `|` 后是否为空」判定。

#### 🟢6 `parseYuanQinTokens` 多出的 `[` 分支 = 对上游的宽容性偏离
`parseScore({type:'yuanqin',notes:'[^]'})` → `ok:true`；上游 `ParseYuanQinTokens` 没有 `[` 分支，会 `throw FormatException("音符 [ 缺少时值")`。我用忠实参照实现扫全库 307 首，**参照抛异常 = 0** ⇒ 没有任何真实文件需要它。
**建议**：保留可以，但注明是对上游的有意放宽。

#### 🟢7 `parseFloat` 比 .NET `double.TryParse` 宽松
`bpm:"90x"` → 交付物用 90（666.667ms），BetterGI 会回退 120（500ms）。**当前无实际影响**：全库 `非正/非数字 bpm = 0 首、ticks = 0 首`。
**建议**：先正则校验再 `Number()`。

#### 🟢11（新）`quantizeTicks` 用 `Math.round`，与 .NET 8 的 `TimeSpan.FromMilliseconds` 截断语义不一致
- **复现**：`Bad Apple` / `提瓦特民谣` / `Counting Stars` 共 **52** 个音符，交付物比 BetterGI 短 30ms。tick 级证据见 §5.5（`U@34971428` vs `D@34971429`，差 1 tick）。
- **证据**：.NET runtime `main` 与 `release/8.0` 两个分支的 `IntervalFromDoubleTicks` 都是 `new TimeSpan((long)ticks)`；本机 .NET runtime 8.0.31。全量对比：交付物 vs **截断版**参照 = 53 音 >0.6ms / 11 音 >30ms / 4 首；vs **四舍五入版**参照 = 16 / 1 / 4 首。
- **影响**：321,330 音中 52 个（**0.016%**），只差**时值**（`Δstart` ≤ 4.3ms），拨弦音色下不可闻。
- **建议**：**不改**。若真要逐 tick 一致，把 `quantizeTicks` 改为 `Math.trunc` 即可，但需同步改 §7-🟢13 那条回归护栏的期望值。**至少在 `.js` 注释里写一句「本实现刻意用 round-to-1e-4ms，与 BetterGI 的 TimeSpan 截断在 1 tick 尺度上可能不同，极端情况下会翻转 30ms 重触发规则」**。

#### 🟢12（新）新增 1 例「退化音符」，Lead 早前「全库 0 例」的说法已不成立
```
含该告警的曲谱数: 1
  [keyboard] 1013 音  圆号卡农 - 4cTzbVLB.json
      有 1 个音符在 BetterGI 语义下时长为 0（同键重触发退化），已抬到 1ms 以满足 start < end
全库 start<end 违反数: 0    最小音符时值: 1.0000ms
```
这是 `Normalize` 阶段 1 的 `retriggerUpTime > holdStart ? retriggerUpTime : item.Time` 在退化情形下补出与 KeyDown **同刻**的 KeyUp 所致——上游 `MusicTimelineBuilder.cs` 注释也承认这一点。交付物按契约把它抬到 1ms 并记 warning，**行为合理且已文档化**。这 1 个音也正是 §5.3 中 53 个残留差异里的 1 个。
**建议**：只是提醒 Lead——「全库 0 例」这句话在新版本上不再成立（现在是 1 例）。

#### 🟢13（新）作者的回归护栏编码的是「round 口径」而非上游语义
`bettergi-parse.js` 的 `selfTest` 回归用例 `C C C [{C}{C}{C}{C}{C}]` @bpm350 期望簇内第 3 音为 `1097.314→1101.600`（4.286ms）：
```
截断参照（=.NET 8 语义）: … 1097.314→1131.600 (34.286ms)
四舍五入参照            : … 1097.314→1101.600 (4.286ms)
交付物                  : … 1097.314→1101.600 (4.286ms)
```
即护栏把「实现当前行为」当成了「规格」。它**不是恒真断言**（能失败），但作为保真护栏，它会阻止别人把取整改成更忠实上游的 `Math.trunc`。
**建议**：在护栏名/注释里注明「本条锁定的是 round-to-1e-4ms 口径，不是 BetterGI 的截断口径」。

#### 🟢14（新，仅提示）`realtime.test.js` 的 1.0× 速率实测 1.13×
容差 `0.75–1.3`，实测 `1.133`（R1 为 `1.000`）。属 CDP 墙钟噪声，未超容差，不构成问题；若想更严可多采样取中位数。另 `integration.test.js`/`headless.html` 里若干 `ok('…不抛', true)` 属「执行到这一行即证据」的惯用法，可接受，不是 R1 那种恒真断言。

---

## 8. 我作废的自己的结论（诚实说明，含本轮新增）

1. **「`lowerBoundEnd` 二分错误 ⇒ seek 后漏播音符」——作废。**
   最初只测到「与线性扫描不一致 4,016/58,163」就下了「漏播」结论。危害量化后：真实曲库 321,246 个探测点、300 万次 fuzz，**丢未来音符 = 0**，并给出证明（§4.1）。降级为 🟢 代码异味。
2. **「`/a` 小写斜杠音符丢了倚音偏移」——作废。**
   上游 `Regex.Replace(processed, @"/([A-Z])", "{$1}")` 本就只匹配大写，交付物是对的。
3. **「`illegalBuffer` 跨调用泄漏」——我自己的断言写错了，作废。**
   我要求每条 warning 都含 `K` 或 `非法`，而那次合法的警告是「notes 中没有解析出任何可演奏音符」。`illegalBuffer` 每次 `parseScore` 开头重置，无泄漏。
4. **「`refined-diff.js` 显示 0 处差异」——我自己的 harness bug，已修。**
   `const byKey = k => {...}` 忽略了入参、永远用 `refNotes` 建表，拿参照跟自己比当然全等。改对后才发现真正的差异。**记在这里当反面教材。**
5. **【本轮】「我的参照实现用四舍五入到 tick」——尺子本身有错，已修正。**
   R1 我按 .NET Framework 的行为用了 `Math.round`，并据此报出「352 音 / 278 音 / 18 首」。本轮拉 .NET runtime（`main` + `release/8.0`）源码，确认 `TimeSpan.FromMilliseconds` 是 **`(long)` 截断**；本机 .NET runtime 8.0.31，BetterGI 用 .NET 8+ 特性。改正为 `Math.trunc` 后，**R1 的 352/278/18 应更正为 389/302/20**（同一旧版交付物、同一分类器），R2 为 **53/11/4**。§5.3 表格给的是修正后的数字。
   教训：**验证者自己的尺子同样要先证伪**——我 R1 只把 round/trunc 差异当成「敏感性检验」，没有去核实哪个才是上游语义，差点让结论偏乐观。
6. **`falsify-parse.js` 的 4 条「FAIL」也是我期望值写错**（`yuanqin` 的 `kz[4]`/`z[4-^]`/`z[4-&]`、`midi` 的 `Uz100`）：上游正则与 `AddNote` 同样会拒绝/丢弃它们，**交付物行为正确**。

---

## 9. 明确「无法在无头环境验证」的部分

1. **音色主观听感**。只有频谱峰值与 RMS（`windsong` 基频误差 0.05%–0.78%、后段 RMS 约为前段 4%）。**「像不像风物之诗琴」「好不好听」需要人耳。** `harp/piano/musicbox` 我只确认「出声 + RMS 量级」，**未核对音色特征**。
2. **真实带声卡的扬声器输出**。全程 headless，音频只到 AnalyserNode，未经过任何真实输出设备。
3. **真实用户交互**。用 `element.click()` / 派发 `input`/`change` 驱动，**没有真实鼠标**：`pointerdown/pointerup` 的 `state.seeking`、拖拽文件夹的 `dragenter/drop`、`webkitdirectory` 的「选择文件夹」对话框都未被真实触发。
4. **`file://` 下 `webkitdirectory` 与目录拖拽的实际可用性**。用注入 `File`/`DataTransfer` 模拟，Chrome 对 `file://` 的目录选择有额外限制，未确证。
5. **`.mid` / `.midi`**。上游 `CanParse` 支持 `.mid`（走 `ParseMidiFile`），本交付物只处理 `.json`；拖入 `.mid` 会被 `/\.json$/i` 过滤并提示「没有找到 .json 曲谱文件」——**逻辑我读了，但没有实测**。
6. **长时间 / 内存压力 / 帧率**。只跑了单首 36s、单首 512s 解析；307 首播放列表的内存增长、`setInterval` 泄漏、长曲上 `requestAnimationFrame` + `drawRoll` 的每帧重绘开销**都没测**。
7. **`--virtual-time-budget` 假象**。该环境下 `#tNow` 永远停在 `0:00.0`；任何依赖虚拟时间的结论我都未采用。
8. **浏览器差异**。只有 Chrome 155.0.8059.80。**Edge 装了但我一轮都没跑**；Safari/Firefox 完全没覆盖。
9. **`research/bettergi-spec.md` 与上游是否一致**。我绕开它直接用上游源码作基准，**这份调研文档本身对不对，我无法回答**。
10. **`player/README.md` 与行为的逐条一致性**。README 在 R2 又改过（`E499CC99BF116509`），我只记录、**未逐条核对**。
11. **真实 .NET 8 运行时执行同一段算术**。本机只有 runtime 8.0.31、**没有 SDK**，无法编译运行 C# 去实测 `TimeSpan.FromMilliseconds`。我用的是**上游源码 + C# `(long)` 转换语义**（`main` 与 `release/8.0` 两个分支一致）作依据；这比「跑一次」更权威，但终究不是跑出来的。

---

## 10. 攻击面清单（我实际试过、但没打出问题的地方）

- `parseScore` 的 36 个畸形输入 + getter/Proxy/循环引用/`Object.create(null)` 恶意对象
- `pitchName` 的 0/127/-1/1e9/NaN/±Infinity/`'abc'`/null/undefined/{}/[]/true（🟢4 除外）
- `yuanqin` 词法：`Z` 缺括号、`Z[` 缺右括号、`Z[4]]`、`Z[0]`、`Z[-4]`、`Z[abc]`、`Z[]`、`(Z`、连音缺 `.$`、`[4]` 无键、`Z[999999999999]`、`Z[1e9]`、`Z[Infinity]`、嵌套括号 —— 全部 `ok:false` 或合法，0 抛异常，0 非法时长
- `keyboard` 词法：`Z)`/`(Z`/`Z]`/`[Z`/`}`/`{Z`/`-Z`/`Z-`/`[]`/`()`/`{}`/`//Z`/`/a`/`/A`/`Z[4]` 混语法/换行/**depth 60000 深嵌套爆栈**（被 catch，进程存活）
- `midi`：`DZ`/`DZabc`/`dz0`/`DZ0|bad|UZ0`/`DZ-1`/`D@0`/`*0`/`*abc`/`*-120`/`*120` 单独/`DZ0.5`/`DZ0|*60|UZ480`/`DZ99999999999`（时长 1.2e9 天，UI 不崩）
- 超大输入：200k 事件 midi（1.6MB / 407ms / 堆 195MB）、300k token yuanqin（900k 音符 / 1.6s）、200 万字符单 token
- 确定性：同输入两次结果字节一致、不修改入参、异常调用后 `illegalBuffer` 不污染下一次
- 调度器：漏播/重复播/变速漂移/seek 卡住/曲尾/循环/中途变速/中途 seek 组合
- 高亮：全库 **321,330** 个时刻的「应亮未亮」全量比对（R1 旧版漏亮 39/266 采样点；R2 版 **0**）
- 零网络：源码逐行 + **Chrome CDP 运行时请求全量**（我自己的 + 仓库新增的，两者一致）
- classic script：三个 js 的 `import/export/fetch/module/require/XMLHttpRequest/WebSocket/sendBeacon` 全扫
- 「最大同按」口径：独立复算 + `app.js` 算法逐行核对，全库 307 首
- 保真度：与 BetterGI 上游源码逐行移植的参照实现对全库 307 首、**321,330** 个音符逐音比对（round 与 trunc 两种取整各跑一遍）——**唯一打出真问题、也是本轮唯一验证出「修复确实生效」的一面**

---

## 11. 一句话总结

**两轮加起来：**
第一轮我找到 1 条真保真度缺口（缺 `Normalize`）与 2 条恒真断言；本轮用**独立参照实现**复测，确认 `Normalize` 缺口已**真正闭环**（结构差异 4 首 → 0 首，偏差 389→53 音 / 302→11 音，最小复现逐音一致，4 首音符数 3893/1604/1508/1280 全中），两条恒真断言已换成**可失败的真断言**（39/40 采样有高亮、曲尾绕回 35.8s→0.2s），🟢8/9/10 也都按我的建议处理且我逐条复核通过。
唯一遗留是 **52 个音符（0.016%）的 1-tick 取整口径差异**（交付物 `Math.round` vs .NET 8 `TimeSpan.FromMilliseconds` 截断），只差时值、拨弦音色下不可闻。
**结论：可以交付。** 同时我在 §8 记录了自己 5 条被推翻的结论——包括本轮发现我第一轮的参照实现取整模式用错、导致当时的偏差被低估（352/278/18 应为 389/302/20）。
