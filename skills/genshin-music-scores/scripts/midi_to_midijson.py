#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BetterGI 原神 21 键 midi JSON 核心编排引擎与校验 SDK。

职责：
1. 唯一权威的 SMF (.mid/.midi) 解析（含 tempo map、轨名、GM Program Change）
2. BetterGI 21 键映射（C3–B5 = 48..83）、八度折叠、上下文吸附（snap/drop/raw）
3. `type:"midi"` JSON 序列化（D/U 排序、30ms 防游标偏移 `U@0` 占位）
4. 逐键按下区间回放与解析器级强校验（`verify_intervals`）
5. 常用微调积木：`cap_polyphony`、`trim_leading_silence`、`split_retriggers`、`transpose_midijson_doc`
"""
from __future__ import annotations

import collections
import copy
import json
import os
import re
import struct

KEYMAP = {
    48: "Z", 50: "X", 52: "C", 53: "V", 55: "B", 57: "N", 59: "M",
    60: "A", 62: "S", 64: "D", 65: "F", 67: "G", 69: "H", 71: "J",
    72: "Q", 74: "W", 76: "E", 77: "R", 79: "T", 81: "Y", 83: "U",
}
LETTER2PITCH = {v: k for k, v in KEYMAP.items()}
LO, HI = min(KEYMAP), max(KEYMAP)
MAJOR_PC = {0, 2, 4, 5, 7, 9, 11}
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
LOW_KEYS = set("ZXCVBNM")

MIN_NOTE_MS = 30
JSON_BPM = 60
JSON_TICKS = 1000

_PART_RE = re.compile(r"^([DU])([A-Z@]+)(\d+)$")


def note_name(pitch: int) -> str:
    return f"{PITCH_NAMES[pitch % 12]}{pitch // 12 - 1}"


def _vlq(data: bytes, idx: int):
    val = 0
    while True:
        byte = data[idx]
        idx += 1
        val = (val << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return val, idx


def parse_smf(path: str) -> dict:
    """解析标准 MIDI 文件（仅支持 PPQ 时间基准，不含 pitch bend 0xE0 自动累加）。"""
    d = open(path, "rb").read()
    if d[:4] != b"MThd":
        raise ValueError("不是标准 MIDI 文件（缺 MThd）")
    hlen = struct.unpack(">I", d[4:8])[0]
    fmt, ntrks, div = struct.unpack(">HHH", d[8:14])
    if div & 0x8000:
        raise ValueError("SMPTE 时间基准，未支持")

    i = 8 + hlen
    tracks = []
    for _ in range(ntrks):
        if d[i:i + 4] != b"MTrk":
            raise ValueError("轨道头损坏")
        tl = struct.unpack(">I", d[i + 4:i + 8])[0]
        i += 8
        end, t, run, ev = i + tl, 0, None, []
        while i < end:
            dt, i = _vlq(d, i)
            t += dt
            b = d[i]
            if b == 0xFF:
                i += 1
                mt = d[i]
                i += 1
                ln, i = _vlq(d, i)
                payload = d[i:i + ln]
                i += ln
                if mt == 0x51 and ln == 3:
                    ev.append((t, "tempo", int.from_bytes(payload, "big")))
                elif mt == 0x03:
                    ev.append((t, "name", payload.decode("utf-8", "replace")))
                continue
            if b in (0xF0, 0xF7):
                i += 1
                ln, i = _vlq(d, i)
                i += ln
                continue
            if b & 0x80:
                run = b
                i += 1
            hi = run >> 4
            ch = run & 0xF
            if hi in (0x9, 0x8):
                n, v = d[i], d[i + 1]
                i += 2
                if hi == 0x9 and v > 0:
                    ev.append((t, "on", (n, v, ch)))
                else:
                    ev.append((t, "off", (n, ch)))
            elif hi in (0xA, 0xB, 0xE):
                i += 2
            elif hi == 0xC:
                ev.append((t, "prog", (d[i], ch)))
                i += 1
            elif hi == 0xD:
                i += 1
            else:
                raise ValueError(f"未知 MIDI 事件 {run:#x}")
        tracks.append(ev)
        i = end

    tempos = sorted({e[0]: (e[0], e[2]) for tr in tracks for e in tr if e[1] == "tempo"}.values())
    if not tempos:
        tempos = [(0, 500000)]

    def to_sec(tick: int) -> float:
        sec, prev, us = 0.0, 0, tempos[0][1]
        for tt, us2 in tempos:
            if tt >= tick:
                break
            sec += (tt - prev) * us / 1e6 / div
            prev, us = tt, us2
        return sec + (tick - prev) * us / 1e6 / div

    notes, opened = [], {}
    programs = {}
    for ti, tr in enumerate(tracks):
        tr_prog = {}
        for e in tr:
            if e[1] == "prog":
                prog, ch = e[2]
                tr_prog.setdefault(ch, prog)
            elif e[1] == "on":
                n, _, ch = e[2]
                opened[(ti, ch, n)] = e[0]
            elif e[1] == "off":
                n, ch = e[2]
                st = opened.pop((ti, ch, n), None)
                if st is not None:
                    notes.append((to_sec(st), to_sec(e[0]), n, ti, ch))
        programs[ti] = tr_prog

    last_tick = max((e[0] for tr in tracks for e in tr), default=0)
    last = to_sec(last_tick)
    for (ti, ch, n), st in opened.items():
        notes.append((to_sec(st), last, n, ti, ch))

    names = [next((e[2] for e in tr if e[1] == "name"), f"轨道{ti + 1}") for ti, tr in enumerate(tracks)]
    return dict(fmt=fmt, div=div, notes=notes, tempos=tempos, last=last, names=names, programs=programs)


def fold(note: int) -> int:
    while note < LO:
        note += 12
    while note > HI:
        note -= 12
    return note


def snap(note: int, context=None):
    """把半音吸附到相邻白键；返回 (目标音高, 是否发生吸附, 方向+1/-1/0)。"""
    if note in KEYMAP:
        return note, False, 0
    up, dn = note + 1, note - 1
    if up in KEYMAP and dn in KEYMAP:
        if context and context.get(up, 0) != context.get(dn, 0):
            return (up, True, 1) if context[up] > context[dn] else (dn, True, -1)
        return up, True, 1
    if up in KEYMAP:
        return up, True, 1
    if dn in KEYMAP:
        return dn, True, -1
    return note, False, 0


def _as_note5(notes):
    """兼容 (start, end, pitch) 与 (start, end, pitch, track, ch) 两种元组输入。"""
    out = []
    for item in notes:
        if len(item) == 3:
            out.append((item[0], item[1], item[2], 0, 0))
        elif len(item) >= 5:
            out.append((item[0], item[1], item[2], item[3], item[4]))
        else:
            raise ValueError(f"不支持的音符元组长度: {item}")
    return out


def cap_polyphony(notes, max_keys: int):
    """同一音头最多保留 max_keys 个最高音。"""
    notes5 = _as_note5(notes)
    if not max_keys or max_keys <= 0:
        return notes5, 0
    groups = collections.defaultdict(list)
    for n in notes5:
        groups[round(n[0] * 1000)].append(n)
    kept, dropped = [], 0
    for _, grp in sorted(groups.items()):
        if len(grp) <= max_keys:
            kept.extend(grp)
        else:
            top = sorted(grp, key=lambda x: -x[2])[:max_keys]
            kept.extend(top)
            dropped += len(grp) - len(top)
    return kept, dropped


def trim_leading_silence(notes, target_start_s: float = 0.30):
    """若首音晚于 target_start_s，整体前移时间轴让首音落在 target_start_s。"""
    notes5 = _as_note5(notes)
    if not notes5:
        return notes5, 0.0
    first = min(n[0] for n in notes5)
    shift = first - target_start_s
    if shift <= 0.05:
        return notes5, 0.0
    return [(max(0.0, s - shift), max(0.0, e - shift), p, ti, ch) for s, e, p, ti, ch in notes5], shift


def split_retriggers(intervals, gap_s: float = 0.035, min_dur_s: float = 0.030):
    """拨奏语义：对同键重叠或间隔 < gap_s 的相邻击键，缩短前音尾巴而不是合并。"""
    by_key = collections.defaultdict(list)
    for s, e, p in intervals:
        by_key[p].append((float(s), float(e)))
    out = []
    for p, lst in by_key.items():
        lst.sort()
        cur = []
        for s, e in lst:
            e = max(e, s + min_dur_s)
            if cur and s - cur[-1][0] < gap_s:
                cur[-1] = (cur[-1][0], max(cur[-1][1], e))
                continue
            if cur and cur[-1][1] > s - gap_s:
                ps = cur[-1][0]
                cur[-1] = (ps, max(ps + min_dur_s, s - gap_s))
            cur.append((s, e))
        for s, e in cur:
            out.append((s, e, p))
    out.sort()
    return out


def convert(notes, mode: str = "snap", transpose: int = 0):
    """将音符列表映射为 21 键按压区间 [(start_s, end_s, pitch), ...]，返回 (intervals, stats)。"""
    notes5 = _as_note5(notes)
    st = dict(
        total=0, orig_ok=0, mapped=0, mapped_notes=0, folded=0,
        snapped_up=0, snapped_down=0, dropped=0, merged=0, retrigger=0,
        gap_fixed=0, max_chord=0,
    )
    min_dur = MIN_NOTE_MS / 1000.0
    plan = []

    for start, end, n, _, _ in notes5:
        st["total"] += 1
        t = n + transpose
        f = fold(t)
        if f in KEYMAP:
            st["orig_ok"] += 1

        if mode == "drop":
            if f in KEYMAP:
                plan.append((start, max(end, start + min_dur), f))
            else:
                st["dropped"] += 1
            continue

        folded = f != t
        if mode == "raw":
            if f in KEYMAP:
                plan.append((start, max(end, start + min_dur), f))
                st["folded"] += int(folded)
            else:
                st["dropped"] += 1
            continue

        ctx = None
        if f not in KEYMAP:
            ctx = collections.Counter()
            for s2, _, n2, _, _ in notes5:
                if abs(s2 - start) <= 1.0:
                    v = fold(n2 + transpose)
                    if v in KEYMAP:
                        ctx[v] += 1
        tgt, snapped, direction = snap(f, ctx)
        if tgt not in KEYMAP:
            tgt, snapped, direction = snap(fold(tgt), ctx)
        if snapped:
            st["snapped_up" if direction > 0 else "snapped_down"] += 1
        plan.append((start, max(end, start + min_dur), tgt))
        st["folded"] += int(folded)

    st["mapped_notes"] = len(plan)

    bykey = collections.defaultdict(list)
    for s, e, v in plan:
        bykey[v].append((s, e))
    intervals = []
    for v, iv in bykey.items():
        iv.sort()
        cur = None
        for s, e in iv:
            if cur and s < cur[1] - 1e-6:
                cur = (cur[0], max(cur[1], e))
                st["merged"] += 1
            else:
                if cur and s <= cur[1] + 1e-6:
                    st["retrigger"] += 1
                if cur:
                    intervals.append((cur[0], cur[1], v))
                cur = (s, e)
        if cur:
            intervals.append((cur[0], cur[1], v))
    st["mapped"] = len(intervals)

    bykey_fix = collections.defaultdict(list)
    for s, e, v in intervals:
        bykey_fix[v].append([s, e])
    fixed_intervals = []
    for v, iv in bykey_fix.items():
        iv.sort()
        for i in range(len(iv) - 1):
            if iv[i + 1][0] - iv[i][1] < min_dur:
                ne = iv[i + 1][0] - min_dur
                if ne - iv[i][0] >= min_dur:
                    iv[i][1] = ne
                    st["gap_fixed"] += 1
        for s, e in iv:
            fixed_intervals.append((s, e, v))
    fixed_intervals.sort()

    ev = []
    for s, e, _ in fixed_intervals:
        ev.append((s, 1))
        ev.append((e, -1))
    ev.sort(key=lambda x: (x[0], x[1]))
    cur = mx = 0
    for _, d in ev:
        cur += d
        mx = max(mx, cur)
    st["max_chord"] = mx
    return fixed_intervals, st


def to_midijson(intervals):
    """生成 (notes_str, events)，按 ticks=1000, bpm=60 (1 tick = 1 ms) 并插入 U@0 防游标漂移。"""
    events = []
    for s, e, v in intervals:
        t0 = int(round(s * 1000))
        dur = max(int(round((e - s) * 1000)), MIN_NOTE_MS)
        events.append((t0, True, KEYMAP[v]))
        events.append((t0 + dur, False, KEYMAP[v]))
    events.sort(key=lambda x: (x[0], 0 if not x[1] else 1))

    parts, prev = [], 0
    for t, isdown, key in events:
        t = max(t, prev)
        parts.append(f"{'D' if isdown else 'U'}{key}{t - prev}")
        prev = t

    fixed = []
    for i, part in enumerate(parts):
        fixed.append(part)
        if i + 1 < len(parts):
            m1, m2 = _PART_RE.match(part), _PART_RE.match(parts[i + 1])
            if (m1 and m2 and m1.group(1) == "U" and m2.group(1) == "D"
                    and any(k in m2.group(2) for k in m1.group(2))):
                fixed.append("U@0")
    return "|".join(fixed), events


def replay(notes: str, bpm=JSON_BPM, ticks=JSON_TICKS):
    """复刻 BetterGI ParseMidiJsonTimeline（含两个 30ms 全局游标分支）。"""
    bpm_f, ticks_i = float(bpm), max(1, int(round(float(ticks))))
    out, cursor = [], 0.0
    prev_status = prev_keys = ""
    prev_was_event = False
    raw = [p for p in notes.split("|") if p]
    for i, part in enumerate(raw):
        m = _PART_RE.match(part)
        if not m:
            raise ValueError(f"事件无法解析: {part}")
        status, keys, dt = m.group(1), m.group(2), int(m.group(3))
        delay = dt * 60000.0 / (bpm_f * ticks_i)
        cursor += delay
        if status == "D" and prev_was_event and prev_status == "U" \
                and any(k in keys for k in prev_keys) and delay < 30:
            cursor += 30
        elif status == "U" and keys != "@" and delay >= 30 and i + 1 < len(raw):
            nm = _PART_RE.match(raw[i + 1])
            if nm and nm.group(1) == "D" and any(k in keys for k in nm.group(2)):
                cursor -= 30
        for k in keys:
            if k != "@":
                out.append((cursor, k, status == "D"))
        prev_status, prev_keys, prev_was_event = status, keys, True
    return out


def decode_events(notes_str: str, bpm=JSON_BPM, ticks=JSON_TICKS):
    """纯 delta 解码为 [(ms, key, is_down), ...]；支持任意 bpm/ticks 折算真实毫秒。"""
    bpm_f = float(bpm) if float(bpm) > 0 else float(JSON_BPM)
    ticks_i = max(1, int(round(float(ticks))))
    scale = 1.0 if (bpm_f == JSON_BPM and ticks_i == JSON_TICKS) else 60000.0 / (bpm_f * ticks_i)
    out, cur_ticks = [], 0
    for part in [p for p in notes_str.split("|") if p]:
        m = _PART_RE.match(part)
        if not m:
            raise ValueError(f"事件无法解析: {part}")
        cur_ticks += int(m.group(3))
        ms = cur_ticks if scale == 1.0 else int(round(cur_ticks * scale))
        is_down = m.group(1) == "D"
        for k in m.group(2):
            if k != "@":
                out.append((ms, k, is_down))
    return out


def press_intervals(events):
    """(ms, key, is_down) -> {key: [(down_ms, up_ms), ...]}，同键 FIFO 配对。"""
    opened = {}
    iv = collections.defaultdict(list)
    for t, k, down in events:
        if down:
            opened.setdefault(k, []).append(t)
        elif opened.get(k):
            iv[k].append((opened[k].pop(0), t))
    return iv


def load_json_intervals(path: str):
    """读取 type:midi JSON 并按自身 bpm/ticks 折算为真实毫秒区间。"""
    doc = json.load(open(path, "r", encoding="utf-8-sig"))
    if not isinstance(doc, dict) or not isinstance(doc.get("notes"), str):
        raise ValueError("不是合法的 type:midi JSON（缺少字符串 notes 字段）")
    bpm = doc.get("bpm", JSON_BPM)
    ticks = doc.get("ticks", JSON_TICKS)
    ev = decode_events(doc["notes"], bpm=bpm, ticks=ticks)
    by_key = press_intervals(ev)
    intervals_s = sorted((s / 1000.0, e / 1000.0, LETTER2PITCH[k])
                         for k, lst in by_key.items() if k in LETTER2PITCH for s, e in lst)
    return doc, intervals_s, by_key


def verify_intervals(intervals, notes_str: str, tol_ms: float = 2.0):
    """用 BetterGI 游标语义重放 notes_str，与源 intervals（秒）逐键比对按下区间。"""
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


def build_score_doc(name: str, notes_str: str, *, author: str = "MIDI 转换",
                    description: str = "", time_signature: str = "4/4",
                    bpm=JSON_BPM, ticks=JSON_TICKS, instrument: str = "风物之诗琴") -> dict:
    return {
        "name": name,
        "author": author,
        "instrument": instrument,
        "type": "midi",
        "description": description,
        "time_signature": time_signature,
        "bpm": str(bpm),
        "ticks": str(ticks),
        "notes": notes_str,
    }


def transpose_midijson_doc(doc: dict, semitones: int):
    """对现有 type:midi JSON 字典做整体半音平移（常用于 ±12 移八度），返回 (new_doc, stats)。"""
    notes = doc.get("notes")
    if not isinstance(notes, str):
        raise ValueError("不是 type:midi 的 MidiJson（notes 非字符串）")

    def _stats(s: str):
        d = u = tot = low = 0
        for part in s.split("|"):
            m = _PART_RE.match(part)
            if not m:
                continue
            if m.group(1) == "D":
                d += 1
            else:
                u += 1
            for k in m.group(2):
                if k == "@":
                    continue
                tot += 1
                if k in LOW_KEYS:
                    low += 1
        return d, u, tot, low

    out = []
    for part in notes.split("|"):
        m = _PART_RE.match(part)
        if not m:
            out.append(part)
            continue
        st, keys, dt = m.group(1), m.group(2), m.group(3)
        nk = []
        for k in keys:
            if k == "@":
                nk.append("@")
                continue
            if k not in LETTER2PITCH:
                raise ValueError(f"非法按键 {k}")
            p = LETTER2PITCH[k] + semitones
            if p not in KEYMAP:
                raise ValueError(f"键 {k}(音高 {LETTER2PITCH[k]}) 平移 {semitones} 后越界 ({p})")
            nk.append(KEYMAP[p])
        out.append(f"{st}{''.join(nk)}{dt}")
    new_notes = "|".join(out)

    od, ou, ot, olow = _stats(notes)
    nd, nu, nt, nlow = _stats(new_notes)
    if (od, ou, ot) != (nd, nu, nt):
        raise ValueError(f"事件数不一致: {od}/{ou}/{ot} -> {nd}/{nu}/{nt}")

    iv = press_intervals(decode_events(new_notes, bpm=JSON_BPM, ticks=JSON_TICKS))
    check_iv = [(s / 1000.0, e / 1000.0, LETTER2PITCH[k]) for k, lst in iv.items() for s, e in lst]
    ok, dev, _, miss = verify_intervals(check_iv, new_notes)
    if not ok:
        raise ValueError(f"强校验不通过: 偏差 {dev:.1f}ms, 缺 {miss}")

    new_doc = copy.deepcopy(doc)
    new_doc["notes"] = new_notes
    desc = str(new_doc.get("description") or "").rstrip("｜|")
    tag = f"整体移调（{semitones} 半音）：零折叠零吸附；低音键 {olow} → {nlow}"
    new_doc["description"] = f"{desc}｜{tag}" if desc else tag
    return new_doc, dict(total=ot, low_before=olow, low_after=nlow, dev_ms=dev)
