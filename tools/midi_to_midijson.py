#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MIDI(.mid) -> BetterGI `type:"midi"` JSON 转换器
================================================
为什么需要它：BetterGI 风物之诗琴只有 21 键，且是**纯 C 大调音阶**
（源码 InstrumentProfileService.StandardMappings）：
    Z=48 X=50 C=52 V=53 B=55 N=57 M=59 / A=60 S=62 D=64 F=65 G=67 H=69 J=71
    Q=72 W=74 E=76 R=77 T=79 Y=81 U=83
解析 MIDI 时 TryGetKey 的 MelodicOctaveFold **只按八度折叠(±12)，不吸附半音**，
因此 5 个升号音(C#/D#/F#/G#/A#)永远映射失败、被静默丢弃 —— 这就是「超出音韵/播不出来」。

本脚本做的事：
  1. 自带 SMF 解析（MThd/MTrk、running status、tempo map、note on/off），不依赖第三方库
  2. 三种映射模式：
       snap （默认）八度折叠进 48..83 后，把半音吸附到相邻音阶音 -> 可演奏率 100%
       drop        复刻 BetterGI 原行为（丢音），仅用于对照
       raw         只折叠不吸附（保真，但可演奏率仍 <100%）
     半音吸附方向：默认看该音前后 ±1s 内哪个相邻音阶音出现得多就吸过去，平票则向上吸
  3. 输出 `type:"midi"` 事件流：ticks=1000 & bpm=60 -> **1 tick = 1 ms**，零漂移
  4. 校验：用 Python 复刻的 ParseMidiJsonTimeline 重放结果，事件数与时长必须对得上
用法：
    python midi_to_midijson.py                 # 全部转换（snap 模式）
    python midi_to_midijson.py --mode drop     # 只看原行为
    python midi_to_midijson.py --transpose 12  # 整体升八度
"""
import os, sys, re, json, csv, struct, collections, argparse

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE) if os.path.basename(_HERE) == "tools" else _HERE
REPORTS = os.path.join(ROOT, "reports")
def _pick(*ps):
    for p in ps:
        if os.path.isdir(p):
            return p
    return ps[0]


ARCH = os.path.join(ROOT, "archive", "中间产物")
LIB = _pick(os.path.join(ARCH, "去重后曲库"), os.path.join(ROOT, "去重后曲库"))
OUT = _pick(os.path.join(ARCH, "8_MIDI转换_MidiJson"), os.path.join(ROOT, "8_MIDI转换_MidiJson"))

# BetterGI 风物之诗琴 21 键映射（键 -> MIDI 音高）
KEYMAP = {48: "Z", 50: "X", 52: "C", 53: "V", 55: "B", 57: "N", 59: "M",
          60: "A", 62: "S", 64: "D", 65: "F", 67: "G", 69: "H", 71: "J",
          72: "Q", 74: "W", 76: "E", 77: "R", 79: "T", 81: "Y", 83: "U"}
LO, HI = min(KEYMAP), max(KEYMAP)
SCALE = {0, 2, 4, 5, 7, 9, 11}          # C 大调音级
TAG = "（Hermes）"                        # 我方产物标签：只标归属，不塞产物类型信息
JSON_TICKS, JSON_BPM = 1000, 60         # => 1 tick = 1 ms
MIN_NOTE_MS = 30                        # 与 BetterGI LowestLatencyMilliseconds 对齐
_PART_RE = re.compile(r"^([DU])([A-Z@]+)(\d+)$")


# ---------------- 最小 SMF 解析器 ----------------
def _vlq(b, i):
    v = 0
    while True:
        c = b[i]; i += 1; v = (v << 7) | (c & 0x7F)
        if not c & 0x80:
            return v, i


def parse_smf(path):
    d = open(path, "rb").read()
    if d[:4] != b"MThd":
        raise ValueError("不是标准 MIDI 文件")
    hlen = struct.unpack(">I", d[4:8])[0]
    fmt, ntrks, div = struct.unpack(">HHH", d[8:14])
    if div & 0x8000:
        raise ValueError("SMPTE 时间基准，未支持")
    i = 8 + hlen
    tracks = []
    for _ in range(ntrks):
        if d[i:i + 4] != b"MTrk":
            raise ValueError("轨道头损坏")
        tl = struct.unpack(">I", d[i + 4:i + 8])[0]; i += 8
        end, t, run, ev = i + tl, 0, None, []
        while i < end:
            dt, i = _vlq(d, i); t += dt
            b = d[i]
            if b == 0xFF:
                i += 1; mt = d[i]; i += 1; ln, i = _vlq(d, i)
                data = d[i:i + ln]; i += ln
                if mt == 0x51 and ln == 3: ev.append((t, "tempo", int.from_bytes(data, "big")))
                elif mt == 0x03: ev.append((t, "name", data.decode("utf-8", "replace")))
                continue
            if b in (0xF0, 0xF7):
                i += 1; ln, i = _vlq(d, i); i += ln
                continue
            if b & 0x80:
                run = b; i += 1
            st = run
            hi = st >> 4
            if hi in (0x9, 0x8):
                n, v = d[i], d[i + 1]; i += 2
                if hi == 0x9 and v > 0: ev.append((t, "on", (n, v, st & 0xF)))
                else: ev.append((t, "off", (n, st & 0xF)))
            elif hi in (0xA, 0xB, 0xE):
                i += 2
            elif hi in (0xC, 0xD):
                i += 1
            else:
                raise ValueError(f"未知事件 {st:#x}")
        tracks.append(ev); i = end

    tempos = sorted({e[0]: (e[0], e[2]) for tr in tracks for e in tr if e[1] == "tempo"}.values())
    if not tempos:
        tempos = [(0, 500000)]

    def to_sec(tick):
        sec, prev, us = 0.0, 0, tempos[0][1]
        for tt, pp in tempos:
            if tt >= tick:
                break
            sec += (tt - prev) * us / 1e6 / div
            prev, us = tt, pp
        return sec + (tick - prev) * us / 1e6 / div

    notes, opened = [], {}
    for ti, tr in enumerate(tracks):
        for e in tr:
            if e[1] == "on":
                n, v, ch = e[2]; opened[(ti, ch, n)] = e[0]
            elif e[1] == "off":
                n, ch = e[2]
                start_tick = opened.pop((ti, ch, n), None)
                if start_tick is not None:
                    notes.append((to_sec(start_tick), to_sec(e[0]), n, ti, ch))
    last = to_sec(max((e[0] for tr in tracks for e in tr), default=0))
    for (ti, ch, n), st in opened.items():
        notes.append((to_sec(st), last, n, ti, ch))
    return dict(div=div, notes=notes, tempos=tempos, last=last,
                names=[next((e[2] for e in tr if e[1] == "name"), f"轨道{ti+1}")
                       for ti, tr in enumerate(tracks)])


# ---------------- 映射：八度折叠 + 半音吸附 ----------------
def fold(note):
    t = note
    while t < LO: t += 12
    while t > HI: t -= 12
    return t


def snap(note, context=None):
    """返回 (映射后音高, 是否吸附, 方向)"""
    if note in KEYMAP:
        return note, False, 0
    if note % 12 in SCALE and LO <= note <= HI:
        return note, False, 0            # 理论不可达（音阶内必在表里），保险
    # 先朝较近的音阶音吸附
    up, down = note + 1, note - 1
    while up % 12 not in SCALE: up += 1
    while down % 12 not in SCALE: down -= 1
    if context:
        cu, cd = context.get(up, 0), context.get(down, 0)
        if cu != cd:
            return (up if cu > cd else down), True, (1 if cu > cd else -1)
    if LO <= up <= HI and (up - note) <= (note - down):
        return up, True, 1               # 平票默认向上（升号音在本曲风里多为上行解决）
    if LO <= down <= HI:
        return down, True, -1
    raise ValueError(f"无法映射 {note}")


def convert(notes, mode, transpose):
    """返回 (映射结果列表[(start,end,key)], 统计)"""
    st = dict(total=0, orig_ok=0, mapped=0, mapped_notes=0, folded=0,
              snapped_up=0, snapped_down=0, dropped=0, merged=0, retrigger=0,
              gap_fixed=0, max_chord=0)
    # 1) 先算出每个音的目标音高
    plan = []
    for start, end, n, ti, ch in notes:
        st["total"] += 1
        t = n + transpose
        # BetterGI 原始行为（对照用）
        f = t
        while f < LO: f += 12
        while f > HI: f -= 12
        if f in KEYMAP:
            st["orig_ok"] += 1
        if mode == "drop":
            if f in KEYMAP:
                plan.append((start, max(end, start + MIN_NOTE_MS / 1000.0), f))
            else:
                st["dropped"] += 1
            continue
        tf, folded = fold(t), False
        if tf != t:
            folded = True
        if mode == "raw":
            plan.append((start, max(end, start + MIN_NOTE_MS / 1000.0), tf))
            st["folded"] += folded
            continue
        ctx = None
        if tf not in KEYMAP:             # 需要吸附 -> 构造上下文直方图
            ctx = collections.Counter()
            for s2, e2, n2, _, _ in notes:
                if abs(s2 - start) <= 1.0:
                    v = fold(n2 + transpose)
                    if v in KEYMAP:
                        ctx[v] += 1
        tgt, snapped, direction = snap(fold(tf), ctx)
        if tgt not in KEYMAP:                 # 保险：吸附后再折叠一次
            tgt, snapped, direction = snap(fold(tgt), ctx)
        if snapped:
            st["snapped_up" if direction > 0 else "snapped_down"] += 1
        # 30ms 下限必须在这里先钳好：否则极短音（源谱里真有 1ms 的）会在发射阶段被
        # 推到「下一个同键音按下之后」，产生同键连续两次按下 + 孤立抬起。
        # 钳到 30ms 后若与下一个音重叠，交给下面的合并逻辑收拾。
        plan.append((start, max(end, start + MIN_NOTE_MS / 1000.0), tgt))
        st["folded"] += folded
    if mode == "raw":                    # raw 模式下丢不掉的音也要丢掉
        plan = [(s, e, v) for (s, e, v) in plan if v in KEYMAP]
    st["mapped_notes"] = len(plan)       # 映射成功的音符数（同键合并前）

    # 2) 同一键的重叠区间合并（避免同键重复按下）
    bykey = collections.defaultdict(list)
    for s, e, v in plan:
        bykey[v].append((s, e))
    intervals = []
    for v, iv in bykey.items():
        iv.sort()
        cur = None
        for s, e in iv:
            if cur and s < cur[1] - 1e-6:            # 真重叠（同键不可能同时按两次）→ 合并
                cur = (cur[0], max(cur[1], e)); st["merged"] += 1
            else:
                if cur and s <= cur[1] + 1e-6:
                    st["retrigger"] += 1             # 相邻不重叠 = 重新击键，不能合并
                if cur: intervals.append(cur + (v,))
                cur = (s, e)
        if cur: intervals.append(cur + (v,))
    st["mapped"] = len(intervals)

    # 2.5) 同键重击：保证两次击键之间 ≥30ms 间隔
    #      （等价于 BetterGI 在其它格式里做的 ApplyRepeatedKeyGap；
    #        自己在数据里保证，就不必依赖解析器那两个会永久移位游标的分支）
    bykey = collections.defaultdict(list)
    for s, e, v in intervals:
        bykey[v].append([s, e])
    for v, iv in bykey.items():
        iv.sort()
        for i in range(len(iv) - 1):
            if iv[i + 1][0] - iv[i][1] < 0.030:
                ne = iv[i + 1][0] - 0.030
                if ne - iv[i][0] >= 0.030:
                    iv[i][1] = ne
                    st["gap_fixed"] += 1
    intervals = [(s, e, v) for v, iv in bykey.items() for s, e in iv]

    # 3) 最大同时按键数
    ev = []
    for s, e, v in intervals:
        ev.append((s, 1)); ev.append((e, -1))
    ev.sort(key=lambda x: (x[0], x[1]))
    cur = mx = 0
    for _, d in ev:
        cur += d; mx = max(mx, cur)
    st["max_chord"] = mx
    return intervals, st


def to_midijson(intervals):
    """ticks=1000 & bpm=60 => 1 tick = 1 ms

    ⚠️ 语义（源码 MusicScoreParser.AddExplicitEvents(..., bool isDown)）：
       **D = 按下(KeyDown)，U = 抬起(KeyUp)** —— 每个音符「起点发 D、终点发 U」。
    同刻一律先 U 后 D：相邻同键重新击键时，两事件同刻，正好触发
    ApplyRepeatedKeyGap 把前一次抬起提前 30ms，保证两次击键之间有间隔。
    """
    dur = lambda x: max(int(round(x * 1000)), MIN_NOTE_MS)
    events = []
    for s, e, v in intervals:
        t0 = int(round(s * 1000))
        events.append((t0, True, KEYMAP[v]))                     # 按下
        events.append((t0 + dur(e - s), False, KEYMAP[v]))       # 抬起
    events.sort(key=lambda x: (x[0], 0 if not x[1] else 1))      # 同刻：抬起排前
    parts, prev = [], 0
    for t, isdown, key in events:
        t = max(t, prev)                     # 保证 delta >= 0
        parts.append(f"{'D' if isdown else 'U'}{key}{t - prev}")
        prev = t

    # 切断解析器那两个会「永久移位全局游标」的分支（parse 时的 30ms 处理）：
    #   分支A  D 紧跟 U 且同键、延迟 <30ms   → cursor += 30ms
    #   分支B  U 后面紧跟同键 D 且自身延迟 ≥30ms → cursor -= 30ms
    #   两者只有在「同刻的 U→D」时才互相抵消；其它情况都会让**后面整首曲子**提前/延后
    #   （实测长曲可累积漂移上百秒）。而上面的重击间隔已经由我们自己在数据里保证，
    #   所以这里插一个零时长、不产生按键事件的占位事件 "U@0"，
    #   让任何 U 后面都不再紧跟同键 D —— 两个分支都不触发，时间轴与源谱严格一致。
    #   （parser 里 keys=="@" 时不生成事件，也不会污染 previousKeys 的同键比对。）
    fixed = []
    for i, part in enumerate(parts):
        fixed.append(part)
        if i + 1 < len(parts):
            m1, m2 = _PART_RE.match(part), _PART_RE.match(parts[i + 1])
            if (m1 and m2 and m1.group(1) == "U" and m2.group(1) == "D"
                    and any(k in m2.group(2) for k in m1.group(2))):
                fixed.append("U@0")
    return "|".join(fixed), events


# ---------------- 校验（复刻 ParseMidiJsonTimeline） ----------------
def replay(notes, bpm, ticks):
    import re
    RE = re.compile(r"^([DU])([A-Z@]+)(\d+)$")
    out, cursor = [], 0.0
    prev_status = prev_keys = ""
    prev_was_event = False
    raw = [p for p in notes.split("|") if p]
    for i, part in enumerate(raw):
        m = RE.match(part)
        if not m:
            raise ValueError(f"事件无法解析: {part}")
        status, keys, dt = m.group(1), m.group(2), int(m.group(3))
        delay = dt * 60000.0 / (bpm * ticks)
        cursor += delay
        if status == "D" and prev_was_event and prev_status == "U" \
           and any(k in keys for k in prev_keys) and delay < 30:
            cursor += 30
        elif status == "U" and keys != "@" and delay >= 30 and i + 1 < len(raw):
            nm = RE.match(raw[i + 1])
            if nm and nm.group(1) == "D" and any(k in keys for k in nm.group(2)):
                cursor -= 30
        for k in keys:
            if k != "@":
                out.append((cursor, k, status == "D"))
        prev_status, prev_keys, prev_was_event = status, keys, True
    return out


def decode_events(notes_str):
    """纯 delta 解码：不含 BetterGI 的 30ms 连按偏移（那个会全局累加漂移，不能拿来比对绝对时刻）。
    用于校验「编码是否忠实于意图」+「D/U 语义是否写反」。"""
    import re
    RE = re.compile(r"^([DU])([A-Z@]+)(\d+)$")
    out, cur = [], 0
    for part in [p for p in notes_str.split("|") if p]:
        m = RE.match(part)
        if not m:
            raise ValueError(f"事件无法解析: {part}")
        cur += int(m.group(3))
        for k in m.group(2):
            if k != "@":
                out.append((cur, k, m.group(1) == "D"))
    return out


def _normalize(events):
    """复刻 MusicTimelineBuilder.Normalize（同键成对，嵌套的丢掉）"""
    s = sorted(events, key=lambda x: (x[0], 0 if not x[2] else 1))
    active, out = {}, []
    for t, k, down in s:
        c = active.get(k, 0)
        if down:
            active[k] = c + 1
            if c == 0:
                out.append((t, k, True))
        else:
            if c <= 0:
                continue
            active[k] = c - 1
            if c == 1:
                out.append((t, k, False))
    return out


def _repeated_key_gap(events):
    """复刻 ApplyRepeatedKeyGap：同键「抬起」与紧接的「按下」同刻时，把抬起提前 30ms"""
    ev = sorted(events, key=lambda x: (x[0], 0 if not x[2] else 1))
    prev_down, prev_up_idx = {}, {}
    for i, (t, k, down) in enumerate(ev):
        if down:
            ui = prev_up_idx.get(k)
            if ui is not None and ev[ui][0] == t and k in prev_down:
                early = t - 30
                if early > prev_down[k]:
                    ev[ui] = (early, ev[ui][1], ev[ui][2])
            prev_down[k] = t
        else:
            prev_up_idx[k] = i
    return sorted(ev, key=lambda x: (x[0], 0 if not x[2] else 1))


def press_intervals(events):
    """(t,key,is_down) → 每键按下区间 {key: [(down_ms, up_ms)]}"""
    open_at, iv = {}, collections.defaultdict(list)
    for t, k, down in events:
        if down:
            open_at[k] = t
        elif k in open_at:
            iv[k].append((open_at.pop(k), t))
    return iv


def verify_intervals(intervals, notes_str, tol_ms=2.0):
    """强校验：把生成的 JSON 用解析器复刻重放（含 Normalize / ApplyRepeatedKeyGap），
    再逐键比对「按下区间」与源区间。
    这一条能抓出「D/U 写反」这类错误 —— 只查「键合法 + 时间单调」是抓不出来的。"""
    # 用忠实复刻的解析器（含 30ms 游标处理）重放：既抓 D/U 写反，也抓漂移
    raw = replay(notes_str, JSON_BPM, JSON_TICKS)
    got = press_intervals(raw)
    exp = collections.defaultdict(list)
    for s, e, v in intervals:
        t0 = int(round(s * 1000))
        exp[KEYMAP[v]].append((t0, t0 + max(int(round((e - s) * 1000)), MIN_NOTE_MS)))
    max_dev, pairs, miss = 0.0, 0, 0
    for k in set(list(got) + list(exp)):
        g, x = sorted(got.get(k, [])), sorted(exp.get(k, []))
        if len(g) != len(x):
            miss += abs(len(g) - len(x))
        for (gs, ge), (xs, xe) in zip(g, x):
            max_dev = max(max_dev, abs(gs - xs), abs(ge - xe))
            pairs += 1
    return (max_dev <= tol_ms and miss == 0), max_dev, pairs, miss


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["snap", "drop", "raw"], default="snap")
    ap.add_argument("--transpose", type=int, default=0)
    ap.add_argument("--outdir", default=OUT)
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    rows, ok, fail = [], 0, 0
    for fn in sorted(f for f in os.listdir(LIB) if f.lower().endswith((".mid", ".midi"))):
        name = os.path.splitext(fn)[0].replace("\ufffd", "")   # 源仓库有乱码文件名，统一清掉
        try:
            m = parse_smf(os.path.join(LIB, fn))
            intervals, st = convert(m["notes"], a.mode, a.transpose)
            notes_str, events = to_midijson(intervals)
            if not events:
                rows.append([name, "跳过(无可演奏音)", m["last"]]); fail += 1; continue
            span = (events[-1][0] - events[0][0]) / 1000.0
            okv, dev, pairs, miss = verify_intervals(intervals, notes_str)
            obj = {
                "name": name + TAG,
                "author": f"Hermes｜MIDI 转换（{a.mode} 模式）",
                "instrument": "风物之诗琴",
                "type": "midi",
                "description": (f"由 MIDI 转换：原音符 {st['total']}，可演奏 {st['mapped']}，"
                                f"八度折叠 {st['folded']}，半音吸附 ↑{st['snapped_up']}/↓{st['snapped_down']}，"
                                f"原映射率 {st['orig_ok']/max(st['total'],1)*100:.1f}%，"
                                f"转换后 {st['mapped_notes']/max(st['total'],1)*100:.1f}%"),
                "time_signature": "4/4",
                "bpm": JSON_BPM,
                "ticks": JSON_TICKS,
                "notes": notes_str,
            }
            with open(os.path.join(a.outdir, f"{name}.json"), "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
            rows.append([name, "OK" if okv else f"区间不符(偏差{dev:.0f}ms/缺{miss})",
                         st["total"], st["mapped_notes"],
                         f"{st['orig_ok']/max(st['total'],1)*100:.1f}%",
                         f"{st['mapped_notes']/max(st['total'],1)*100:.1f}%",
                         st["folded"], st["snapped_up"], st["snapped_down"],
                         st["merged"], st["retrigger"], st["gap_fixed"], st["max_chord"],
                         f"{m['last']:.1f}s", f"{span:.1f}s", f"{dev:.0f}"])
            ok += 1
        except Exception as e:
            rows.append([name, "失败", str(e)]); fail += 1

    with open(os.path.join(REPORTS, "midi转换报告.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["曲名", "结果", "原音符数", "可演奏数", "原可演奏率", "转换后可演奏率",
                    "八度折叠数", "半音吸附↑", "半音吸附↓", "同键合并", "重新击键", "重击间隔修正",
                    "最大同时按键",
                    "原时长", "转换后跨度", "校验最大偏差ms"])
        w.writerows(rows)
    print(f"[MIDI→JSON] 模式={a.mode} 成功 {ok} / 失败 {fail} -> {a.outdir}")
    print(f"[MIDI→JSON] 报告 {os.path.join(REPORTS,'midi转换报告.csv')}")


if __name__ == "__main__":
    main()
