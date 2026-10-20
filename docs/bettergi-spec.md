# BetterGI 曲谱格式与演奏语义规格（源码级）

> 用途：本工作区 `player/` 网页播放器要**逐字节复刻** BetterGI 的解析与演奏语义。
> 所有结论来自 `babalae/better-genshin-impact` **main 分支 2026-10 现状**，每条附 raw 源码 URL + 关键代码片段。
> 凡源码里没读到的，明确写「**未确认**」，不臆造。
>
> 抓取时间：2026-10-18。仓库已重构：`MusicScoreParser.cs` 现在在 **`GameTask/Music/Service/`** 下（不在 `Music/` 根），
> 而 skill 文档里提到的 `ApplyRepeatedKeyGap` / `Normalize` **拆到了 `MusicTimelineBuilder.cs`**。旧路径全部 404。

源码清单（全部 HTTP 200 实测抓到）：

| 文件 | raw URL |
|---|---|
| MusicScoreParser.cs | `https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/MusicScoreParser.cs` |
| MusicTimelineBuilder.cs | `https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/MusicTimelineBuilder.cs` |
| MusicModels.cs | `https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Model/MusicModels.cs` |
| InstrumentProfileService.cs | `https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/InstrumentProfileService.cs` |
| MusicPlaybackService.cs | `https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/MusicPlaybackService.cs` |
| KeyInputTransports.cs | `https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/KeyInputTransports.cs` |
| MusicLibraryService.cs | `https://raw.githubusercontent.com/babalae/better-genshin-impact/main/BetterGenshinImpact/GameTask/Music/Service/MusicLibraryService.cs` |

未找到/未确认：不存在单独的 `MusicConfig.cs`；配置类为 `MusicPlaybackOptions`（见 §6）。`PerformanceScore` 取代了旧的 `MusicScore` 模型。

---

## 1. 入口、默认值与失败语义

`MusicScoreParser.ParseJsonAsync`：

```csharp
var type = GetString(json, "type", "yuanqin").Trim().ToLowerInvariant();
var bpm = GetDouble(json, "bpm", 120);
var ticks = Math.Max(1, (int)Math.Round(GetDouble(json, "ticks", 480)));
var timeSignature = GetString(json, "time_signature", "4/4");
var notes = json["notes"] ?? throw new FormatException("曲谱缺少 notes 字段");

var format = type switch {
    "yuanqin"  => MusicScoreFormat.YuanQin,
    "midi"     => MusicScoreFormat.MidiJson,
    "keyboard" => MusicScoreFormat.Keyboard,
    _ => throw new FormatException($"不支持的 AutoYuanQin 曲谱类型：{type}")
};
```

`GetDouble` 的实现（**字符串数字为什么合法**）：

```csharp
private static double GetDouble(JObject json, string propertyName, double fallback)
{
    var value = GetString(json, propertyName, fallback.ToString(CultureInfo.InvariantCulture));
    return double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var result)
           && result > 0
        ? result : fallback;
}
```

结论（逐条）：

1. `type` 缺省 = **`yuanqin`**；先 `Trim()` 再 `ToLowerInvariant()`（`"MIDI"` 也认）。
2. `bpm` 缺省 = **120**。可以是 JSON 数字也可以是字符串（`"140"`）；**`<=0` 或解析失败一律回退 120**。
3. `ticks` 缺省 = **480**，同样字符串合法；`Math.Max(1, round(...))`，即 **`ticks < 1` 会被抬成 1**。
4. `time_signature` 缺省 = **`"4/4"`**。
5. **缺 `notes` 字段直接抛 `FormatException("曲谱缺少 notes 字段")`**，被 `ParseAsync` 的 catch 兜住 →
   `CreateInvalidScore` → `PerformanceScore.Error` 有值、`IsValid == false`（**不是崩溃**）。
   未知 `type` 同样走这条路（`"不支持的 AutoYuanQin 曲谱类型：xxx"`）。
6. **`notes` 为空字符串不会报错**：解析出空事件列表，`IsValid == true`、`NoteCount == 0`。
   `CannotParse` 只在扩展名不在 `.json/.mid/.midi` 时触发（`MusicLibraryService` 据此跳过）。
7. entry 解析只认 `CanParse` 的三种扩展名；`MusicLibraryService` 递归子目录（`RecurseSubdirectories = true`，
   跳过 reparse point），整个抛异常时记 warning 并跳过该文件。

新增字段语义（`PerformanceScore`，`MusicModels.cs`）：

```csharp
public bool IsMidi => Format == MusicScoreFormat.MidiFile;
public int NoteCount => IsMidi ? MidiNotes.Count
                              : SourceTimeline.Events.Count(x => x.Type == PerformanceEventType.KeyDown);
public string? Error { get; init; }
public bool IsValid => string.IsNullOrEmpty(Error);
```

**注意 `type:"midi"` 的 JSON 走的是 `MidiJson` 而不是 `MidiFile`** —— 后者只用于真 `.mid/.midi` 文件。
两者在时间轴构建里走**完全不同的分支**（§5），这是最容易搞错的地方。

---

## 2. `midi`（MidiJson）词法与算法

### 2.1 词法

```csharp
[GeneratedRegex(@"^(?<status>[DU])(?<keys>[A-Z@]+)(?<ticks>\d+)$", RegexOptions.CultureInvariant)]
private static partial Regex MidiJsonEventRegex();
```

```csharp
var rawParts = sheet.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

for (var index = 0; index < rawParts.Length; index++)
{
    var rawPart = rawParts[index];
    if (rawPart.StartsWith('*'))
    {
        if (!double.TryParse(rawPart[1..], NumberStyles.Float, CultureInfo.InvariantCulture, out bpm)
            || bpm <= 0)
            throw new FormatException($"无法解析 MIDI JSON 变速标记：{rawPart}");
        previousWasEvent = false;
        continue;
    }

    var match = MidiJsonEventRegex().Match(rawPart);
    if (!match.Success) throw new FormatException($"无法解析 MIDI JSON 事件：{rawPart}");

    var status = match.Groups["status"].Value;   // "D" 或 "U"
    var keys   = match.Groups["keys"].Value;     // [A-Z@]+  —— 可以多个字母，是「同刻多个键」
    var deltaTicks = long.Parse(match.Groups["ticks"].Value, CultureInfo.InvariantCulture);
    var delay = TimeSpan.FromMilliseconds(deltaTicks * 60000d / (bpm * ticks));
    cursor += delay;
    ...
}
```

结论：

- 分隔符是 **`|`**；`RemoveEmptyEntries | TrimEntries` ⇒ 连续 `||`、首尾 `|`、片段两侧空白全被忽略。
- 事件 = `D` 或 `U`（大小写敏感，**小写会被判非法**）+ 1..n 个大写字母或 `@` + **非负十进制整数**。
- **Δ 语义 = 相对上一个事件的增量**（`cursor += delay`），不是绝对时刻、也不是相对上一同键事件。
- `Δticks` 允许为 `0`（示例里大量 `...0|`）。
- **`*<数字>` 是谱内变速标记**，`bpm` 就地替换；它**不是事件**，且会把 `previousWasEvent` 置 `false`（见 2.2 的 A 分支）。
- 非法片段（正则不匹配）→ **抛异常，整个文件解析失败**，不是跳过。
- 键字母大小写：`AddExplicitEvents` 里 `char.ToUpperInvariant`，但正则要求 `[A-Z@]+`，所以小写字母在词法阶段就被拒。
- **空 keys 不可能**（`+` 量词）。`D@0` / `U@0` 合法。

### 2.2 两个 30ms 修正（**精确算法，顺序即优先级**）

本工作区实测样本 `DG100|DQ0|DW0|UG30|...|U@0|DG30|...`，`ticks:"1000"`、`bpm:"60"`。

`LowestLatencyMilliseconds = 30`：

```csharp
private const double LowestLatencyMilliseconds = 30;
```

A. **上一事件是「含同键的 U」且间隔 < 30ms ⇒ 把当前 D 往后推满 30ms**：

```csharp
if (status == "D"
    && previousWasEvent
    && previousStatus == "U"
    && previousKeys.Any(keys.Contains)          // 两边键集合有交集
    && delay.TotalMilliseconds < LowestLatencyMilliseconds)
{
    cursor += TimeSpan.FromMilliseconds(LowestLatencyMilliseconds);
}
```

- `previousWasEvent` 在遇到 `*bpm` 标记后为 `false` ⇒ **紧跟变速标记的 D 不享受这个推后**。
- `previousKeys.Any(keys.Contains)` 是**字符交集**：`U` 的任一键字母 ∈ 当前 `keys`。
  **`@` 也参与交集**（`"@".Contains('@')` 成立），所以 `U@0|D...` 不匹配，但 `U@0|D@0` 会匹配。

B. **else-if：当前是 U（且 keys != `@`）、间隔 ≥ 30ms、且下一个片段是「含同键的 D」⇒ 当前 U 提前 30ms**：

```csharp
else if (status == "U"
         && keys != "@"
         && delay.TotalMilliseconds >= LowestLatencyMilliseconds
         && index + 1 < rawParts.Length)
{
    var nextMatch = MidiJsonEventRegex().Match(rawParts[index + 1]);
    if (nextMatch.Success
        && nextMatch.Groups["status"].Value == "D"
        && nextMatch.Groups["keys"].Value.Any(keys.Contains))
    {
        cursor -= TimeSpan.FromMilliseconds(LowestLatencyMilliseconds);
    }
}
```

⚠ 这是 **`else if`**：A 命中时 B **不会再执行**（两者互斥，A 只可能在 D 上命中、B 只可能在 U 上命中，实际不会冲突）。
⚠ 前瞻只看 **原始 `rawParts[index+1]`**，即**下一个片段**；如果下一片段是 `*bpm`，`nextMatch.Success == false` ⇒ 不修正。

C. **`@` = 占位键，只占时间不发音**：

```csharp
if (keys != "@")
{
    AddExplicitEvents(events, cursor, keys, status == "D");
}
```

`AddExplicitEvents` / `AddNote` 也都显式处理 `@`：

```csharp
private static void AddExplicitEvents(ICollection<PerformanceEvent> events, TimeSpan time, string keys, bool isDown)
{
    foreach (var key in keys.Select(char.ToUpperInvariant).Where(SupportedKeys.Contains).Distinct())
        events.Add(new PerformanceEvent(time, key, isDown ? PerformanceEventType.KeyDown : PerformanceEventType.KeyUp));
}

private static void AddNote(...) { if (keys == "@") return; /* ... */ }
```

结论：**`@` 是 `midi` 型的时间占位符 / 静默拍**——事件本身仍参与 Δ 累加与 30ms 判定，
但**既不产生 KeyDown 也不产生 KeyUp**。其他不在 21 键内的字母（如 `I`、`K`）被 `Where(SupportedKeys.Contains)`
**静默过滤，无任何警告**。

D. **关键差异：`midi` 型解析完不再走 `ApplyRepeatedKeyGap`**：

```csharp
MusicScoreFormat.MidiJson => ParseMidiJsonTimeline(GetNotesString(notes, format), bpm, ticks),
```

对比另两型：

```csharp
MusicScoreFormat.YuanQin   => ParseYuanQinTimeline(notes, bpm, timeSignature),
MusicScoreFormat.Keyboard  => ParseKeyboardTimeline(GetNotesString(notes, format), bpm),
```

而 `ParseYuanQinTimeline` / `ParseKeyboardTimeline` 的 return 是
`new PerformanceTimeline(ApplyRepeatedKeyGap(events), cursor)`。
⇒ **`midi` JSON 的同键重叠完全由使用者（谱面作者）自己的 `D/U` 数据保证**；解析器只在 A/B 两处动 `cursor`。

### 2.3 时长公式

```
delayMs = Δticks * 60000 / (bpm * ticks)
```

- `ticks=1000, bpm=60` ⇒ **1 tick = 1 ms**（本工作区 `midi` 型主流写法）。
- `ticks=480, bpm=99` ⇒ 1 tick = 7.5757…ms。
- 累计用 `TimeSpan`（100ns 精度），JS 复刻用 double 毫秒即可（差异 <1e-4ms，不影响可听性）。
- `ticks` 与 `bpm` 都经 `GetDouble`：字符串合法、`<=0` 回退默认。

### 2.4 `midi` 的 timeline Duration（**不是** cursor）

```csharp
return new PerformanceTimeline(events, cursor);
```

⇒ 解析器的 `Duration` **就是光标最终位置**（含末尾 `@` 占位与末尾静默拍的时长）。
但播放器显示的 `PerformanceScore.Duration` 对非 MIDI 文件用的是 `SourceTimeline.Duration` ⇒ 这里就是 `cursor`。
**这与我们契约里的 `stats.durationMs` 不同**：契约规定 `durationMs = max(note.end)`（见 §7），
播放器如果用 `durationMs` 控制总时长，末尾静默会被截掉（无音可听，影响极小）。

---

## 3. `yuanqin` 完整语法

### 3.1 词法

```csharp
private static List<YuanQinToken> ParseYuanQinTokens(string sheet)
{
    // 调用前已把 "\r" 和 "\n" 全部删掉
    while (index < sheet.Length)
    {
        if (sheet[index] == '|') { index++; continue; }          // '|' 被忽略，只当排版分隔
        if (sheet[index] == '(') { /* 读到 ')' 为止，整体当 keys（和弦） */ }
        else { keys = sheet[index].ToString(); index++; }
        if (index >= sheet.Length || sheet[index] != '[')
            throw new FormatException($"音符 {keys} 缺少时值");
        var bracketEnd = sheet.IndexOf(']', index + 1);
        if (bracketEnd < 0) throw new FormatException($"音符 {keys} 的时值缺少右方括号");
        var value = sheet[(index + 1)..bracketEnd];
        index = bracketEnd + 1;
        if (value is "^" or "&") { tokens.Add(new YuanQinToken(keys, 0, value)); continue; }

        var separator = value.IndexOf('-');
        var denominatorText = separator >= 0 ? value[..separator] : value;
        var special = separator >= 0 ? value[(separator + 1)..] : "none";
        if (!double.TryParse(denominatorText, NumberStyles.Float, CultureInfo.InvariantCulture, out var denominator))
            throw new FormatException($"无法解析音符 {keys} 的时值：{value}");
        tokens.Add(new YuanQinToken(keys, denominator, special));
    }
}
```

结论：

- **`\r` 和 `\n` 在词法前就被整体删除**（`sheet.Replace("\r","").Replace("\n","")`），换行无意义。
- **`|` 无条件跳过**，只作视觉分隔，不含时值。
- **每个 token 必须带 `[...]`**，否则抛异常（整个文件失败）。
- `(...)` = 和弦：括号内所有字符都进 `keys`（不校验、不去重，去重发生在 `AddNote` 里 `Distinct()`）。
- `[n]`：`n` 是**时值分母**（`double`，如 `16`、`32`、`4`）。
- `[n-spl]`：`-` 后是特殊标记。`spl` 可取 `none`（无 `-` 时）/ `*` / `#` / `^` / `&` /
  `<整数>.<3|6|$>`（连音标记，见 §3.4）。
- `[^]` / `[&]` = 显式按 / 抬，`Denominator = 0`。
- **`%` 从哪来**：`%` 在字符串里是独立字符，会被当成 keys 解析，且**必须有 `[...]`**，
  即形如 **`%[120]`** ⇒ `Special == "none"`、`Denominator == 120`。
  然后在主循环里被识别：

```csharp
if (token.Special == "%") { bpm = token.Denominator > 0 ? token.Denominator : bpm; continue; }
```

⚠ **注意**：`ParseYuanQinTokens(string)` **只把 `^` 和 `&` 放进 `Special`**，
它**永远不会产出 `Special == "%"`**。`%` 只可能来自 **JArray 形式**（对象数组里 `spl:"%"`）：
`Special` 直接取 `note["spl"]`、`Denominator` 取 `note["type"]`。⇒ **字符串型 notes 里的 `%[120]` 是普通音符，
不会变速**（会在 §3.3 里作为「非法键 `%`」被丢掉但**消耗时值**）。

### 3.2 主循环（逐 token 推进 `cursor`）

```csharp
var cursor = TimeSpan.Zero;
var bpm = initialBpm;
var beatDenominator = ParseBeatDenominator(timeSignature);   // "4/4" -> 4；解析不出或 <=0 -> 4

for (var i = 0; i < tokens.Count; i++)
{
    var token = tokens[i];
    if (token.Special == "%") { bpm = token.Denominator > 0 ? token.Denominator : bpm; continue; }
    if (token.Special is "^" or "&")
    {
        AddExplicitEvents(events, cursor, token.Keys, token.Special == "^");
        if (token.Special == "&") cursor += TimeSpan.FromMilliseconds(LowestLatencyMilliseconds);
        continue;
    }
    // 连音分组（见 3.4）
    ...
    var noteDuration = token.Special == "#"
        ? TimeSpan.FromMilliseconds(60000d / bpm / 16d)
        : GetNoteDuration(bpm, beatDenominator, token.Denominator);
    if (token.Special == "*")
        noteDuration = TimeSpan.FromTicks((long)Math.Round(noteDuration.Ticks * 1.5));

    if (token.Special is "none" or "*")
    {
        var ornamentCount = 0;
        for (var next = i + 1; next < tokens.Count && tokens[next].Special == "#"; next++) ornamentCount++;
        var ornamentsDuration = TimeSpan.FromMilliseconds(60000d / bpm / 16d * ornamentCount);
        if (ornamentsDuration < noteDuration) noteDuration -= ornamentsDuration;
    }

    AddNote(events, cursor, noteDuration, token.Keys);
    cursor += noteDuration;
}
return new PerformanceTimeline(ApplyRepeatedKeyGap(events), cursor);
```

时值基准（`beatDenominator` = `time_signature` 的分母，缺省 `4/4` ⇒ 4）：

```csharp
private static TimeSpan GetNoteDuration(double bpm, int beatDenominator, double noteDenominator)
{
    if (bpm <= 0 || noteDenominator <= 0) throw new FormatException("BPM 和音符时值必须大于 0");
    return TimeSpan.FromMilliseconds(60000d / bpm * beatDenominator / noteDenominator);
}
```

⇒ **`durationMs = 60000 / bpm * beatDenominator / n`**。
`4/4` 下 `n=4` ⇒ 一拍，`n=8` ⇒ 半拍。**`beatDenominator` 只取决于 `time_signature`，与音符的 `n` 无关**。

### 3.3 特殊标记总表（含本工作区实测频次）

对 `完整曲库` 全库 `[...]` 内容做的实测统计（`yuanqin` 型）：

```
16 9391 | 8 7744 | 4 3246 | 8-* 427 | 2 268 | 32 241 | 4-8.3 170 | 4-* 144
2-16.6 116 | 4-8.$ 87 | 6 81 | 8-# 63 | 1 55 | 2-* 41 | 16-# 32 | 15 17
16-* 12 | 2-16.$ 12 | 8-16.3 11 | 4-# 8 | 3 8 | 32-# 8 | 2-4.3 8 | 4-4.3 6 | 8-16.$ 6
```

| 标记 | 含义（源码结论） | 时值 |
|---|---|---|
| `[n]`（无 `-`） | 普通音符，`Special = "none"` | `60000/bpm * bd / n` |
| `[n-*]` | **附点**：先按 `n` 算，再 ×1.5（`TimeSpan.FromTicks(round(ticks*1.5))`） | 见左；且会减去后随装饰音时长 |
| `[n-#]` | **装饰音**：固定 `60000/bpm/16`（**十六分音符**，忽略 `n`） | `60000/bpm/16` |
| `[^]` | 显式 **KeyDown**（`AddExplicitEvents(..., isDown: true)`），**不推进 cursor** | 0 |
| `[&]` | 显式 **KeyUp**（`isDown: false`），并把 cursor **+30ms** | +30ms |
| `[n-<整数>.<3\|6\|$>]` | **连音/连奏标记**，见 §3.4 | 组内按权重分摊 |
| `%[bpm]` | **仅 JArray 形式有效**；字符串形式无效（见 §3.1） | — |

**装饰音「吃掉」前一个音符的时长**（注意方向，很容易写反）：

```csharp
if (token.Special is "none" or "*") {
    var ornamentCount = 0;
    for (var next = i + 1; next < tokens.Count && tokens[next].Special == "#"; next++) ornamentCount++;
    var ornamentsDuration = 60000d/bpm/16d * ornamentCount;
    if (ornamentsDuration < noteDuration) noteDuration -= ornamentsDuration;
}
```

⇒ 一个 `none`/`*` 音符后面若紧跟 k 个 `#`，则**该音符自身时长先扣掉 `k * 十六分`**
（`ornamentsDuration >= noteDuration` 时**不扣**，避免非正时长）。
每个 `#` token 自己仍会 `AddNote` 并各自占一个十六分 ⇒ 整体节奏不被拉长。

**`#` 的 keys 实测总是空字符串**（形如 `(BG)[8]#`）：⭐ 全库实测 `#` 的上下文**全部**是
`[8-#]H` / `[8-#](` / `[16-#]G` … 这类形式 —— 即 **`#` 紧跟在一个正常音符之后、自己带 `[n-#]` 时值**，
**从未出现裸 `#`**。
⇒ 进入主循环的 token 是「正常音符（keys = `H` 等）」+「装饰音 token（keys = `#`）」：
`#` 走 `token.Special == "#"` 分支 ⇒ `noteDuration = 60000/bpm/16`，然后 `AddNote(..., keys="#")`
里 `"#".Where(SupportedKeys.Contains)` 为空集 ⇒ **不产生任何事件，但 cursor 照常推进**（等于一个十六分休止）。
全库实测 `[8-#]` 63 次、`[16-#]` 32 次、`[4-#]` 8 次、`[32-#]` 8 次。
⚠ 我实测复刻的词法（照抄 §3.1）跑遍**全部 27 个 `yuanqin` 文件零失败**，佐证以上理解。

### 3.4 连音 `n.$` / `n.3` / `n.6`（tuplet）

```csharp
[GeneratedRegex(@"^(?<display>\d+)\.(?<end>[36$])$", RegexOptions.CultureInvariant)]
private static partial Regex TupletSpecialRegex();
```

```csharp
if (TupletSpecialRegex().IsMatch(token.Special))
{
    var group = new List<YuanQinToken>();
    while (i < tokens.Count)
    {
        group.Add(tokens[i]);
        if (tokens[i].Special.EndsWith('$')) break;
        i++;
    }
    if (!group[^1].Special.EndsWith('$')) throw new FormatException("连音缺少 .$ 结束标记");

    var totalDuration = GetNoteDuration(bpm, beatDenominator, token.Denominator);   // 注意：用组首 token 的 n
    var weights = group.Select(x => {
        var match = TupletSpecialRegex().Match(x.Special);
        return 1d / double.Parse(match.Groups["display"].Value, CultureInfo.InvariantCulture);
    }).ToList();
    var weightSum = weights.Sum();

    for (var groupIndex = 0; groupIndex < group.Count; groupIndex++)
    {
        var duration = TimeSpan.FromTicks((long)Math.Round(totalDuration.Ticks * weights[groupIndex] / weightSum));
        AddNote(events, cursor, duration, group[groupIndex].Keys);
        cursor += duration;
    }
    continue;
}
```

结论（用全库实测的 `4-8.$`、`2-16.$`、`2-16.6`、`4-8.3` 反推验证）：

- 连音组 = **从第一个匹配 `<n>.<3|6|$>` 的 token 起，到第一个 `Special` 以 `$` 结尾的 token 止（含）**。
  `$` 是**组结束标记**，`3`/`6` 只是组内成员（`3` 与 `$` 可混用，实测 `4-8.3 ... 4-8.$`）。
  若走到 token 末尾仍未见 `$` ⇒ **抛 `"连音缺少 .$ 结束标记"`**。
- **组总时长只看组首 token 的分母 `n`**（`GetNoteDuration(bpm, bd, token.Denominator)`）。
- **组内每个 token 分到 `total * (1/display) / Σ(1/display)`**，最后用 `Math.Round` 到 TimeSpan tick（100ns）。
  例：`4-8.$` 单成员组 ⇒ `Σ = 1/8` ⇒ 分到 `total * 1`（**总时长不变**，就是 `n=4` 的一拍）。
- ⚠ **`$` 组首若 `keys` 为空字符串**（如 `[4-8.$]` 紧跟装饰音那种写法），`AddNote` 不产生事件，
  但 cursor 仍前进 ⇒ 这段是**静默时值**。
- ⚠ `[4-8.3]` 单独出现（无 `$`）⇒ 抛异常。实测全库 `4-8.3` 170 次、`2-16.6` 116 次、`8-16.3` 11 次，
  它们都必须各自成组或以 `$` 收尾 —— 说明真实谱面都是成组写的。

### 3.5 键集合与丢音（`AddNote`）

```csharp
private static void AddNote(ICollection<PerformanceEvent> events, TimeSpan start, TimeSpan duration, string keys)
{
    if (keys == "@") return;
    foreach (var key in keys.Select(char.ToUpperInvariant).Where(SupportedKeys.Contains).Distinct())
    {
        events.Add(new PerformanceEvent(start, key, PerformanceEventType.KeyDown));
        events.Add(new PerformanceEvent(start + duration, key, PerformanceEventType.KeyUp));
    }
}
```

- **大小写不敏感**（`ToUpperInvariant`）。
- **去重**（`Distinct()`）⇒ `(CC)[4]` 只按一次 C。
- 非法键**静默丢弃，无警告**；`@` 整体跳过（同 `midi`）。
- **`@` 在 `yuanqin` 里同样是休止占位**：实测 `完整曲库\01_原琴JSON\关键词 - 3A1TeP33.json` 大量 `@[8]`/`@[4]`/`@[1]`。
- 每个键产生 **一对** KeyDown(start) / KeyUp(start+duration)。

---

## 4. `keyboard` 完整语法

### 4.1 预处理（**顺序不可换**）

```csharp
private static PerformanceTimeline ParseKeyboardTimeline(string sheet, double bpm)
{
    var processed = Regex.Replace(sheet, @"/\(([^)]+)\)", "{$1}");
    processed = Regex.Replace(processed, @"/([A-Z])", "{$1}");
    processed = processed.Replace(" ", "0");
    processed = Regex.Replace(processed, @"/\[([^\]]+)\]", "{[$1]}");
    processed = processed.Replace("/", string.Empty).Replace(">", string.Empty);

    var index = 0;
    var nodes = ParseKeyboardNodes(processed, ref index, null);
    var notes = new List<KeyboardNote>();
    var cumulativeBeats = 0d;
    foreach (var node in nodes) { UnfoldKeyboardNode(node, cumulativeBeats, node.Multiplier, notes); cumulativeBeats += node.Multiplier; }

    var beatDuration = 60000d / bpm;
    foreach (var note in notes)
    {
        var start    = TimeSpan.FromMilliseconds((note.StartBeat + note.OffsetBeat) * beatDuration);
        var duration = TimeSpan.FromMilliseconds(note.DurationBeat * beatDuration);
        AddNote(events, start, duration, note.Key.ToString());
    }
    var totalDuration = TimeSpan.FromMilliseconds(cumulativeBeats * beatDuration);
    return new PerformanceTimeline(ApplyRepeatedKeyGap(events), totalDuration);
}
```

逐步（`+` 表示已被前面步骤消费、后续匹配不到）：

1. `/(` + `[^)]+` + `)` ⇒ `{...}`：`/(C)` ⇒ `{C}`。**在 `/[A-Z]` 之前**，所以 `/(C)` 不会先被第 2 条拆掉。
2. `/([A-Z])` ⇒ `{$1}`：`/C` ⇒ `{C}`。此时 `{` 已不在输入里，`{` **不会被第 1 条回溯匹配**。
3. **空格 ⇒ `0`**（`Replace(" ", "0")`）。⇒ 空白是**休止符**，占 1 拍（倍数可被 `-` 加）。
4. `/\[([^\]]+)\]` ⇒ `{[...]}`：（未在任何实测文件出现，仍照抄）。
5. 删除所有剩余 `/` 与 **所有 `>`**。

⚠ 与旧文档的差异：skill 文档写「`/(`→`{`、去掉 `>`」，**漏了 2/3/4 三条**。源码是 5 步（含空格→`0`）。

**用真实文件验证这 5 步**（`圆号卡农 - 4cTzbVLB.json`，含 `/` 254 次、`-` 453 次、`>` 34 次）：

```
RAW : '---/----/(HF)---/----/(GD)---/----/(HF)---/----/(JG)---/---->(GE)---/----/(GW)---'
PROC: '-------{HF}-------{GD}-------{HF}-------{JG}-------(GE)-------{GW}-------'
```

读法：`/----` ⇒ 第 2 步把 `/` 换成 `{` 后是 `{----`，而 `----` 是**四个 `-` 节点**
（每个独立 `-` 都走 `else if (current == '-')` 分支去加**前一个**节点的 `Multiplier`）——
但 `{` 已开成组节点（内容为空 `[]`，因为紧跟的 `-` 不是字母），其 `Multiplier` 被连加 4 次
⇒ 该组占 4 拍、无音。`>` 被第 5 步删掉，后面的 `/(GE)` 正常变成 `{GE}`。

**空格 → `0` 是高频路径**（`Bad Apple` 184 个空格、`Counting Stars` 882 个）：

```
RAW : 'C C C [{C}{C}{C}{C}{C}] C C CCC C C [CCCCC]'
PROC: 'C0C0C0[{C}{C}{C}{C}{C}]0C0C0CCC0C0C0[CCCCC]'
```

⇒ 每个空格都是一个**独立的 `0` 休止节点**，各占 1 拍（默认 `Multiplier = 1`）。

**`/` 的两种形态都真实存在**（实测计数）：`/(...)` 组形式（如 `/(CN` 61 次、`/(XB` 52 次）
与 `/字母` 单键形式（如 `/A` 60 次、`/Q` 49 次、`/D` 46 次）。⇒ 第 1、2 条 regex 都必需。

### 4.2 节点解析

```csharp
private static List<KeyboardNode> ParseKeyboardNodes(string text, ref int index, char? closing)
{
    while (index < text.Length)
    {
        var current = text[index];
        if (closing.HasValue && current == closing.Value) { index++; return nodes; }

        KeyboardNode node;
        if (current is '(' or '[' or '{')
        {
            index++;
            var expectedClosing = current switch { '(' => ')', '[' => ']', '{' => '}', _ => throw new InvalidOperationException() };
            node = new KeyboardNode(current, null, ParseKeyboardNodes(text, ref index, expectedClosing));
        }
        else if (current is ')' or ']' or '}') throw new FormatException($"键谱出现不匹配的括号：{current}");
        else if (current == '-')
        {
            if (nodes.Count == 0) throw new FormatException("键谱延音符号前没有音符");
            nodes[^1].Multiplier++;
            index++;
            continue;
        }
        else { node = new KeyboardNode('\0', current, []); index++; }

        while (index < text.Length && text[index] == '-') { node.Multiplier++; index++; }
        nodes.Add(node);
    }
    if (closing.HasValue) throw new FormatException($"键谱缺少右括号：{closing.Value}");
    return nodes;
}
```

- 三种括号**同构**：`(...)` 和弦（同刻）、`[...]` 琶音（均分时值）、`{...}` 和弦但 **+0.001 拍微偏移**。
- `Multiplier` 初值 **1**；**每遇到一个 `-` +1**（节点后紧跟的由 `while` 吃掉；紧跟 `)`/`]`/`}` 之后的由
  `else if (current == '-')` 分支回溯加到 `nodes[^1]`）。
- ⚠ **`-` 只加 1 拍，不能表示半拍**（与 skill 文档一致）。⚠ 旧文档说 `-` 每次加「1 拍」有时被写成「1/2 拍」，源码是 **1 拍**。
- **空 `[]` 合法**（不匹配任何子节点，占 `Multiplier` 拍但无音）。
- 缺右括号 ⇒ 抛异常；多余的右括号 ⇒ 抛异常。

### 4.3 展开（`UnfoldKeyboardNode`）

```csharp
private static void UnfoldKeyboardNode(KeyboardNode node, double startBeat, double durationBeat, ICollection<KeyboardNote> output)
{
    if (node.Value.HasValue)
    {
        var key = char.ToUpperInvariant(node.Value.Value);
        if (key != '0' && SupportedKeys.Contains(key))
            output.Add(new KeyboardNote(key, startBeat, 0, durationBeat));
        return;
    }

    var offset = node.Type == '{' ? 0.001 : 0;
    if (node.Type == '[' && node.Children.Count > 0)
    {
        var unit = durationBeat / node.Children.Count;
        for (var i = 0; i < node.Children.Count; i++)
            UnfoldKeyboardNode(node.Children[i], startBeat + i * unit, unit, output);
    }
    else
    {
        foreach (var child in node.Children)
            UnfoldKeyboardNode(child, startBeat + offset, durationBeat, output);
    }
}
```

- **顶层序列是顺序的**：每个节点占用 `Multiplier` 拍，`cumulativeBeats += node.Multiplier`。
- `'0'`（含空格与字面 `0`）⇒ **静默丢弃**；非 21 键字符同样**静默丢弃**，但**时间照常流逝**。
- `[...]`：**均分**成 `n` 份（`unit = duration / children.Count`），第 i 个 child 起点 = `start + i*unit`。
  注意：`unit` 只影响起点，child 自己的 `Multiplier` 在展平时**不参与**（`UnfoldKeyboardNode(child, startBeat+i*unit, unit, ...)` 里
  `durationBeat` 已被换成 `unit`）。
- `{...}` 与 `(...)`：所有 child **同一起点**（`start + offset`），整组共享 `durationBeat`；
  `{` 多 **0.001 拍** 偏移 ⇒ 产生「几乎同刻」的先后感。
- 字符为 `#`、`@`、`%`、`^`、`&` 等非 21 键字符：**不发音、静默**（`SupportedKeys.Contains` 为 false）。
  ⚠ `@` 在键盘型**不是**占位符语义 —— 它只是「不在 21 键内」而被丢，没有 `midi`/`yuanqin` 里那种特判。

### 4.4 时长

```
beatDuration = 60000 / bpm        // bpm 缺省 120 ⇒ 500ms
note.start    = (StartBeat + OffsetBeat) * beatDuration
note.duration = DurationBeat * beatDuration
timeline.Duration = cumulativeBeats * beatDuration
```

`bpm` 从 JSON 的 `bpm` 字段来（`GetDouble`，字符串合法、`<=0` 回退 120），**`ticks` 对 keyboard 完全无意义**。

---

## 5. 时间轴构建：`midi` JSON 与「原琴」两型的**根本差异**

```csharp
public PerformanceTimeline Build(PerformanceScore score, InstrumentProfile outputProfile, int transpose)
    => score.IsMidi ? BuildMidiTimeline(score, outputProfile, transpose)
                    : BuildKeyTimeline(score, outputProfile, transpose);
```

⚠ `IsMidi` 只在 `Format == MidiFile`（真 `.mid` 文件）时为 true。
本工作区 `type:"midi"` 的 JSON 是 `MidiJson` ⇒ **走 `BuildKeyTimeline`**。

### 5.1 `BuildKeyTimeline`（三种 JSON 型都走这里）

```csharp
var sourceProfile = profileService.Find(score.Instrument);
var isRawPassThrough = ReferenceEquals(sourceProfile, outputProfile) && transpose == 0;

foreach (var item in score.SourceTimeline.Events)
{
    char targetKey;
    if (isRawPassThrough) targetKey = item.Key;
    else if (sourceProfile.TryGetNote(item.Key, out var midiNote)
             && outputProfile.TryGetKey(midiNote + transpose, out targetKey)) { }
    else continue;

    events.Add(item with { Key = targetKey });
    if (item.Type == PerformanceEventType.KeyDown) mappedDownKeys.Add((item.Time, item.Key));
}
score.MappedNoteCount = mappedDownKeys.Count;
return new PerformanceTimeline(Normalize(events), score.SourceTimeline.Duration);
```

- **输出乐器 == 来源乐器** 时（`Find(score.Instrument)` 与输出 profile 是**同一个对象**）且 `transpose == 0`
  ⇒ `isRawPassThrough`，按键**原样透传**，不查表。这就是为什么本地曲库里 `instrument:"老旧的诗琴"` 等
  仍然照 21 键原样发声（10 个内置模板共用 `StandardMappings`）。
- 否则走**「键 → 音高 → 目标键」**两跳，`TryGetKey` 可能失败 ⇒ **静默丢音**（§6.2）。
- `Duration` 对非 MIDI 文件仍是 `SourceTimeline.Duration`。

### 5.2 `Normalize`（`ApplyRepeatedKeyGap` 的「不改 Type 排序」版本）

这是**实际播放**时对「原琴」三型与真 MIDI 都生效的最终整理器（`midi` JSON 走这里，不走 `ApplyRepeatedKeyGap`）：

```csharp
private static readonly TimeSpan RetriggerGap = TimeSpan.FromMilliseconds(30);

private static IReadOnlyList<PerformanceEvent> Normalize(IEnumerable<PerformanceEvent> source)
{
    // 注意:两处排序都必须使用稳定排序,且不能按“松开优先”二次排序。
    var sorted = source.OrderBy(x => x.Time).ToList();
    var activeCounts = new Dictionary<char, int>();
    var holdStarts   = new Dictionary<char, TimeSpan>();
    var result = new List<PerformanceEvent>(sorted.Count);

    foreach (var item in sorted)
    {
        activeCounts.TryGetValue(item.Key, out var count);
        if (item.Type == PerformanceEventType.KeyDown)
        {
            if (count > 0 && holdStarts.TryGetValue(item.Key, out var holdStart))
            {
                var retriggerUpTime = item.Time - RetriggerGap;
                result.Add(new PerformanceEvent(
                    retriggerUpTime > holdStart ? retriggerUpTime : item.Time,
                    item.Key, PerformanceEventType.KeyUp));
            }
            result.Add(item);
            holdStarts[item.Key] = item.Time;
            activeCounts[item.Key] = count + 1;
        }
        else
        {
            if (count <= 0) continue;                       // 孤儿 KeyUp：直接丢弃
            activeCounts[item.Key] = count - 1;
            if (count == 1) { result.Add(item); holdStarts.Remove(item.Key); }
            // count > 1: 这个松开属于之前已被重触发闭合的按住,直接吞掉
        }
    }

    var previousDown = new Dictionary<char, TimeSpan>();
    var previousUpIndex = new Dictionary<char, int>();
    for (var index = 0; index < result.Count; index++)
    {
        var item = result[index];
        if (item.Type == PerformanceEventType.KeyDown)
        {
            if (previousUpIndex.TryGetValue(item.Key, out var upIndex)
                && result[upIndex].Time == item.Time
                && previousDown.TryGetValue(item.Key, out var downTime))
            {
                var earlyTime = item.Time - RetriggerGap;
                if (earlyTime > downTime) result[upIndex] = result[upIndex] with { Time = earlyTime };
            }
            previousDown[item.Key] = item.Time;
        }
        else previousUpIndex[item.Key] = index;
    }

    return result.OrderBy(x => x.Time).ToList();
}
```

**两个阶段**：

- **阶段 1（去重叠 / 强制重触发）**：同键上一个音还没松开就来了新的 KeyDown ⇒
  在 `newStart - 30ms` 处**补一个 KeyUp**（若该时刻 ≤ 上一个 KeyDown 起点，则退化到 `newStart` 本身）。
  这样后续真正属于「旧按住」的 KeyUp 会被 `activeCounts` 计数吞掉（`count > 1` 分支）。
- **阶段 2（相邻同键 30ms 提前松开）**：若某 KeyUp 与同键紧接着的 KeyDown **时刻完全相等**，
  且 `newStart - 30ms > 上一次 KeyDown 起点`，则把**那个 KeyUp 提前 30ms**（`with { Time = earlyTime }`）。

⇒ **「30ms 提前松开」改的是 `U`，不是 `D`**（`result[upIndex] with { Time = ... }`）。
但这**只在 U 与 D 同刻**时触发 ⇒ 净效果是**音符时长被压缩 30ms**。
（对比 §2.2 A：`midi` JSON 的解析器改的是 `cursor`，即把 `D` 往后推 —— **两条路径动的东西不同**，别混。）

- 孤儿 KeyUp（没有对应按住）**被丢弃**，孤儿 KeyDown 保留。
- **没有任何「最小音符时长」常量**（除 §2.1 真 MIDI 文件的 `lengthTime <= 0 → 30ms`）。
  （⚠ 早期版本此处写「阶段 1 理论可产出 0 长度音符」——**已由 §5.5 修正**：实际不会。）
- 两处都**只用稳定排序**（`OrderBy(x => x.Time)`），**绝不按 Type 二次排序**；
  源码注释明确警告：同刻的「松开/按下」插入时已是「松开在前」，重排会造成粘键、单键按住数十秒。

### 5.3b ⭐ `Normalize` 的落地位置与**解析器必须做的两段式整理**

> 本节是 2026-10-18 的**修正与补充**：§5.3 的 `ApplyRepeatedKeyGap` **只是解析期**的一半，
> 上游还有**装配期**的 `Normalize`。早期版本的本规格（以及据此写出的 JS 解析器）
> 只实现了前者，导致全库 18 首 / 352 个音符有 >0.6ms 的时序偏差（最大 43.02ms），
> 并有 **4 首音符数少算**（共少 84 个）。补齐后全库音符数 321,246 → **321,330**。

**两段式管线（对 `type:yuanqin` / `midi` / `keyboard` 三种 JSON 全部成立）**：

```
MusicScoreParser.ParseJsonAsync
  └─ ParseYuanQinTimeline / ParseMidiJsonTimeline / ParseKeyboardTimeline
       ├─ yuanqin / keyboard：产出 events 后调用 ApplyRepeatedKeyGap(events)   ← 解析期（§5.3）
       └─ midi：**不调用**（谱内自带 D/U）
  ⇒ PerformanceScore.SourceTimeline.Events

MusicTimelineBuilder.BuildKeyTimeline            ← 装配期（三种 JSON 都走这里）
  └─ Normalize(events)                            ← §5.2，**解析器必须等价实现**
```

**为什么两个都要**：二者触发判据不同，互相不可替代。

| | `ApplyRepeatedKeyGap`（解析期） | `Normalize`（装配期） |
|---|---|---|
| 触发判据 | `events[upIndex].Time == item.Time`（**精确同刻**） | `activeCounts[key] > 0`（**同键上一个音还没松开**） |
| 动作 | 把那个 KeyUp **提前 30ms**（就地位移） | **插入**一个新 KeyUp @ `newStart-30`，并**吞掉**被交叠的旧 KeyUp |
| 覆盖面 | 只对 yuanqin / keyboard | 三种 type 全部 |
| 排序 | `OrderBy(Time).ThenBy(KeyUp 优先)` | **纯稳定排序**（只按 Time，禁止按 Type 二次排序） |

⇒ `{…}` 倚音带的 **+0.001 拍**（如 bpm120 下 0.5ms）偏移会让「精确同刻」判定失效，**只有 `Normalize` 能救**。

**JS 落地形式**（`player/js/bettergi-parse.js`）：

```js
// 解析产出 events → 量化到 TimeSpan tick → 装配期 Normalize → 配对成 notes
function finalizeEvents(events) { return normalize(quantizeTicks(events)); }
var notes = pairNotes(finalizeEvents(context.events), context.warnings);
```

三点工程注意（都是实测踩出来的）：

1. **必须先量化到 tick（1e-4 ms）再做同刻比较**。BetterGI 用 `TimeSpan`（整数 tick），
   所以 `Time == Time` 可靠；JS 用 double 毫秒时两个「数学同刻」的时刻会因**不同算式**
   （`(sb+ob)*beat` vs `(sb+i*unit)*beat`）差 1ulp，令 `===` 失败、30ms 规则漏触发，
   音符被拉长最多 8 倍。量化后与上游一致。
2. **`Normalize` 的两处排序都不能按 Type 二次排序**（源码注释警告：同刻「松开/按下」
   插入时已是「松开在前」，重排会形成「松开、按下、按下」→ 传输层吞一次触发并粘键）。
3. **`Normalize` 会改变 `stats.maxPolyphony`，且是变准**：全库最大同刻从 63 降到 20
   （`【原神演奏】Lemon 欢快的版本.json`）。63 是旧事件序下扫描线的虚高；
   该指标已由独立参照实现复核，307/307 文件一致。

**最小回归用例**（`{…}` 偏移致 `ApplyRepeatedKeyGap` 漏触发）：

```
{type:'keyboard', bpm:120, notes:'ZZZZZZ/ZZ[4]'}
  缺 Normalize：第 7 音 = 3000.500 .. 3500.500
  有 Normalize：第 7 音 = 3000.500 .. 3470.000   （= 第 8 音 KeyDown@3500 − 30ms）
```

### 5.3c `Normalize` 阶段 1 与「零长度音符」（修正 §5.2 的旧表述）

§5.2 曾写「阶段 1 理论可产出 0 长度音符」。补全后修正为：**实际不会**。
阶段 1 插入 KeyUp 的时刻是 `max(newStart − 30ms, holdStart)` —— 该式**恒 > holdStart**
（因为 `newStart > holdStart`），而 `holdStart` 正是上一个音的 KeyDown 时刻。
⇒ 插入的 KeyUp 严格晚于上一个 KeyDown，配对出的音符 `start < end` 恒成立。
**实测全库 307 首、321,330 个音符：零长度 / 负长度音符 = 0**。
`pairNotes` 里 `start + 1ms` 的兜底保留为纯防御性代码（全库 0 例触发）。

### 5.3 `ApplyRepeatedKeyGap`（仅 `yuanqin` / `keyboard` 的解析器内部用）

```csharp
private static IReadOnlyList<PerformanceEvent> ApplyRepeatedKeyGap(List<PerformanceEvent> source)
{
    var events = source
        .OrderBy(x => x.Time)
        .ThenBy(x => x.Type == PerformanceEventType.KeyUp ? 0 : 1)   // 同刻 U 在前
        .ToList();
    var previousDown = new Dictionary<char, TimeSpan>();
    var previousUpIndex = new Dictionary<char, int>();

    for (var i = 0; i < events.Count; i++)
    {
        var item = events[i];
        if (item.Type == PerformanceEventType.KeyDown)
        {
            if (previousUpIndex.TryGetValue(item.Key, out var upIndex)
                && events[upIndex].Time == item.Time
                && previousDown.TryGetValue(item.Key, out var downTime))
            {
                var earlyTime = item.Time - TimeSpan.FromMilliseconds(LowestLatencyMilliseconds);
                if (earlyTime > downTime) events[upIndex] = events[upIndex] with { Time = earlyTime };
            }
            previousDown[item.Key] = item.Time;
        }
        else previousUpIndex[item.Key] = i;
    }

    return events.OrderBy(x => x.Time)
                 .ThenBy(x => x.Type == PerformanceEventType.KeyUp ? 0 : 1).ToList();
}
```

与 §5.2 阶段 2 **同一算法**，差别只有两点：
1. 这里**同刻 `U` 排前**（`ThenBy`），`Normalize` 用纯稳定排序；
2. 这里**没有阶段 1**（不做重叠闭合），所以重叠音符会自然产生「U 在同刻 D 之前」的配对。

⇒ 对「音符首尾相接」的正常谱面，两者结果一致：`U` 保留在原时刻、`D` 也在原时刻，
但配对时 `U@t` 与 `D@t` 之间夹了 30ms 前的提前松开……**实际配对的净效果**：
`AddNote` 产生 `U(start+duration)`；下一个音符的 `D(start+duration)` ⇒
`U` 被提前到 `start+duration-30` ⇒ **前一个音符缩短 30ms**（与 §5.2 同）。

⚠ 但**只有 `Normalize` 能处理「非精确同刻」的重叠**（如 `{…}` 倚音的 0.5ms 偏移），
且 `Normalize` 对三种 type 都生效 —— 见 §5.3b。完整的最终时间轴 = **两段都要过**：

```
events
  → [仅 yuanqin/keyboard] ApplyRepeatedKeyGap   （解析期，精确同刻 ⇒ U 提前 30ms）
  → quantizeTicks                               （对齐 TimeSpan 精度，JS 必需）
  → Normalize                                   （装配期，重叠闭合 + 同刻 U 提前 30ms）
  → pairNotes → Note[]
```

---

## 6. 21 键映射表与 `TryGetKey` 折叠语义

### 6.1 映射表（源码原文）

`InstrumentProfileService.StandardMappings`：

```csharp
private static readonly (char Key, int Note)[] StandardMappings =
[
    ('Z', 48), ('X', 50), ('C', 52), ('V', 53), ('B', 55), ('N', 57), ('M', 59),
    ('A', 60), ('S', 62), ('D', 64), ('F', 65), ('G', 67), ('H', 69), ('J', 71),
    ('Q', 72), ('W', 74), ('E', 76), ('R', 77), ('T', 79), ('Y', 81), ('U', 83)
];

private static readonly string[] BuiltInProfileNames =
[
    "风物之诗琴", "老旧的诗琴", "镜花之琴", "谐律键琴", "跃律琴",
    "悠可琴", "晚风圆号", "余音", "绮筵之鼓", "聚聚鼓"
];
// 只有鼓类用 Exact，其余 8 个（含风物之诗琴）都用 MelodicOctaveFold
var mode = name is "绮筵之鼓" or "聚聚鼓"
    ? InstrumentMappingMode.Exact
    : InstrumentMappingMode.MelodicOctaveFold;
```

⇒ 与任务背景给出的映射**完全一致**，且**10 个内置乐器共用同一张表**。
音域 = **48..83**（36 个半音）、**纯白键**（C 大调，无升降号）。

### 6.2 `TryGetKey`（折叠 / 失败行为）

```csharp
public bool TryGetKey(int midiNote, out char key)
{
    if (Mappings.Count == 0) { key = default; return false; }

    var targetNote = midiNote;
    if (MappingMode == InstrumentMappingMode.MelodicOctaveFold)
    {
        var min = Mappings.Min(x => x.MidiNote);
        var max = Mappings.Max(x => x.MidiNote);
        while (targetNote < min) targetNote += 12;
        while (targetNote > max) targetNote -= 12;
    }

    var mapping = Mappings.FirstOrDefault(x => x.MidiNote == targetNote);
    if (mapping?.Key.Length == 1) { key = char.ToUpperInvariant(mapping.Key[0]); return true; }
    key = default; return false;
}
```

- `MelodicOctaveFold`：**只做 ±12 的八度平移，永不吸附到最近白键**。
  `while (targetNote < 48) += 12; while (> 83) -= 12;`
  ⇒ 例如 45 → 57(N)、84 → 72(Q)；但 **61（C#4）落在 48..83 内 ⇒ 查不到 ⇒ `false` ⇒ 调用方 `continue` 静默丢音**。
- `Exact`（鼓类）：不折叠，越界直接失败。
- `TryGetNote`（键 → 音高）是**大小写不敏感**的线性查找。

### 6.3 对本地曲库的含义

`midi` JSON 里出现的字母必须**本身就在 21 键内**才会产生事件（`AddNote`/`AddExplicitEvents` 的 `Where(SupportedKeys.Contains)`）。
本地 `midi` 样本里出现 `H`、`Z`、`V`、`E`、`B`、`R`、`C`、`U` 等，全在表内。
**全库 307 个 JSON 里没有任何一个需要 `TryGetKey` 折叠**（因为 JSON 型谱面本身只写 21 键字母）——
折叠只在**真 MIDI 文件**（`.mid/.midi`）路径上起作用，本工作区曲库不含 `.mid`。

---

## 7. 播放时序语义汇总（可直接写成 JS 的伪代码）

### 7.1 同刻多键的排序

- `AddNote` / `AddExplicitEvents` 对**同一个 keys 字符串**用 `Distinct()` 后**按字符顺序**产生事件。
- `(ZCB)[1]` ⇒ KeyDown Z、C、B 各一个，**同刻，顺序 = 字符串内出现顺序**（Z、C、B）。
  这个顺序会保留到最终时间轴（稳定排序，同刻不重排）
  ⇒ **JS 端必须用稳定排序**（`Array#sort` 自 ES2019 起保证稳定，但为可移植性应在比较里只比 `start`，或显式带序号）。
- 不同 keys 字符串的**同刻**事件：顺序 = 它们在 `notes` 里的出现顺序（`yuanqin`/`keyboard`/`midi` 都是顺序插入）。

### 7.2 30ms 规则三处对照（最容易写错的地方）

| 所在 | 作用对象 | 触发条件 | 效果 |
|---|---|---|---|
| `ParseMidiJsonTimeline` A | `cursor`（⇒ D 的时刻） | D 前一个事件是含同键的 U，且 Δ<30ms | **把 D 后移满 30ms** |
| `ParseMidiJsonTimeline` B | `cursor`（⇒ U 的时刻） | U（非 `@`）Δ≥30ms，且下一片段是含同键的 D | **把 U 提前 30ms** |
| `ApplyRepeatedKeyGap`（yuanqin/keyboard 内部） | U 的时刻 | 同键 U 与 D **同刻**，且解到早于上一次 D | **把 U 提前 30ms** |
| `Normalize`（所有 JSON 型播放时；真 MIDI 在 builder 里另有 `RetriggerGap`） | ① 补 U ② U 的时刻 | ① 同键重叠 ② 同键 U/D 同刻 | ① D-30ms 处补 KeyUp ② 把 U 提前 30ms |

⇒ **「改 U 还是改 D」取决于走哪条分支**：
- `midi` JSON 解析器：**A 改 D（后移）、B 改 U（提前）**；
- `yuanqin`/`keyboard`：**改 U（提前 30ms）**；
- 播放期 `Normalize`：**改 U / 补 U**。
**三者都不会「缩短音符」以外的效果**：净听感都是「同键重复音之间保出 30ms 空隙」。

### 7.3 最小音符时长 / 重叠合并

- **JSON 三型没有「最小音符时长」**。唯一的 30ms 是延迟/间隙语义，不是时长下限。
- 真 `.mid` 文件路径有：`if (lengthTime <= TimeSpan.Zero) lengthTime = TimeSpan.FromMilliseconds(LowestLatencyMilliseconds);`
- **不合并重叠音符**（`midi` JSON 解析器甚至**强制重触发**：见 `BuildMidiTimeline` 里「交叠时强制重触发」的注释）。
- `Normalize` 会吞掉孤儿 KeyUp、补出重触发 KeyUp。

### 7.4 `MusicConfig.InputMode` 各模式差异

没有 `MusicConfig.cs`；等价物是 `MusicPlaybackOptions`（`MusicModels.cs`）：

```csharp
public sealed class MusicPlaybackOptions
{
    public MusicInputMode InputMode { get; init; } = MusicInputMode.BackgroundPostMessage;
    public MusicPlaybackMode PlaybackMode { get; init; } = MusicPlaybackMode.Sequential;
    public double Speed { get; init; } = 1.0;
    public double? CustomBpm { get; init; }
    public bool AutoSwitchInstrument { get; init; }
    public TimeSpan StartPosition { get; init; }
}
```

```csharp
public enum MusicInputMode { BackgroundPostMessage, ForegroundSendInput }
```

**默认 `BackgroundPostMessage`**（skill 文档说法得到源码证实）。
两种模式的差异**只在按键投递通道**，不影响任何时间语义：

```csharp
public sealed class PostMessageKeyInputTransport : KeyInputTransportBase
{ public override MusicInputMode Mode => MusicInputMode.BackgroundPostMessage;
  protected override void SendKeyDown(User32.VK key) => InputHub.Background.Keyboard.KeyDown(key); ... }

public sealed class SendInputKeyInputTransport : KeyInputTransportBase
{ public override MusicInputMode Mode => MusicInputMode.ForegroundSendInput;
  protected override void SendKeyDown(User32.VK key) => InputHub.Foreground.Keyboard.KeyDown(key); ... }
```

但**传输层有一层「已按下集合」去重**，这对复刻很重要：

```csharp
public void KeyDown(char key)
{
    key = char.ToUpperInvariant(key);
    lock (_syncRoot)
    {
        if (!_pressedKeys.Add(key)) return;   // 同一个键重复 KeyDown 被吞掉
        SendKeyDown(ToVirtualKey(key));
    }
}
public void KeyUp(char key)
{
    key = char.ToUpperInvariant(key);
    lock (_syncRoot)
    {
        if (!_pressedKeys.Remove(key)) return;   // 没有按下的 KeyUp 被吞掉
        SendKeyUp(ToVirtualKey(key));
    }
}
```

⇒ **这正是 `Normalize` 阶段 1 存在的理由**：若不补出重触发 KeyUp，重复按下的 KeyDown 会被这里吞掉。

### 7.5 其他播放语义

- 同一时刻的事件按 `PerformanceEvent` 列表顺序逐个 `KeyDown/KeyUp`（`PlayTimelineAsync` 顺序 for 循环）。
- `Seek`/`Resume` 会 `RebuildHeldKeys(position)`：回放 `position` 之前所有事件推导按住状态，对仍按住的键补 `KeyDown`。
- `Speed` 是播放倍率（`Math.Clamp(options.Speed, 0.1, 10.0)`），**不改变时间轴本身**；
  `CustomBpm` 存在且 `score.Bpm > 0` 时，`speed = customBpm / score.Bpm`。
- `WaitUntilAsync` 用 100ms 分片轮询 + `Task.Delay` ⇒ 上机播放有**调度抖动**（不是音源，是等待实现）。

---

## 8. 与本地 `完整曲库`（307 个 JSON）的实测对照

| 项 | 实测 |
|---|---|
| 文件总数 | 307（`01_原琴JSON` 118 / `02_键谱转换JSON` 59 / `04_MIDI-21键适配JSON` 83 / `05_我的新增` 47） |
| `type` 分布 | `midi` **265**、`yuanqin` **27**、`keyboard` **8**、**缺省（无 `type`）7** |
| 缺省 7 个 | 全部脚注为 `yuanqin` 语义（`notes` 带 `[n]` 时值，含 `@` 休止），验证 `type` 缺省 = `yuanqin` |
| 缺省文件举例 | `01_原琴JSON/关键词 - 3A1TeP33.json`（`bpm:"140"` 字符串、`notes:"(EUJV)[8]N[8]…@[8]…"`） |
| `bpm` 字符串 | 真实存在（`"140"` / `"80"` / `"93"` / `"236"`），`GetDouble` 走 `ToString()` 后 `double.TryParse` |
| `midi` 型 `*bpm` 头 | 实测 `aLIEz …json` 的 `notes` 以 `*99|` 开头，而 `bpm` 字段是 `99` ⇒ 头部标记与字段一致 |
| `midi` 的 `@` 实测 | `…|DEHNZ0|UH90|U@30|D@0|UENZ120|…`（`U@30` / `D@0` 成对出现，纯时间占位） |
| `yuanqin` 的 `@` 实测 | `关键词` 里 `@[8]N[8]`、`@[4]@[4]`、`@[1]`、`…@[4]` 大量出现 |
| 连音实测 | `4-8.$` 87、`2-16.$` 12、`8-16.$` 6、`4-8.3` 170、`2-16.6` 116、`8-16.3` 11、`2-4.3` 8、`4-4.3` 6 |
| 装饰音实测 | `8-#` 63、`16-#` 32、`4-#` 8、`32-#` 8 |
| 附点实测 | `8-*` 427、`4-*` 144、`2-*` 41、`16-*` 12 |
| `keyboard` 实测 | 8 个文件；`Bad Apple` 的 `notes` 用空格分隔 + `[...]` + `(...)` + 无 `-`；`圆号卡农` 含 `-` 453 / `>` 34 / `/` 254；其余多为 `/` 200+ 与空格 270–880 |
| `yuanqin` 词法复刻自测 | 按 §3.1 逐字符复刻跑遍 27 个 `yuanqin` 文件：**0 失败**（无「缺少时值」「缺少右括号」「缺 `.$`」） |
| 键盘预处理复刻自测 | §4.1 五步在真实片段上逐步输出与源码语义一致（见 §4.1 验证块） |
| **全库音符总数（含两段整理）** | **321,330**（`midi` 284,463 / `yuanqin` 24,561 / `keyboard` 7,296 / 缺省→yuanqin 5,010） |
| 零长度/负长度音符 | **0**（见 §5.3c；`Normalize` 阶段 1 的插入时刻恒 > 上一个 KeyDown） |
| 全库最大同刻键数 | **20**（`04_MIDI-21键适配JSON/【原神演奏】Lemon 欢快的版本.json`） |
| 非法键 warning | 26 条（都是 21 键外的真非法键，如 `N`/`K`；小写键字母已正确大写，不再产生假 warning） |
| 跨实现一致性 | 与独立参照实现（逐行移植上游源码 + 同款 `Normalize`）逐音比对：**307/307 文件、321,330 音、0 内容差异** |

⚠ 上表第 6 行「`bpm` 字符串」是旧 skill 文档的说法（「`"120"` 也合法」）—— 源码证实：
`GetString` 把 JToken `ToString()` 后 `double.TryParse`，所以**数字与字符串等价**，且**数字也不会走别的高速路径**。

---

## 9. 明确「未确认」清单

1. **`%` 的真实用法**：字符串词法**不可能**产出 `Special == "%"`（只把 `^`/`&` 放进去）。
   **实测全库 307 个文件，含 `%` 的文件数 = 0**。⇒ 「`%` = 调速」只在 **JArray 形式**（对象数组 `spl:"%"`）下成立；
   本地曲库完全不涉及，**无法用真数据验证**，故标「未确认」。
2. **`keyboard` 型的 `-` 上限/语义细节**：源码每次 +1 拍；「无法直接表示 1/2 拍」得到证实。
   但**没有**任何地方把 `-` 当成「1/2 拍」（skill 文档另一处这么写，源码否决）。
3. **`tuplet` 的 `$` 能否出现在非结尾**、`3` 与 `$` 的精确混用规则：源码只以 `EndsWith('$')` 结束分组，
   **未确认**「组内出现多个 `$`」的行为（会在第一个 `$` 处结束）。
4. **`MusicConfig`**：仓库内**没有**这个文件；如存在则在别的命名空间，**未确认**。
5. **`RetriggerGap` 与 `LowestLatencyMilliseconds` 都是 30ms**，但**未确认**是否有地方把它们做成可配置项
   （二者都是 `private static readonly`/`const`，源码里未见外部写入点）。
6. **`NoteName` 的八度约定**：`InstrumentKeyMapping.NoteName` 用 `normalized / 12 - 1`
   ⇒ **MIDI 48 → `C3`、MIDI 60 → `C4`**。这与任务契约 `pitchName(midi) -> "C4" for 60` 一致；
   但**别把琴的最低音 Z(48) 叫 C4** —— 那是「三个八度从 C3 起」的记法，与 §0.5 里 skill 文档的口语说法不同。
7. **传输层 `_pressedKeys` 去重的实际影响**：`PostMessage` 与 `SendInput` 是否在**游戏内**表现一致**未确认**（需要真机）。
8. **真 `.mid/.midi` 文件路径**（`MusicScoreFormat.MidiFile`）本工作区曲库**不包含**（全库只有 `.json`），
   §5.2 里 `BuildMidiTimeline` 的 `RetriggerGap` 用法仅作参考，**未做运行时验证**。
9. **`Normalize` 的两处稳定排序在 C# 里是否真的是「顺序保持」的**：源码用 `OrderBy`（LINQ 稳定排序）
   且注释明确要求「必须稳定排序、不能按 Type 二次排序」，语义已由注释坐实；
   但**未做 C# 运行时验证**（本机无 .NET 环境）。JS 侧用「只比 Time + 显式序号」显式保证稳定性。
10. **`zones 之后是否还有别的装配期步骤**：`BuildKeyTimeline` 里 `Normalize` 是唯一的整理器
   （`BuildMidiTimeline` 另有 `RetriggerGap` 逻辑，仅真 MIDI 文件路径），
   二者之外**未发现**其他会改动时序的装配期处理。
