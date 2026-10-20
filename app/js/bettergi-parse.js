/*!
 * bettergi-parse.js — BetterGI 曲谱解析器（纯 JS、零依赖、classic script）
 *
 * 忠实复刻 BetterGI `MusicScoreParser.cs` 三种 JSON 曲谱型（yuanqin / midi / keyboard）的解析语义，
 * 并把结果整理成播放器可用的音符（Note）列表。
 *
 * 规格依据：`docs/bettergi-spec.md`（源码级，逐条附 BetterGI raw 源码 URL + 片段）。
 * 关键源码对照：
 *   解析   BetterGenshinImpact/GameTask/Music/Service/MusicScoreParser.cs
 *   时序   BetterGenshinImpact/GameTask/Music/Service/MusicTimelineBuilder.cs  (RetriggerGap / Normalize)
 *   映射   BetterGenshinImpact/GameTask/Music/Service/InstrumentProfileService.cs
 *   模型   BetterGenshinImpact/GameTask/Music/Model/MusicModels.cs
 *
 * 环境：浏览器 classic <script> 或 Node.js 直接 eval/require 均可；不使用 import/export/fetch/require。
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  // MusicScoreParser.cs: private const double LowestLatencyMilliseconds = 30;
  var MIN_GAP_MS = 30;

  // MusicScoreParser.cs: private const string SupportedKeys = "QWERTYUASDFGHJZXCVBNM";
  var SUPPORTED_KEYS = 'QWERTYUASDFGHJZXCVBNM'.split('');

  // InstrumentProfileService.cs: StandardMappings（风物之诗琴等 10 个内置乐器共用）
  // 低排 C3–B3 / 中排 C4–B4 / 上排 C5–B5 → MIDI 48..83
  var KEY_TO_PITCH = {
    Z: 48, X: 50, C: 52, V: 53, B: 55, N: 57, M: 59,
    A: 60, S: 62, D: 64, F: 65, G: 67, H: 69, J: 71,
    Q: 72, W: 74, E: 76, R: 77, T: 79, Y: 81, U: 83
  };

  var PITCH_TO_KEY = {};
  SUPPORTED_KEYS.forEach(function (k) { PITCH_TO_KEY[KEY_TO_PITCH[k]] = k; });

  // 默认值（MusicScoreParser.GetDouble / ParseJsonAsync）
  var DEFAULTS = {
    type: 'yuanqin',
    bpm: 120,
    ticks: 480,
    timeSignature: '4/4'
  };

  // MusicScoreParser.cs: [GeneratedRegex(@"^(?<status>[DU])(?<keys>[A-Z@]+)(?<ticks>\d+)$")]
  var MIDI_EVENT_RE = /^([DU])([A-Z@]+)([0-9]+)$/;
  // MusicScoreParser.cs: [GeneratedRegex(@"^(?<display>\d+)\.(?<end>[36$])$")]
  var TUPLET_RE = /^([0-9]+)\.([36$])$/;
  // MusicScoreParser.cs: MidiJsonEventRegex 里的 [A-Z@]+ —— 用来把非法字符单独报出来
  var NON_KEY_CHARS_RE = /[^A-Z@]/g;

  // 本规格唯一需要下游兜底的不变量：Normalize 阶段 1 在极端情况下可能补出与 KeyDown 同刻的 KeyUp
  // （见 spec §5.2）。契约要求 start < end 恒成立，故设 1ms 下限。
  var MIN_NOTE_MS = 1;

  var SCORE_TYPES = { yuanqin: true, midi: true, keyboard: true };

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };

  /**
   * MIDI 音高 → 音名。MIDI 60 = C4（中间 C），48 = C3，83 = B5。
   * 与 BetterGI `InstrumentKeyMapping.NoteName` 的 `normalized / 12 - 1` 一致。
   */
  function pitchName(midi) {
    var m = Math.round(Number(midi));
    if (!isFinite(m)) { return ''; }
    var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    var n = Math.max(0, Math.min(127, m));
    return names[n % 12] + (Math.floor(n / 12) - 1);
  }

  /** BetterGI GetString：JToken 一律 ToString() 取文本 */
  function toText(v) {
    if (v === null || v === undefined) { return ''; }
    return String(v);
  }

  /** BetterGI GetDouble：字符串数字合法；解析失败或 <= 0 一律回退 fallback */
  function toPositiveNumber(v, fallback) {
    var n = parseFloat(toText(v));
    return (isFinite(n) && n > 0) ? n : fallback;
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** 解析产物统一收尾：排序 → 配对 → 统计 */
  function finishScore(context) {
    var opts = context.opts;
    var transpose = Number(opts.transpose) || 0;

    context.warnings = dedupe(context.warnings);

    // 装配期整理：量化到 TimeSpan tick → Normalize（三种 type 统一，对应上游 BuildKeyTimeline）
    // 注意：midi 型不走 applyRepeatedKeyGap，但同样要过 Normalize。
    var notes = pairNotes(finalizeEvents(context.events), context.warnings);
    notes = applyTranspose(notes, transpose, context.warnings);

    // 按 start 升序；同刻保持 BetterGI 发送顺序（数组 sort 自 ES2019 起稳定，
    // 这里再显式带原始序号，保证任何实现下都可复现）
    notes.forEach(function (n, i) { n._seq = i; });
    notes.sort(function (a, b) { return (a.start - b.start) || (a._seq - b._seq); });
    notes.forEach(function (n) { delete n._seq; });

    // durationMs = BetterGI 的 PerformanceTimeline.Duration = **cursor 终值**
    // （yuanqin / keyboard 为各自 cursor；midi 为光标终值）。
    // ⚠ 因此它**含末尾的静默/占位时长**（末尾的 `@` 休止、`[^]`/`[&]` 等），
    //   可能大于 max(note.end)。播放器用这个值做总时长与结束判定，与 BetterGI 一致。
    var durationMs = context.cursor;
    var keysUsed = [];
    var seen = {};
    var maxPolyphony = 0;

    for (var i = 0; i < notes.length; i++) {
      if (notes[i].end > durationMs) { durationMs = notes[i].end; }
      if (!seen[notes[i].key]) { seen[notes[i].key] = true; keysUsed.push(notes[i].key); }
    }
    maxPolyphony = computeMaxPolyphony(notes);
    keysUsed.sort();

    return {
      ok: true,
      error: null,
      name: toText(opts.name !== undefined ? opts.name : context.name) || '',
      author: toText(opts.author !== undefined ? opts.author : context.author) || '',
      instrument: toText(opts.instrument !== undefined ? opts.instrument : context.instrument) || '',
      type: context.type,
      bpm: context.bpm,
      ticks: context.ticks,
      timeSignature: context.timeSignature,
      transpose: transpose,
      notes: notes,
      warnings: context.warnings,
      stats: {
        events: context.events.length,
        noteCount: notes.length,
        durationMs: round3(durationMs),
        keysUsed: keysUsed,
        maxPolyphony: maxPolyphony
      }
    };
  }

  /** 同一键的 KeyDown/KeyUp 用栈配对：栈底是最早仍未闭合的按下（还原 .NET 顺序配对） */
  function pairNotes(events, warnings) {
    var stacks = {};
    var notes = [];
    var unrealized = 0;
    var orphanUps = 0;
    var degenerate = 0;
    var order = 0;

    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var st = stacks[e.key];
      if (!st) { st = stacks[e.key] = []; }

      if (e.down) {
        st.push({ t: e.t, i: order++ });
      } else if (st.length) {
        var d = st.shift();
        var end = e.t;
        if (end <= d.t) {
          // 退化情形：BetterGI 的 Normalize 阶段 1 在「上一个音还未松开就又按下」时，
          // 会在 newStart-30 处补 KeyUp；若该时刻 <= 上一个 KeyDown，则退化到 newStart 本身，
          // 于是可能产出零长度音符（spec §5.2）。契约要求 start < end 严格成立。
          // 这里只抬到 start + 1ms（不改成 30ms，避免悄悄改变正常谱面的时长），并记入 warnings。
          end = d.t + MIN_NOTE_MS;
          degenerate++;
        }
        notes.push({
          key: e.key,
          pitch: KEY_TO_PITCH[e.key],
          start: round3(d.t),
          end: round3(end),
          velocity: 1,
          _seq: d.i
        });
      } else {
        orphanUps++;
      }
    }

    for (var key in stacks) {
      if (Object.prototype.hasOwnProperty.call(stacks, key)) { unrealized += stacks[key].length; }
    }
    if (degenerate > 0) {
      warnings.push('有 ' + degenerate + ' 个音符在 BetterGI 语义下时长为 0（同键重触发退化），已抬到 ' + MIN_NOTE_MS + 'ms 以满足 start < end');
    }
    if (unrealized > 0) {
      warnings.push('有 ' + unrealized + ' 个 KeyDown 没有对应的 KeyUp（补到末尾没有时刻，已丢弃）');
    }
    if (orphanUps > 0) {
      warnings.push('有 ' + orphanUps + ' 个 KeyUp 没有对应的 KeyDown（BetterGI Normalize 会丢弃，已复刻）');
    }
    if (notes.length === 0) {
      warnings.push('notes 中没有解析出任何可演奏音符');
    }
    return notes;
  }

  function applyTranspose(notes, transpose, warnings) {
    if (!transpose) { return notes; }
    var kept = [];
    var dropped = 0;
    for (var i = 0; i < notes.length; i++) {
      var pitch = notes[i].pitch + transpose;
      var key = PITCH_TO_KEY[pitch];
      if (key) {
        notes[i].pitch = pitch;
        notes[i].key = key;
        kept.push(notes[i]);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      warnings.push('移调 ' + transpose + ' 后半音落在琴域外或非白键，已丢弃 ' + dropped + ' 个音符');
    }
    return kept;
  }

  /**
   * 同时发声的最大键数（BetterGI KeyInputTransportBase 用 _pressedKeys 集合去重，
   * 同刻同键只算一次）。采用「最小堆」式扫描：O(n log n)。
   */
  function computeMaxPolyphony(notes) {
    if (!notes.length) { return 0; }
    var sorted = notes.slice().sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    // 用有序数组当最小堆（end 升序）
    var heap = [];
    function push(v) {
      heap.push(v);
      var c = heap.length - 1;
      while (c > 0) {
        var parent = (c - 1) >> 1;
        if (heap[parent] <= heap[c]) { break; }
        var t = heap[parent]; heap[parent] = heap[c]; heap[c] = t;
        c = parent;
      }
    }
    function pop() {
      var top = heap[0];
      var last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        var i = 0;
        for (;;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l] < heap[m]) { m = l; }
          if (r < heap.length && heap[r] < heap[m]) { m = r; }
          if (m === i) { break; }
          var t = heap[m]; heap[m] = heap[i]; heap[i] = t;
          i = m;
        }
      }
      return top;
    }

    var max = 0;
    for (var i = 0; i < sorted.length; i++) {
      while (heap.length && heap[0] <= sorted[i].start) { pop(); }
      push(sorted[i].end);
      if (heap.length > max) { max = heap.length; }
    }
    return max;
  }

  function dedupe(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (out.indexOf(arr[i]) < 0) { out.push(arr[i]); }
    }
    return out;
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  /**
   * 量化到 BetterGI 的 TimeSpan 精度（1 tick = 100ns = 1/10000 ms）。
   *
   * 为什么必须做：BetterGI 全程用 `TimeSpan`（整数 tick）存时刻，所以
   * `ApplyRepeatedKeyGap` 里 `events[upIndex].Time == item.Time` 这种**精确相等**比较是可靠的；
   * 而 JS 用 double 毫秒时，两个「数学上同刻」的时刻会因**不同的算式**（如
   * `(startBeat + offsetBeat) * beatDuration` vs `startBeat + i * unit) * beatDuration`）
   * 产生末位不同的 double，导致 `===` 失败、30ms 规则不触发。
   * 实测：`C C C [{C}{C}{C}{C}{C}]` @bpm350 会出现 KeyUp=1063.0285714285726
   * 与 KeyDown=1063.0285714285715 相差 1ulp ⇒ 规则漏触发 ⇒ 音符时长远长于 BetterGI。
   * 量化后与 BetterGI 语义一致。
   */
  function quantizeTicks(events) {
    for (var i = 0; i < events.length; i++) {
      events[i].t = Math.round(events[i].t * 10000) / 10000;
    }
    return events;
  }

  /**
   * AddNote —— MusicScoreParser.cs:
   *   if (keys == "@") return;
   *   foreach (var key in keys.Select(ToUpperInvariant).Where(SupportedKeys.Contains).Distinct())
   *       events.Add(KeyDown(start, key)); events.Add(KeyUp(start + duration, key));
   * BetterGI 对非法键静默丢弃；本实现**复刻行为**并额外写入 warnings（契约要求）。
   */
  function addNoteFromKeys(events, start, duration, keys, warnings, label) {
    var text = toText(keys);
    if (text === '@') { return; }          // @ = 时间占位/静默拍，不产生事件
    if (!text) { return; }

    // ⚠ 顺序必须与 BetterGI 一致：**先 ToUpperInvariant，再过滤**。
    // 若先做 [^A-Z@] 过滤，小写字母（真实曲库里大量存在，如 `剑决浮云` 整首小写）会被整段删掉。
    var upper = text.toUpperCase();
    var bad = upper.match(NON_KEY_CHARS_RE);         // 词法层就不合法（非 [A-Z@]）
    if (bad) { collectIllegal(bad, label); upper = upper.replace(NON_KEY_CHARS_RE, ''); }
    var emitted = {};
    for (var i = 0; i < upper.length; i++) {
      var k = upper[i];
      if (!Object.prototype.hasOwnProperty.call(KEY_TO_PITCH, k)) {
        collectIllegal([k], label);                  // 合法字母但不在 21 键内 -> 静默丢弃
        continue;
      }
      if (emitted[k]) { continue; }                  // BetterGI Distinct()
      emitted[k] = true;
      events.push({ t: start, key: k, down: true, seq: events.length });
      events.push({ t: start + duration, key: k, down: false, seq: events.length });
    }
  }

  /** AddExplicitEvents（用于 yuanqin 的 ^ / & 显式按抬） */
  function addExplicitFromKeys(events, time, keys, isDown, warnings, label) {
    var text = toText(keys);
    if (text === '@' || !text) { return; }
    var upper = text.toUpperCase();                  // 同上：先大写再过滤
    var bad = upper.match(NON_KEY_CHARS_RE);
    if (bad) { collectIllegal(bad, label); upper = upper.replace(NON_KEY_CHARS_RE, ''); }
    var emitted = {};
    for (var i = 0; i < upper.length; i++) {
      var k = upper[i];
      if (!Object.prototype.hasOwnProperty.call(KEY_TO_PITCH, k)) {
        collectIllegal([k], label);
        continue;
      }
      if (emitted[k]) { continue; }
      emitted[k] = true;
      events.push({ t: time, key: k, down: !!isDown, seq: events.length });
    }
  }

  // collectIllegal 写入的暂存区（每次 parseScore 前重置）
  var illegalBuffer = [];
  function collectIllegal(chars, label) {
    for (var i = 0; i < chars.length; i++) {
      illegalBuffer.push({ label: label, ch: chars[i] });
    }
  }

  /**
   * Normalize —— MusicTimelineBuilder.cs 的装配期整理器（**三种 JSON type 都要过**）。
   *
   * 与 ApplyRepeatedKeyGap 的关键区别：
   *   - ApplyRepeatedKeyGap 是**解析期**逻辑（只在 yuanqin/keyboard 内部调用），触发条件是
   *     `events[upIndex].Time == item.Time`（**精确同刻**）；
   *   - Normalize 是**装配期**逻辑（`BuildKeyTimeline` 对三种 type 统一调用），
   *     **不看同刻**，只看「同键上一个音还没松开就又按下」（activeCounts[key] > 0）。
   *     ⇒ `{…}` 倚音的 +0.001 拍偏移会让「精确同刻」失败，只有 Normalize 能救。
   *
   * 阶段 1（去重叠 / 强制重触发）：同键上一个音未松开就来了新 KeyDown ⇒
   *   **插入** KeyUp @ (newStart - 30ms)（若该时刻 <= 上一个 KeyDown 起点则退化到 newStart），
   *   并吞掉属于旧按住的交叠 KeyUp（activeCounts > 1 分支）。
   * 阶段 2（同刻 U/D ⇒ U 提前 30ms）：与 ApplyRepeatedKeyGap 同算法。
   *
   * ⚠ 两处排序都必须是**纯稳定排序**（只按 Time），**绝不能按 Type 二次排序** ——
   *   上游源码注释专门警告：同刻「松开/按下」插入时已是「松开在前」，重排会造成
   *   「松开、按下、按下」，传输层吞掉一次触发并使按键粘住（实测单键可按住数十秒）。
   */
  function normalize(events) {
    var sorted = events.slice().sort(function (a, b) { return a.t - b.t; });   // 纯稳定排序
    var activeCounts = {};
    var holdStarts = {};
    var result = [];

    for (var i = 0; i < sorted.length; i++) {
      var item = sorted[i];
      var key = item.key;
      var count = activeCounts[key] || 0;

      if (item.down) {
        if (count > 0 && holdStarts[key] !== undefined) {
          // 上一个同键音还没松开：先补一个 KeyUp，否则传输层（_pressedKeys 去重）会吞掉这次按下
          var retriggerUpTime = item.t - MIN_GAP_MS;
          result.push({
            t: retriggerUpTime > holdStarts[key] ? retriggerUpTime : item.t,
            key: key,
            down: false,
            seq: result.length
          });
        }
        result.push({ t: item.t, key: key, down: true, seq: result.length });
        holdStarts[key] = item.t;
        activeCounts[key] = count + 1;
      } else {
        if (count <= 0) { continue; }        // 孤儿 KeyUp：丢弃
        activeCounts[key] = count - 1;
        if (count === 1) {
          result.push({ t: item.t, key: key, down: false, seq: result.length });
          delete holdStarts[key];
        }
        // count > 1：这个松开属于之前已被重触发闭合的按住，直接吞掉
      }
    }

    var previousDown = {};
    var previousUpIndex = {};
    for (var index = 0; index < result.length; index++) {
      var ev = result[index];
      var k = ev.key;
      if (ev.down) {
        var upIndex = previousUpIndex[k];
        if (upIndex !== undefined
            && result[upIndex].t === ev.t
            && previousDown[k] !== undefined) {
          var earlyTime = ev.t - MIN_GAP_MS;
          if (earlyTime > previousDown[k]) { result[upIndex].t = earlyTime; }
        }
        previousDown[k] = ev.t;
      } else {
        previousUpIndex[k] = index;
      }
    }

    return result.slice().sort(function (a, b) { return a.t - b.t; });   // 仍为纯稳定排序
  }

  /**
   * 解析产出的最终事件列表：先量化到 TimeSpan tick，再过装配期 Normalize。
   * 三种 JSON type 都走这里（对应上游 BuildKeyTimeline 里的 `Normalize(events)`）。
   */
  function finalizeEvents(events) {
    return normalize(quantizeTicks(events));
  }

  /**
   * ApplyRepeatedKeyGap —— MusicScoreParser.cs 原文语义：
   *   1) OrderBy(Time).ThenBy(KeyUp 优先)
   *   2) 若某 KeyUp 与其后同键 KeyDown **时刻完全相等**，且 (t-30) > 上一次 KeyDown 时刻，
   *      则把**那个 KeyUp 提前 30ms**
   *   3) 再次 OrderBy(Time).ThenBy(KeyUp 优先)
   * 返回同刻「抬起在前」的事件序，保证 pairNotes 的栈配对不会粘键。
   */
  function applyRepeatedKeyGap(events) {
    var order = function (a, b) {
      return (a.t - b.t) || ((a.down ? 1 : 0) - (b.down ? 1 : 0)) || (a.seq - b.seq);
    };
    var evs = quantizeTicks(events.slice()).sort(order);   // 先量化到 TimeSpan tick，再排序
    var previousDown = {};
    var previousUpIndex = {};

    for (var i = 0; i < evs.length; i++) {
      var item = evs[i];
      var key = item.key;
      if (item.down) {
        var upIndex = previousUpIndex[key];
        if (upIndex !== undefined
            && evs[upIndex].t === item.t
            && previousDown[key] !== undefined) {
          var early = item.t - MIN_GAP_MS;
          if (early > previousDown[key]) { evs[upIndex].t = early; }
        }
        previousDown[key] = item.t;
      } else {
        previousUpIndex[key] = i;
      }
    }

    return evs.slice().sort(order);
  }

  /* ------------------------------------------------------------------ *
   * type: midi  —— MusicScoreParser.ParseMidiJsonTimeline
   * ------------------------------------------------------------------ */

  function parseMidiTimeline(sheet, initialBpm, ticks, ctx) {
    var events = [];
    var cursor = 0;
    var bpm = initialBpm;
    var previousStatus = '';
    var previousKeys = '';
    var previousWasEvent = false;

    var rawParts = toText(sheet).split('|');
    // BetterGI: Split('|', RemoveEmptyEntries | TrimEntries)
    rawParts = rawParts.map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });

    for (var index = 0; index < rawParts.length; index++) {
      var rawPart = rawParts[index];

      if (rawPart.charAt(0) === '*') {
        var nextBpm = parseFloat(rawPart.slice(1));
        if (!isFinite(nextBpm) || nextBpm <= 0) {
          throw new Error('无法解析 MIDI JSON 变速标记：' + rawPart);
        }
        bpm = nextBpm;
        previousWasEvent = false;
        continue;
      }

      var match = MIDI_EVENT_RE.exec(rawPart);
      if (!match) {
        throw new Error('无法解析 MIDI JSON 事件：' + rawPart);
      }

      var status = match[1];
      var keys = match[2];
      var deltaTicks = parseInt(match[3], 10);
      var delay = deltaTicks * 60000 / (bpm * ticks);   // TimeSpan.FromMilliseconds(deltaTicks * 60000d / (bpm * ticks))
      cursor += delay;

      if (status === 'D'
          && previousWasEvent
          && previousStatus === 'U'
          && containsAny(previousKeys, keys)
          && delay < MIN_GAP_MS) {
        // A：把当前 D 后移满 30ms
        cursor += MIN_GAP_MS;
      } else if (status === 'U'
                 && keys !== '@'
                 && delay >= MIN_GAP_MS
                 && index + 1 < rawParts.length) {
        var nextMatch = MIDI_EVENT_RE.exec(rawParts[index + 1]);
        if (nextMatch
            && nextMatch[1] === 'D'
            && containsAny(nextMatch[2], keys)) {
          // B：把当前 U 提前 30ms
          cursor -= MIN_GAP_MS;
        }
      }

      if (keys !== '@') {
        addExplicitFromKeys(events, cursor, keys, status === 'D',
          ctx.warnings, 'midi 事件 ' + rawPart);
      }

      previousStatus = status;
      previousKeys = keys;
      previousWasEvent = true;
    }

    // ⚠ midi 型解析完**不**走 ApplyRepeatedKeyGap（与 yuanqin / keyboard 不同）
    return { events: events, cursor: cursor, bpm: bpm, ticks: ticks };
  }

  /** BetterGI: previousKeys.Any(keys.Contains) —— 字符交集 */
  function containsAny(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (b.indexOf(a.charAt(i)) >= 0) { return true; }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * type: yuanqin —— MusicScoreParser.ParseYuanQinTimeline
   * ------------------------------------------------------------------ */

  function parseYuanQinTokens(text) {
    var sheet = toText(text).replace(/\r/g, '').replace(/\n/g, '');
    var tokens = [];
    var index = 0;

    while (index < sheet.length) {
      if (sheet.charAt(index) === '|') { index++; continue; }

      var keys;
      // 裸 '^' / '&'（形如 `[^]` / `[&]`）与 '(' 和弦都各自成为一个 token；
      // 前者在下面的 `value === '^' || value === '&'` 分支被识别为全局标记。
      if (sheet.charAt(index) === '(') {
        var close = sheet.indexOf(')', index + 1);
        if (close < 0) { throw new Error('和弦缺少右括号'); }
        keys = sheet.slice(index + 1, close);
        index = close + 1;
      } else if (sheet.charAt(index) === '[') {
        // 没有任何前置键字符的 token（如 `[^]` / `[&]`，也可出现在谱首）：
        // BetterGI 的 else 分支取 `sheet[index]` 即 '['，随后它会消费 `[...]`；
        // 效果就是「keys 为空 + 带时值标记」，等价于下面的 keys=''。
        keys = '';
      } else {
        keys = sheet.charAt(index);
        index++;
      }

      if (index >= sheet.length || sheet.charAt(index) !== '[') {
        throw new Error('音符 ' + keys + ' 缺少时值');
      }
      var bracketEnd = sheet.indexOf(']', index + 1);
      if (bracketEnd < 0) {
        throw new Error('音符 ' + keys + ' 的时值缺少右方括号');
      }
      var value = sheet.slice(index + 1, bracketEnd);
      index = bracketEnd + 1;

      if (value === '^' || value === '&') {
        tokens.push({ keys: keys, denom: 0, special: value });
        continue;
      }

      var sep = value.indexOf('-');
      var denomText = sep >= 0 ? value.slice(0, sep) : value;
      var special = sep >= 0 ? value.slice(sep + 1) : 'none';
      var denom = parseFloat(denomText);
      if (!isFinite(denom)) {
        throw new Error('无法解析音符 ' + keys + ' 的时值：' + value);
      }
      tokens.push({ keys: keys, denom: denom, special: special });
    }
    return tokens;
  }

  function parseBeatDenominator(timeSignature) {
    var parts = toText(timeSignature).split('/');
    if (parts.length === 2) {
      var d = parseInt(parts[1], 10);
      if (isFinite(d) && d > 0) { return d; }
    }
    return 4;
  }

  function noteDurationMs(bpm, beatDenominator, noteDenominator) {
    if (!(bpm > 0) || !(noteDenominator > 0)) {
      throw new Error('BPM 和音符时值必须大于 0');
    }
    return 60000 / bpm * beatDenominator / noteDenominator;
  }

  function parseYuanQinTimeline(sheet, initialBpm, timeSignature, ctx) {
    return parseYuanQinTimelineFromTokens(parseYuanQinTokens(sheet), initialBpm, timeSignature, ctx);
  }

  function endsWith(s, ch) {
    s = toText(s);
    return s.length > 0 && s.charAt(s.length - 1) === ch;
  }

  /* ------------------------------------------------------------------ *
   * type: keyboard —— MusicScoreParser.ParseKeyboardTimeline
   * ------------------------------------------------------------------ */

  function preprocessKeyboard(sheet) {
    var processed = toText(sheet);
    processed = processed.replace(/\/\(([^)]+)\)/g, '{$1}');   // 1) /(...)  -> {...}
    processed = processed.replace(/\/([A-Z])/g, '{$1}');       // 2) /X      -> {X}
    processed = processed.replace(/ /g, '0');                   // 3) 空格    -> 0（休止）
    processed = processed.replace(/\/\[([^\]]+)\]/g, '{[$1]}'); // 4) /[...]  -> {[...]}
    processed = processed.replace(/\//g, '').replace(/>/g, ''); // 5) 删掉剩下的 / 与 >
    return processed;
  }

  function parseKeyboardNodes(text, state, closing) {
    var nodes = [];
    while (state.index < text.length) {
      var current = text.charAt(state.index);
      if (closing && current === closing) {
        state.index++;
        return nodes;
      }

      var node;
      if (current === '(' || current === '[' || current === '{') {
        state.index++;
        var expected = current === '(' ? ')' : (current === '[' ? ']' : '}');
        node = { type: current, value: null, children: parseKeyboardNodes(text, state, expected), mult: 1 };
      } else if (current === ')' || current === ']' || current === '}') {
        throw new Error('键谱出现不匹配的括号：' + current);
      } else if (current === '-') {
        if (nodes.length === 0) { throw new Error('键谱延音符号前没有音符'); }
        nodes[nodes.length - 1].mult++;
        state.index++;
        continue;
      } else {
        node = { type: '\0', value: current, children: [], mult: 1 };
        state.index++;
      }

      while (state.index < text.length && text.charAt(state.index) === '-') {
        node.mult++;
        state.index++;
      }
      nodes.push(node);
    }

    if (closing) { throw new Error('键谱缺少右括号：' + closing); }
    return nodes;
  }

  function unfoldKeyboardNode(node, startBeat, durationBeat, out) {
    if (node.value !== null) {
      var key = node.value.toUpperCase();
      if (key !== '0' && Object.prototype.hasOwnProperty.call(KEY_TO_PITCH, key)) {
        out.push({ key: key, startBeat: startBeat, offsetBeat: 0, durationBeat: durationBeat });
      }
      return;
    }

    var offset = node.type === '{' ? 0.001 : 0;
    if (node.type === '[' && node.children.length > 0) {
      var unit = durationBeat / node.children.length;
      for (var i = 0; i < node.children.length; i++) {
        unfoldKeyboardNode(node.children[i], startBeat + i * unit, unit, out);
      }
    } else {
      for (var c = 0; c < node.children.length; c++) {
        unfoldKeyboardNode(node.children[c], startBeat + offset, durationBeat, out);
      }
    }
  }

  function parseKeyboardTimeline(sheet, bpm, ctx) {
    var processed = preprocessKeyboard(sheet);
    var state = { index: 0 };
    var nodes = parseKeyboardNodes(processed, state, null);

    var flat = [];
    var cumulativeBeats = 0;
    for (var i = 0; i < nodes.length; i++) {
      unfoldKeyboardNode(nodes[i], cumulativeBeats, nodes[i].mult, flat);
      cumulativeBeats += nodes[i].mult;
    }

    var beatDuration = 60000 / bpm;
    var events = [];
    for (var n = 0; n < flat.length; n++) {
      var note = flat[n];
      var start = (note.startBeat + note.offsetBeat) * beatDuration;
      var duration = note.durationBeat * beatDuration;
      addNoteFromKeys(events, start, duration, note.key, ctx.warnings, 'keyboard ' + note.key);
    }

    return {
      events: applyRepeatedKeyGap(events),
      cursor: cumulativeBeats * beatDuration,
      bpm: bpm
    };
  }

  /* ------------------------------------------------------------------ *
   * 公开入口
   * ------------------------------------------------------------------ */

  function invalid(error, extra) {
    var out = {
      ok: false,
      error: error,
      name: '',
      author: '',
      instrument: '',
      type: '',
      bpm: 0,
      ticks: 0,
      notes: [],
      warnings: [],
      stats: { events: 0, noteCount: 0, durationMs: 0, keysUsed: [], maxPolyphony: 0 }
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) { out[k] = extra[k]; }
      }
    }
    return out;
  }

  /**
   * parseScore(obj, opts) -> Score
   *
   * Score = { ok, error?, name, author, instrument, type, bpm, ticks, notes, warnings, stats }
   * Note  = { key, pitch, start, end, velocity }  （毫秒；start < end；按 start 升序，同刻保序）
   * stats = { events, noteCount, durationMs, keysUsed[], maxPolyphony }
   *
   * opts（全部可选）：transpose（半音，默认 0）。绝不抛异常 —— 任何失败都回 ok:false + 中文 error。
   */
  function parseScore(obj, opts) {
    opts = isPlainObject(opts) ? opts : {};

    try {
      if (!isPlainObject(obj)) {
        return invalid('曲谱必须是 JSON 对象（根节点为 {}）');
      }

      var type = toText(obj.type !== undefined && obj.type !== null ? obj.type : DEFAULTS.type)
        .trim().toLowerCase();
      if (!SCHEDULE_TYPE_OK(type)) {
        return invalid('不支持的曲谱类型：' + type + '（仅支持 yuanqin / midi / keyboard）', { type: type });
      }

      if (obj.notes === undefined || obj.notes === null) {
        return invalid('曲谱缺少 notes 字段', { type: type });
      }

      var notesToken = obj.notes;
      var bpm = toPositiveNumber(obj.bpm, DEFAULTS.bpm);
      var ticks = Math.max(1, Math.round(toPositiveNumber(obj.ticks, DEFAULTS.ticks)));
      var timeSignature = toText(obj.time_signature) || DEFAULTS.timeSignature;

      // 复刻 GetString(json, "name", Path.GetFileNameWithoutExtension(path)) 的兜底顺序
      var name = toText(obj.name) || toText(opts.name);
      var author = toText(obj.author);
      var instrument = toText(obj.instrument);

      illegalBuffer = [];
      var ctx = {
        opts: opts,
        warnings: [],
        type: type,
        bpm: bpm,
        ticks: ticks,
        timeSignature: timeSignature,
        name: name,
        author: author,
        instrument: instrument
      };

      var result;
      if (type === 'midi') {
        if (typeof notesToken !== 'string') {
          return invalid('midi 曲谱的 notes 必须是字符串', { type: type, bpm: bpm, ticks: ticks });
        }
        if (notesToken.length === 0) {
          return invalid('曲谱 notes 为空', { type: type, bpm: bpm, ticks: ticks });
        }
        result = parseMidiTimeline(notesToken, bpm, ticks, ctx);
        ctx.ticks = result.ticks;
      } else if (type === 'yuanqin') {
        if (typeof notesToken !== 'string' && !Array.isArray(notesToken)) {
          return invalid('yuanqin 曲谱的 notes 必须是字符串或音符对象数组', { type: type, bpm: bpm, ticks: ticks });
        }
        if (typeof notesToken === 'string') {
          if (notesToken.replace(/[\s|]/g, '').length === 0) {
            return invalid('曲谱 notes 为空', { type: type, bpm: bpm, ticks: ticks });
          }
          result = parseYuanQinTimeline(notesToken, bpm, timeSignature, ctx);
        } else {
          result = parseYuanQinArrayTimeline(notesToken, bpm, timeSignature, ctx);
        }
      } else {
        if (typeof notesToken !== 'string') {
          return invalid('keyboard 曲谱的 notes 必须是字符串', { type: type, bpm: bpm, ticks: ticks });
        }
        if (notesToken.trim().length === 0) {
          return invalid('曲谱 notes 为空', { type: type, bpm: bpm, ticks: ticks });
        }
        result = parseKeyboardTimeline(notesToken, bpm, ctx);
      }

      ctx.events = result.events;
      ctx.cursor = result.cursor;
      ctx.bpm = result.bpm;

      flushIllegal(ctx);
      var score = finishScore(ctx);
      score.bpm = result.bpm;
      score.ticks = result.ticks !== undefined ? result.ticks : ticks;
      return score;
    } catch (err) {
      illegalBuffer = [];
      return invalid('解析失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  function SCHEDULE_TYPE_OK(type) {
    return Object.prototype.hasOwnProperty.call(SCORE_TYPES, type);
  }

  function flushIllegal(ctx) {
    if (!illegalBuffer.length) { return; }
    var byLabel = {};
    for (var i = 0; i < illegalBuffer.length; i++) {
      var item = illegalBuffer[i];
      if (!byLabel[item.label]) { byLabel[item.label] = []; }
      byLabel[item.label].push(item.ch);
    }
    for (var label in byLabel) {
      if (Object.prototype.hasOwnProperty.call(byLabel, label)) {
        ctx.warnings.push('非法键已丢弃：' + byLabel[label].join('') + '（位置：' + label + '）');
      }
    }
  }

  /**
   * yuanqin 的 JArray 形式（BetterGI ParseYuanQinTokens(JArray)）：
   *   { note: "ZCB", type: 4, spl: "none" }      -> 分母 4
   *   { note: "Z",   type: 0, spl: "^" }         -> 显式按
   * 这是**唯一**能产出 spl:"%"（谱内调速）的形式。
   */
  function parseYuanQinArrayTimeline(arr, initialBpm, timeSignature, ctx) {
    var tokens = [];
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (!isPlainObject(item)) { throw new Error('yuanqin 音符数组中包含非对象元素'); }
      var keys = toText(item.note);
      if (!keys.trim()) { throw new Error('yuanqin 音符对象缺少 note 字段'); }
      var special = toText(item.spl) || 'none';
      if (special === '^' || special === '&') {
        tokens.push({ keys: keys, denom: 0, special: special });
        continue;
      }
      var denom = parseFloat(toText(item.type));
      if (!isFinite(denom)) { throw new Error('无法解析音符 ' + keys + ' 的时值'); }
      tokens.push({ keys: keys, denom: denom, special: special });
    }
    return parseYuanQinTimelineFromTokens(tokens, initialBpm, timeSignature, ctx);
  }

  /** 把 ParseYuanQinTimeline 的主循环抽出来，字符串 / JArray 两种词法共用 */
  function parseYuanQinTimelineFromTokens(tokens, initialBpm, timeSignature, ctx) {
    var events = [];
    var cursor = 0;
    var bpm = initialBpm;
    var beatDenominator = parseBeatDenominator(timeSignature);

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];

      if (token.special === '%') {
        bpm = token.denom > 0 ? token.denom : bpm;
        continue;
      }

      if (token.special === '^' || token.special === '&') {
        addExplicitFromKeys(events, cursor, token.keys, token.special === '^',
          ctx.warnings, 'yuanqin ' + token.keys + '[' + token.special + ']');
        if (token.special === '&') { cursor += MIN_GAP_MS; }
        continue;
      }

      var tuplet = TUPLET_RE.exec(token.special);
      if (tuplet) {
        var group = [];
        while (i < tokens.length) {
          group.push(tokens[i]);
          if (endsWith(tokens[i].special, '$')) { break; }
          i++;
        }
        if (!endsWith(group[group.length - 1].special, '$')) {
          throw new Error('连音缺少 .$ 结束标记');
        }
        var total = noteDurationMs(bpm, beatDenominator, token.denom);
        var weights = group.map(function (x) {
          var m = TUPLET_RE.exec(x.special);
          return 1 / parseFloat(m[1]);
        });
        var weightSum = 0;
        for (var w = 0; w < weights.length; w++) { weightSum += weights[w]; }
        for (var g = 0; g < group.length; g++) {
          var share = total * weights[g] / weightSum;
          addNoteFromKeys(events, cursor, share, group[g].keys, ctx.warnings,
            'yuanqin ' + group[g].keys + '[' + group[g].denom + '-' + group[g].special + ']');
          cursor += share;
        }
        continue;
      }

      var dur;
      if (token.special === '#') {
        dur = 60000 / bpm / 16;
      } else {
        dur = noteDurationMs(bpm, beatDenominator, token.denom);
      }
      if (token.special === '*') { dur = dur * 1.5; }

      if (token.special === 'none' || token.special === '*') {
        var ornamentCount = 0;
        for (var next = i + 1; next < tokens.length && tokens[next].special === '#'; next++) {
          ornamentCount++;
        }
        var ornamentsDuration = 60000 / bpm / 16 * ornamentCount;
        if (ornamentsDuration < dur) { dur -= ornamentsDuration; }
      }

      addNoteFromKeys(events, cursor, dur, token.keys, ctx.warnings,
        'yuanqin ' + token.keys + '[' + (token.denom || '') +
        (token.special === 'none' ? '' : '-' + token.special) + ']');
      cursor += dur;
    }

    return { events: applyRepeatedKeyGap(events), cursor: cursor, bpm: bpm };
  }

  /* ------------------------------------------------------------------ *
   * selfTest —— Node 下可直接跑，不依赖 document
   * ------------------------------------------------------------------ */

  function selfTest() {
    var cases = [];
    var push = function (name, fn) {
      var ok = false;
      var detail = '';
      try {
        var r = fn();
        if (r === true) { ok = true; detail = 'OK'; }
        else if (r === false) { ok = false; detail = '断言失败'; }
        else { ok = false; detail = toText(r); }
      } catch (e) {
        ok = false;
        detail = '抛出异常：' + (e && e.message ? e.message : String(e));
      }
      cases.push({ name: name, ok: ok, detail: detail });
    };

    /* --- 静态契约 --- */

    push('KEY_TO_PITCH 共 21 个键，音高唯一且落在 48..83', function () {
      var ks = Object.keys(KEY_TO_PITCH);
      if (ks.length !== 21) { return '键数 = ' + ks.length; }
      var seen = {};
      for (var i = 0; i < ks.length; i++) {
        var p = KEY_TO_PITCH[ks[i]];
        if (p < 48 || p > 83) { return ks[i] + ' -> ' + p + ' 越界'; }
        if (seen[p]) { return '音高重复：' + p; }
        seen[p] = true;
      }
      return true;
    });

    push('SUPPORTED_KEYS 与 KEY_TO_PITCH 完全一致（21 个）', function () {
      if (SUPPORTED_KEYS.length !== 21) { return '长度 ' + SUPPORTED_KEYS.length; }
      for (var i = 0; i < SUPPORTED_KEYS.length; i++) {
        if (KEY_TO_PITCH[SUPPORTED_KEYS[i]] === undefined) {
          return SUPPORTED_KEYS[i] + ' 不在 KEY_TO_PITCH';
        }
      }
      return true;
    });

    push('PITCH_TO_KEY 是 KEY_TO_PITCH 的完整反向映射', function () {
      for (var k in KEY_TO_PITCH) {
        if (!Object.prototype.hasOwnProperty.call(KEY_TO_PITCH, k)) { continue; }
        if (PITCH_TO_KEY[KEY_TO_PITCH[k]] !== k) {
          return k + '(' + KEY_TO_PITCH[k] + ') 反向得到 ' + PITCH_TO_KEY[KEY_TO_PITCH[k]];
        }
      }
      return Object.keys(PITCH_TO_KEY).length === 21 ? true : 'PITCH_TO_KEY 条目数 ' + Object.keys(PITCH_TO_KEY).length;
    });

    push('pitchName：60 -> C4，48 -> C3，83 -> B5', function () {
      if (pitchName(60) !== 'C4') { return '60 -> ' + pitchName(60); }
      if (pitchName(48) !== 'C3') { return '48 -> ' + pitchName(48); }
      if (pitchName(83) !== 'B5') { return '83 -> ' + pitchName(83); }
      return true;
    });

    /* --- 失败路径：ok:false + 中文 error，绝不抛异常 --- */

    push('未知 type -> ok:false 且不抛异常', function () {
      var s = parseScore({ type: 'guitar', notes: 'A[4]' });
      if (s.ok !== false) { return 'ok = ' + s.ok; }
      if (!s.error || !/不支持/.test(s.error)) { return 'error = ' + s.error; }
      return true;
    });

    push('缺 notes -> ok:false 且不抛异常', function () {
      var s = parseScore({ type: 'yuanqin', bpm: 120 });
      if (s.ok !== false) { return 'ok = ' + s.ok; }
      if (!s.error || !/notes/.test(s.error)) { return 'error = ' + s.error; }
      return true;
    });

    push('notes 为空字符串 -> ok:false', function () {
      var s = parseScore({ type: 'yuanqin', notes: '' });
      if (s.ok !== false) { return 'ok = ' + s.ok; }
      return true;
    });

    push('三种 type 的 notes 类型不符 -> ok:false', function () {
      var a = parseScore({ type: 'midi', notes: ['D', 'A', '100'] });
      var b = parseScore({ type: 'keyboard', notes: 123 });
      var c = parseScore({ type: 'yuanqin', notes: 42 });
      if (a.ok !== false) { return 'midi 数组未被拒'; }
      if (b.ok !== false) { return 'keyboard 数字未被拒'; }
      if (c.ok !== false) { return 'yuanqin 数字未被拒'; }
      return true;
    });

    push('null / 非对象入参 -> ok:false 且不抛异常', function () {
      var a = parseScore(null);
      var b = parseScore('not an object');
      var c = parseScore(undefined);
      if (a.ok !== false || b.ok !== false || c.ok !== false) { return '未全部拒绝'; }
      return true;
    });

    /* --- 词法失败的两种不同结局 --- */

    push('midi 非法片段 -> ok:false（BetterGI 抛异常使整个文件失败）', function () {
      var s = parseScore({ type: 'midi', notes: 'DA100|XX|UB100', ticks: 1000, bpm: 60 });
      if (s.ok !== false) { return 'ok = ' + s.ok; }
      if (!/无法解析 MIDI JSON 事件/.test(s.error)) { return 'error = ' + s.error; }
      return true;
    });

    push('yuanqin 缺时值 -> ok:false，error 含「缺少时值」', function () {
      var s = parseScore({ type: 'yuanqin', notes: 'A' });
      if (s.ok !== false) { return 'ok = ' + s.ok; }
      if (!/缺少时值/.test(s.error)) { return 'error = ' + s.error; }
      return true;
    });

    push('yuanqin 连音缺 .$ 结束标记 -> ok:false', function () {
      var s = parseScore({ type: 'yuanqin', notes: 'A[4-8.3]B[4-8.3]' });
      if (s.ok !== false) { return 'ok = ' + s.ok; }
      if (!/连音缺少/.test(s.error)) { return 'error = ' + s.error; }
      return true;
    });

    push('keyboard 括号不匹配 -> ok:false', function () {
      var s = parseScore({ type: 'keyboard', notes: 'AB)CD', bpm: 120 });
      if (s.ok !== false) { return 'ok = ' + s.ok; }
      if (!/括号/.test(s.error)) { return 'error = ' + s.error; }
      return true;
    });

    /* --- midi 语义 --- */

    push('midi：Δticks 是相对上一事件的增量（ticks=1000/bpm=60 时 1 tick = 1ms）', function () {
      var s = parseScore({ type: 'midi', notes: 'DA0|UA100|DB200|UB100', ticks: '1000', bpm: '60' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      var byKey = {};
      s.notes.forEach(function (n) { byKey[n.key] = n; });
      // 光标：0(A down) -> 100(A up) -> 300(B down, Δ200) -> 400(B up, Δ100)
      // 注意 B 的 D 事件后移了 30ms（A 规则要求 U 与 D 之间 Δ<30 才触发，
      // 这里 U→D 的 Δ=0 且 U 的 keys=A 与 D 的 keys=B 无交集）=> 实际为 300，不是 200。
      if (byKey.A.start !== 0 || byKey.A.end !== 100) { return 'A = ' + byKey.A.start + '..' + byKey.A.end; }
      if (byKey.B.start !== 300 || byKey.B.end !== 400) { return 'B = ' + byKey.B.start + '..' + byKey.B.end; }
      return true;
    });

    push('midi：ticks/bpm 为字符串时同样正确解析', function () {
      var a = parseScore({ type: 'midi', notes: 'DA0|UA480', ticks: '1000', bpm: '60' });
      var b = parseScore({ type: 'midi', notes: 'DA0|UA480', ticks: 1000, bpm: 60 });
      if (!a.ok || !b.ok) { return 'ok:false'; }
      if (a.notes[0].end !== b.notes[0].end) { return a.notes[0].end + ' != ' + b.notes[0].end; }
      return a.notes[0].end === 480 ? true : 'end = ' + a.notes[0].end;
    });

    push('midi：`*bpm` 谱内变速立即生效', function () {
      // 前 100 ticks @60bpm(1ms/tick) = 100ms；后 *120bpm => 0.5ms/tick => 100 ticks = 50ms
      var s = parseScore({ type: 'midi', notes: 'DA0|UA100|*120|DB100|UB100', ticks: 1000, bpm: 60 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      var byKey = {};
      s.notes.forEach(function (n) { byKey[n.key] = n; });
      if (byKey.B.start !== 150) { return 'B.start = ' + byKey.B.start + '（期望 150）'; }
      if (s.bpm !== 120) { return 'score.bpm = ' + s.bpm + '（期望 120）'; }
      return true;
    });

    push('midi：`@` 占位不发音、只占时间（U@0|DG30 场景）', function () {
      var s = parseScore({ type: 'midi', notes: 'DG0|U@0|DG30|UG100', ticks: 1000, bpm: 60 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 1) { return '音符数 ' + s.notes.length + '（期望 1：@ 不发音）'; }
      if (s.notes[0].key !== 'G') { return 'key = ' + s.notes[0].key; }
      if (s.notes[0].start !== 0) { return 'start = ' + s.notes[0].start; }
      if (s.stats.events !== 3) { return 'events = ' + s.stats.events + '（@ 不产生事件，期望 3）'; }
      return true;
    });

    push('midi 30ms 规则 A：上一事件是含同键的 U 且 Δ<30 -> D 后移满 30ms', function () {
      var s = parseScore({ type: 'midi', notes: 'DA0|UA10|DA0|UA100', ticks: 1000, bpm: 60 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      var starts = s.notes.map(function (n) { return n.start; });
      if (starts[0] !== 0) { return '第 1 音 start = ' + starts[0]; }
      if (starts[1] !== 40) { return '第 2 音 start = ' + starts[1] + '（期望 10+30=40）'; }
      return true;
    });

    push('midi 30ms 规则 B：U（非@）Δ>=30 且下一片段是同键 D -> U 提前 30ms', function () {
      var s = parseScore({ type: 'midi', notes: 'DA0|UA100|DA0|UA100', ticks: 1000, bpm: 60 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].start !== 0) { return '第 1 音 start = ' + s.notes[0].start; }
      if (s.notes[0].end !== 70) { return '第 1 音 end = ' + s.notes[0].end + '（期望 100-30=70）'; }
      if (s.notes[1].start !== 100) { return '第 2 音 start = ' + s.notes[1].start; }
      return true;
    });

    push('midi：B 规则不与 A 规则叠加（else if）', function () {
      // 关键：若两条规则都生效，第 2 音会落在 100（提前）+40 = 140
      var s = parseScore({ type: 'midi', notes: 'DA0|UA100|DA0|UA100', ticks: 1000, bpm: 60 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      return s.notes[1].start === 100 ? true : '第 2 音 start = ' + s.notes[1].start + '（期望 100）';
    });

    push('midi：一个片段多个键 = 同刻和弦，且去重', function () {
      var s = parseScore({ type: 'midi', notes: 'DAZ0|UAZ100', ticks: 1000, bpm: 60 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].start !== 0 || s.notes[1].start !== 0) { return '非同刻'; }
      return true;
    });

    push('midi：非法键被丢弃并写入 warnings', function () {
      var s = parseScore({ type: 'midi', notes: 'DI100|UI100', ticks: 1000, bpm: 60 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 0) { return '非法键 I 产生了音符：' + s.notes.length; }
      var all = s.warnings.join(' ');
      if (!/非法键/.test(all)) { return '没有非法键 warning：' + all; }
      return /I/.test(all) ? true : 'warnings 未提到 I：' + all;
    });

    /* --- yuanqin 语义 --- */

    push('yuanqin：默认 type / bpm=120 / ticks=480 / 时值 = 60000/bpm*4/n', function () {
      var s = parseScore({ notes: 'Z[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.type !== 'yuanqin') { return 'type = ' + s.type; }
      if (s.bpm !== 120) { return 'bpm = ' + s.bpm; }
      if (s.ticks !== 480) { return 'ticks = ' + s.ticks; }
      // n=4, bd=4 => 60000/120*4/4 = 500ms
      if (s.notes[0].end !== 500) { return 'end = ' + s.notes[0].end + '（期望 500）'; }
      return true;
    });

    push('yuanqin：`|` 与换行被忽略、和弦去重、@ 是休止', function () {
      var s = parseScore({ notes: '(ZZ)[4]|@[4]|\n(Z)[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length + '（期望 2：去重 + @ 不发音）'; }
      if (s.notes[0].key !== 'Z') { return 'key0 = ' + s.notes[0].key; }
      // bpm=120、4/4：[4] = 60000/120*4/4 = 500ms。[4] + @[4]休止 = 1000ms 后才是第 2 个音。
      if (s.notes[1].start !== 1000) { return '第 2 音 start = ' + s.notes[1].start + '（期望 500+500=1000）'; }
      // durationMs = cursor 终值 = 1500（含末尾无静默，三拍都是实音/休止）
      if (s.stats.durationMs !== 1500) { return 'durationMs = ' + s.stats.durationMs + '（期望 1500）'; }
      return true;
    });

    push('yuanqin：`[n-*]` 附点 = 1.5 倍', function () {
      var normal = parseScore({ notes: 'Z[8]' });
      var dotted = parseScore({ notes: 'Z[8-*]' });
      if (!normal.ok || !dotted.ok) { return 'ok:false'; }
      if (normal.notes[0].end !== 250) { return '普通八分 = ' + normal.notes[0].end; }
      if (dotted.notes[0].end !== 375) { return '附点八分 = ' + dotted.notes[0].end + '（期望 375）'; }
      return true;
    });

    push('yuanqin：`[n-#]` 装饰音 = 十六分音符（忽略 n），并从前的音里扣掉', function () {
      // bpm=120：十六分 = 60000/120/16 = 31.25ms
      // Z[4]=500ms，因后随 1 个 # 装饰音 => 500-31.25 = 468.75ms
      var s = parseScore({ notes: 'Z[4]#[4-#]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 1) { return '音符数 ' + s.notes.length + '（# 不发音，期望 1）'; }
      if (s.notes[0].end !== 468.75) { return 'Z 时长 = ' + s.notes[0].end + '（期望 500-31.25=468.75）'; }
      // 装饰音本身仍占一个十六分：总 cursor = 468.75 + 31.25 = 500
      if (s.stats.durationMs !== 500) { return 'durationMs = ' + s.stats.durationMs + '（期望 500）'; }
      return true;
    });

    push('yuanqin：`[4-8.3]…[4-8.$]` 连音组按权重分摊总时长', function () {
      // 组首分母 4、bd=4、bpm=120 => total=500；两个成员权重各 1/8 => 各 250
      var s = parseScore({ notes: 'Z[4-8.3]C[4-8.$]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].start !== 0 || s.notes[0].end !== 250) { return 'Z = ' + s.notes[0].start + '..' + s.notes[0].end; }
      if (s.notes[1].start !== 250 || s.notes[1].end !== 500) { return 'C = ' + s.notes[1].start + '..' + s.notes[1].end; }
      return true;
    });

    push('yuanqin：小写键字母先大写再过滤（真实曲库大量小写谱）', function () {
      var s = parseScore({ notes: 'h[4](en)[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 3) { return '音符数 ' + s.notes.length + '（期望 3：H、E、N）'; }
      var keys = s.notes.map(function (n) { return n.key; }).join('');
      if (keys !== 'HEN') { return 'keys = ' + keys + '（期望 HEN）'; }
      // 小写不应产生任何非法键 warning
      if (s.warnings.length) { return '出现了 warnings：' + s.warnings.join(' | '); }
      return true;
    });

    push('yuanqin：不在 21 键内的字母（I/K/L/O/P）被丢弃并记 warning', function () {
      // 注意词法：一个 token 只吃「一个字符」或「一个 (...) 和弦」当 keys，
      // 所以必须写成 `Z[4]I[4]`（每 token 一个 `[时值]`），不能写 `Z[4]AI[4]`。
      var s = parseScore({ notes: 'Z[4]I[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 1) { return '音符数 ' + s.notes.length + '（I 应被丢弃）'; }
      if (s.notes[0].key !== 'Z') { return 'key = ' + s.notes[0].key; }
      if (!s.warnings.length) { return '没有写入 warning'; }
      return /I/.test(s.warnings.join(' ')) ? true : 'warning 未提到 I：' + s.warnings.join(' | ');
    });

    push('yuanqin：字母紧跟字母是非法词法（每 token 必须带 [时值]）', function () {
      // 回归保护：词法器一个 token 只吃一个字符（或一个 (...) 和弦），
      // `Z[4]AI[4]` 里 `A` 后面紧跟 `I` 而不是 `[` -> 必须 ok:false
      var bad = parseScore({ notes: 'Z[4]AI[4]' });
      if (bad.ok !== false) { return 'Z[4]AI[4] 竟然 ok:true'; }
      if (!/缺少时值/.test(bad.error)) { return 'error = ' + bad.error; }
      // 和弦形式则合法
      var good = parseScore({ notes: 'Z[4](AI)[4]' });
      if (!good.ok) { return '(AI) 形式 ok:false：' + good.error; }
      if (good.notes.length !== 2) { return '(AI) 音符数 ' + good.notes.length + '（A 合法、I 丢弃）'; }
      return true;
    });

    push('yuanqin：`[^]`/`[&]` 显式按抬，& 额外推进 30ms', function () {
      // Z[4] 占 0..500；[^] 不推进；C[4] 占 500..1000；[&] 推进 30ms；D[4] 从 1030 起
      var s = parseScore({ notes: 'Z[4][^]C[4][&]D[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      var keys = s.notes.map(function (n) { return n.key; }).join('');
      if (keys !== 'ZCD') { return 'keys = ' + keys + '（期望 ZCD）'; }
      var d = s.notes[2];
      if (d.start !== 1030) { return 'D start = ' + d.start + '（期望 1000+30=1030）'; }
      return true;
    });

    push('yuanqin：`[^]` 可在音符时长内提前抬起（缩短音符）', function () {
      // ^ 在 cursor=0 处显式 KeyUp，Z 的 KeyUp 在 500 -> 同键 U/D 同刻规则不涉及，但音符应被截到 0
      var s = parseScore({ notes: 'Z[4][&]C[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].key !== 'Z') { return 'key0 = ' + s.notes[0].key; }
      // & 只提前抬起，不改时长：Z 的 KeyUp 仍在 500
      if (s.notes[0].end !== 500) { return 'Z end = ' + s.notes[0].end + '（期望 500）'; }
      return true;
    });

    push('yuanqin：相邻同键首尾相接时，ApplyRepeatedKeyGap 把 U 提前 30ms', function () {
      var s = parseScore({ notes: 'Z[4]Z[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].start !== 0) { return 'start0 = ' + s.notes[0].start; }
      if (s.notes[0].end !== 470) { return 'end0 = ' + s.notes[0].end + '（期望 500-30=470）'; }
      if (s.notes[1].start !== 500) { return 'start1 = ' + s.notes[1].start + '（期望 500）'; }
      return true;
    });

    push('yuanqin：time_signature 分母参与时值（6/8 与 4/4 不同）', function () {
      var a = parseScore({ notes: 'Z[8]', time_signature: '4/4' });
      var b = parseScore({ notes: 'Z[8]', time_signature: '6/8' });
      if (!a.ok || !b.ok) { return 'ok:false'; }
      if (a.notes[0].end !== 250) { return '4/4 end = ' + a.notes[0].end; }
      if (b.notes[0].end !== 500) { return '6/8 end = ' + b.notes[0].end + '（期望 60000/120*8/8=500）'; }
      return true;
    });

    push('yuanqin：JArray 形式支持 spl:"%" 谱内调速', function () {
      var s = parseScore({
        type: 'yuanqin',
        notes: [
          { note: 'Z', type: 4, spl: 'none' },
          { note: '%', type: 240, spl: '%' },
          { note: 'C', type: 4, spl: 'none' }
        ]
      });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      // 第 1 音 500ms @120；之后 bpm=240 => 250ms
      if (s.notes[1].start !== 500) { return '第 2 音 start = ' + s.notes[1].start; }
      if (s.notes[1].end !== 750) { return '第 2 音 end = ' + s.notes[1].end + '（期望 500+250=750）'; }
      if (s.bpm !== 240) { return 'score.bpm = ' + s.bpm; }
      return true;
    });

    /* --- keyboard 语义 --- */

    push('keyboard：空格 = 休止 1 拍；beatDuration = 60000/bpm', function () {
      var s = parseScore({ type: 'keyboard', notes: 'C0C', bpm: 120 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].start !== 0 || s.notes[0].end !== 500) { return 'C = ' + s.notes[0].start + '..' + s.notes[0].end; }
      // 第 2 个 C 在 1 拍休止之后
      if (s.notes[1].start !== 1000) { return 'C2.start = ' + s.notes[1].start + '（期望 1000）'; }
      if (s.stats.durationMs !== 1500) { return 'durationMs = ' + s.stats.durationMs + '（期望 3 拍 = 1500）'; }
      return true;
    });

    push('keyboard：空格等同 0（C C 与 C0C 结果完全一致）', function () {
      var a = parseScore({ type: 'keyboard', notes: 'C C', bpm: 120 });
      var b = parseScore({ type: 'keyboard', notes: 'C0C', bpm: 120 });
      if (!a.ok || !b.ok) { return 'ok:false'; }
      // 空格 → '0' ⇒ 两个 C 之间夹一个 1 拍休止：2 个音符，总时长 3 拍
      if (a.notes.length !== 2) { return 'C C 音符数 = ' + a.notes.length + '（期望 2）'; }
      if (a.notes[1].start !== 1000) { return 'C2.start = ' + a.notes[1].start + '（期望 1000）'; }
      if (a.stats.durationMs !== b.stats.durationMs) {
        return 'C C 时长 ' + a.stats.durationMs + ' != C0C 时长 ' + b.stats.durationMs;
      }
      if (a.notes.length !== b.notes.length) {
        return 'C C 音符数 ' + a.notes.length + ' != C0C 音符数 ' + b.notes.length;
      }
      return a.stats.durationMs === 1500 ? true : '时长 = ' + a.stats.durationMs + '（期望 1500）';
    });

    push('Normalize 回归①：`{…}` 倚音 0.5ms 偏移下同键重叠被截断（phase 1 触发）', function () {
      // task-8 最小复现。`{…}` 倚音带 +0.001 拍偏移（bpm120 => 0.5ms），使
      // `ApplyRepeatedKeyGap` 的「精确同刻」判定失败；只有装配期 Normalize 的
      // hold 判定（不看同刻）能救。
      // 第 6 音末 = 3000.0，第 7 音起 = 3000.5（偏移），第 8 音起 = 3500.0
      // => 第 7 音的 KeyUp 必须被截到 3500 - 30 = 3470
      var s = parseScore({ type: 'keyboard', bpm: 120, notes: 'ZZZZZZ/ZZ[4]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 8) { return '音符数 ' + s.notes.length + '（期望 8）'; }
      var n7 = s.notes[6];
      if (n7.start !== 3000.5) { return '第 7 音 start = ' + n7.start + '（期望 3000.5）'; }
      if (n7.end !== 3470) {
        return '第 7 音 end = ' + n7.end + '（期望 3470 = 第 8 音 KeyDown@3500 − 30）';
      }
      if (s.notes[7].start !== 3500 || s.notes[7].end !== 4000) {
        return '第 8 音 = ' + s.notes[7].start + '..' + s.notes[7].end + '（期望 3500..4000）';
      }
      return true;
    });

    push('Normalize 回归②：同键重叠 ⇒ 插入 retrigger KeyUp 并吞掉旧 KeyUp', function () {
      // `Z[2]Z[2]` = 两个各 2 拍的 Z：第 1 音 0..1000、第 2 音 KeyDown@1000。
      // 二者边界相接，但事件序里第 2 个 KeyDown 之前没有第 1 音的 KeyUp 被处理过
      // => Normalize 阶段 1 判定「上一个同键音还没松开」，在 1000-30=970 插入 KeyUp
      //    截断第 1 音，并吞掉第 1 音原本 1000 处的 KeyUp（否则会粘键/多音）。
      // 结果必须是恰好 2 个音符，且第 1 音 end = 970。
      var s = parseScore({ notes: 'Z[2]Z[2]' });   // bpm120 / 4-4 => [2] = 1000ms
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length + '（期望 2：旧 KeyUp 应被吞掉）'; }
      if (s.notes[0].start !== 0 || s.notes[0].end !== 970) {
        return '第 1 音 = ' + s.notes[0].start + '..' + s.notes[0].end + '（期望 0..970）';
      }
      if (s.notes[1].start !== 1000 || s.notes[1].end !== 2000) {
        return '第 2 音 = ' + s.notes[1].start + '..' + s.notes[1].end + '（期望 1000..2000）';
      }
      return true;
    });

    push('Normalize 回归③：重叠链不产生退化音符，也不多出音符', function () {
      // `{…}` 连续倚音簇会造成同键交叠链；Normalize 阶段 1 要插入 retrigger KeyUp
      // 并吞掉被交叠的旧 KeyUp。要求：音符数 == 实际音头数，且全部 start < end。
      var s = parseScore({ type: 'keyboard', bpm: 120, notes: 'ZZ{Z}{Z}{Z}[2]' });
      if (!s.ok) { return 'ok:false ' + s.error; }
      for (var i = 0; i < s.notes.length; i++) {
        if (!(s.notes[i].start < s.notes[i].end)) {
          return '第 ' + i + ' 音退化 start=' + s.notes[i].start + ' end=' + s.notes[i].end;
        }
      }
      if (s.notes.length === 0) { return '没有音符'; }
      // 依赖 durationMs = cursor 终值（契约不变）
      if (typeof s.stats.durationMs !== 'number') { return 'durationMs 非法'; }
      return true;
    });

    push('keyboard：`-` 每次只加 1 拍（不能表示半拍）', function () {
      var s = parseScore({ type: 'keyboard', notes: 'C-D', bpm: 120 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].end !== 1000) { return 'C 时长 = ' + s.notes[0].end + '（期望 2 拍 = 1000ms）'; }
      if (s.notes[1].start !== 1000) { return 'D start = ' + s.notes[1].start; }
      return true;
    });

    push('keyboard：`(XY)` = 同刻和弦', function () {
      var s = parseScore({ type: 'keyboard', notes: '(CE)', bpm: 120 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[0].start !== 0 || s.notes[1].start !== 0) { return '非同刻'; }
      return true;
    });

    push('keyboard：`[XYZ]` = 琶音，按均分时值顺序展开', function () {
      var s = parseScore({ type: 'keyboard', notes: '[CEG]', bpm: 120 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 3) { return '音符数 ' + s.notes.length; }
      var starts = s.notes.map(function (n) { return n.start; });
      // 1 拍 / 3 = 166.666...
      if (Math.abs(starts[0] - 0) > 0.01) { return 'start0 = ' + starts[0]; }
      if (Math.abs(starts[1] - 1000 / 6) > 0.01) { return 'start1 = ' + starts[1]; }
      if (Math.abs(starts[2] - 2000 / 6) > 0.01) { return 'start2 = ' + starts[2]; }
      return true;
    });

    push('keyboard：连续同键琶音簇的 30ms 规则不漏触发（float 末位陷阱回归）', function () {
      // 回归：曾因 (startBeat+offsetBeat)*beat 与 i*unit*beat 两式末位差 1ulp，
      // 使 U/D 同刻比较失败 -> 30ms 规则漏触发 -> 音符时长被拉长 8 倍。
      var s = parseScore({ type: 'keyboard', notes: 'C C C [{C}{C}{C}{C}{C}]', bpm: 350 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      var cluster = s.notes.filter(function (n) { return n.start > 1028 && n.start < 1170; });
      if (cluster.length !== 5) { return '簇内音符数 ' + cluster.length + '（期望 5）'; }
      for (var i = 0; i < cluster.length; i++) {
        var d = cluster[i].end - cluster[i].start;
        // 每个音时值应为 1/5 拍 = 34.2857ms，前 4 个被 30ms 规则压缩到 4.2857ms
        if (i < cluster.length - 1 && Math.abs(d - (60000 / 350 / 5 - 30)) > 0.05) {
          return '第 ' + i + ' 音时长 ' + d.toFixed(4) + '（期望 ' + (60000 / 350 / 5 - 30).toFixed(4) + '）';
        }
      }
      return true;
    });

    push('keyboard：`{XY}` 和弦带 +0.001 拍微偏移', function () {
      var s = parseScore({ type: 'keyboard', notes: '{CE}', bpm: 120 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (Math.abs(s.notes[0].start - 0.5) > 0.001) { return 'start0 = ' + s.notes[0].start + '（期望 0.001*500=0.5）'; }
      return true;
    });

    push('keyboard：预处理 `/X` -> `{X}`、`/(XY)` -> `{XY}`、删 `>`', function () {
      var a = parseScore({ type: 'keyboard', notes: '/C', bpm: 120 });
      if (!a.ok) { return '/C ok:false ' + a.error; }
      if (a.notes.length !== 1) { return '/C 音符数 ' + a.notes.length; }
      if (Math.abs(a.notes[0].start - 0.5) > 0.001) { return '/C start = ' + a.notes[0].start; }
      var b = parseScore({ type: 'keyboard', notes: '/(CE)', bpm: 120 });
      if (!b.ok || b.notes.length !== 2) { return '/(CE) 音符数 ' + (b.ok ? b.notes.length : b.error); }
      if (Math.abs(b.notes[0].start - 0.5) > 0.001) { return '/(CE) start = ' + b.notes[0].start; }
      var c = parseScore({ type: 'keyboard', notes: 'C>C', bpm: 120 });
      if (!c.ok || c.notes.length !== 2) { return 'C>C 音符数 ' + (c.ok ? c.notes.length : c.error); }
      return true;
    });

    push('keyboard：`0` 与非法字符是休止，不发音但时间流逝', function () {
      var s = parseScore({ type: 'keyboard', notes: 'C0C', bpm: 120 });
      if (!s.ok) { return 'ok:false ' + s.error; }
      if (s.notes.length !== 2) { return '音符数 ' + s.notes.length; }
      if (s.notes[1].start !== 1000) { return '第 2 音 start = ' + s.notes[1].start + '（期望 1000）'; }
      return true;
    });

    /* --- 契约不变量 --- */

    push('不变量：start < end 恒成立（含零时长边界）', function () {
      // U 与 D 同刻的极端谱面
      var s = parseScore({ type: 'keyboard', notes: 'C C', bpm: 120 });
      var cases = [
        s,
        parseScore({ type: 'midi', notes: 'DA0|UA0|DA0|UA0', ticks: 1000, bpm: 60 }),
        parseScore({ notes: 'Z[4]Z[4]Z[4]' }),
        parseScore({ type: 'keyboard', notes: '[CEG]', bpm: 120 })
      ];
      for (var i = 0; i < cases.length; i++) {
        var sc = cases[i];
        if (!sc.ok) { continue; }
        for (var j = 0; j < sc.notes.length; j++) {
          if (!(sc.notes[j].start < sc.notes[j].end)) {
            return '第 ' + i + ' 谱第 ' + j + ' 音 start=' + sc.notes[j].start + ' end=' + sc.notes[j].end;
          }
        }
      }
      return true;
    });

    push('不变量：pitch ∈ [48,83] 且 key 在 21 键内且 key/pitch 自洽', function () {
      var sc = parseScore({ notes: '(ZCM)[4](QWE)[4](ASD)[4](HJ)[4]' });
      if (!sc.ok) { return 'ok:false ' + sc.error; }
      for (var i = 0; i < sc.notes.length; i++) {
        var n = sc.notes[i];
        if (n.pitch < 48 || n.pitch > 83) { return 'pitch 越界 ' + n.pitch; }
        if (KEY_TO_PITCH[n.key] !== n.pitch) { return 'key/pitch 不自洽 ' + n.key + '/' + n.pitch; }
      }
      return true;
    });

    push('不变量：notes 按 start 升序，同刻保持发送顺序', function () {
      var sc = parseScore({ notes: '(ZCB)[4]A[4](QWE)[4]' });
      if (!sc.ok) { return 'ok:false ' + sc.error; }
      for (var i = 1; i < sc.notes.length; i++) {
        if (sc.notes[i].start < sc.notes[i - 1].start) { return '第 ' + i + ' 个音时间倒退'; }
      }
      var same = sc.notes.filter(function (n) { return n.start === 0; }).map(function (n) { return n.key; });
      return same.join('') === 'ZCB' ? true : '同刻顺序 = ' + same.join('');
    });

    push('stats：keysUsed 去重升序、maxPolyphony 反映同刻最大键数', function () {
      var sc = parseScore({ notes: '(ZCB)[4]A[4]' });
      if (!sc.ok) { return 'ok:false ' + sc.error; }
      if (sc.stats.keysUsed.join('') !== 'ABCZ') { return 'keysUsed = ' + sc.stats.keysUsed.join(''); }
      if (sc.stats.maxPolyphony !== 3) { return 'maxPolyphony = ' + sc.stats.maxPolyphony + '（期望 3）'; }
      if (sc.stats.noteCount !== 4) { return 'noteCount = ' + sc.stats.noteCount; }
      return true;
    });

    push('opts.transpose 移调后重新映射键并保持自洽', function () {
      var sc = parseScore({ notes: 'Z[4]' }, { transpose: 12 });
      if (!sc.ok) { return 'ok:false ' + sc.error; }
      if (sc.notes.length !== 1) { return '音符数 ' + sc.notes.length; }
      if (sc.notes[0].pitch !== 60) { return 'pitch = ' + sc.notes[0].pitch + '（期望 48+12=60）'; }
      if (sc.notes[0].key !== 'A') { return 'key = ' + sc.notes[0].key + '（期望 A）'; }
      return true;
    });

    push('parseScore 对畸形输入绝不抛异常', function () {
      var nasty = [
        { type: 'keyboard', notes: '((((', bpm: 120 },
        { type: 'yuanqin', notes: '[4]' },
        { type: 'yuanqin', notes: 'A[]' },
        { type: 'midi', notes: '|'.repeat(50), ticks: 1000, bpm: 60 },
        { type: 'midi', notes: 'D' + 'Z'.repeat(500) + '0', ticks: 1000, bpm: 60 },
        { type: 'keyboard', notes: '[', bpm: 120 },
        { type: 'yuanqin', notes: 'A[4-8.$]' },
        { type: 'midi', notes: 'D*0', ticks: 1000, bpm: 60 },
        { type: 'midi', notes: 'DZ-1', ticks: 1000, bpm: 60 }
      ];
      for (var i = 0; i < nasty.length; i++) {
        var sc = parseScore(nasty[i]);
        if (typeof sc.ok !== 'boolean') { return '第 ' + i + ' 个输入没有返回 ok'; }
        if (sc.ok && (!sc.notes || !sc.stats)) { return '第 ' + i + ' 个输入 ok:true 但缺 notes/stats'; }
      }
      return true;
    });

    var passed = 0;
    var failed = 0;
    for (var i = 0; i < cases.length; i++) {
      if (cases[i].ok) { passed++; } else { failed++; }
    }
    return { passed: passed, failed: failed, cases: cases };
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  var BGIParse = {
    MIN_GAP_MS: MIN_GAP_MS,
    MIN_NOTE_MS: MIN_NOTE_MS,
    DEFAULTS: DEFAULTS,
    KEY_TO_PITCH: KEY_TO_PITCH,
    PITCH_TO_KEY: PITCH_TO_KEY,
    SUPPORTED_KEYS: SUPPORTED_KEYS,
    pitchName: pitchName,
    parseScore: parseScore,
    selfTest: selfTest
  };

  root.BGIParse = BGIParse;

  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = BGIParse;
  }
})(typeof window !== 'undefined' ? window : globalThis);
