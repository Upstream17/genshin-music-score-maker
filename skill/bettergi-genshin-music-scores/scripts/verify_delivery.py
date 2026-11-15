#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""成品 JSON 的交付前硬验收（SKILL §0.5 / §0.6 的可执行版本）。

用法：
    python verify_delivery.py 成品.json
    python verify_delivery.py 成品.json --expect-first-notes E4,E4,G4,A4,C5   # 可选：核对开头
    python verify_delivery.py 成品.json --quiet                              # 只打 PASS/FAIL

做四件事：
  1. 复刻 BetterGI 的 press_intervals，拿到每个键的按下/抬起区间；
  2. 打出一整套交付指标（首音时刻、音区分布、按键数、每 10s 音符数、>2s 空档、
     同键最小间隔、八度跳占比、最大同按（按住峰值 / 30ms 起手））；
  3. 对每条指标给 PASS / WARN / FAIL（阈值即 SKILL §0.5 的合格线）；
  4. 任一 FAIL → 退出码 1，便于脚本化门禁。

设计前提（踩过坑才写进来的）：
  · 「强校验 0ms / 丢音 0」证明不了"旋律还成形"。所以本脚本把**时间分布**（每 10s 音符数）
    和**相邻音程的八度跳占比**当一等指标 —— 这两个才是抓住"中间大段空白""乱按"的东西。
  · 只看 len(notes)/首音/末音会骗人：312 个音摊在 171 秒里，实际可以断成四截。
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PC = {0, 2, 4, 5, 7, 9, 11}


def nn(p: int) -> str:
    return f"{NAMES[p % 12]}{p // 12 - 1}"


def build_keymap():
    """BetterGI 风物之诗琴 21 键：下排 Z-M = C3-B3，中排 A-J = C4-B4，上排 Q-U = C5-B5。"""
    return {48: "Z", 50: "X", 52: "C", 53: "V", 55: "B", 57: "N", 59: "M",
            60: "A", 62: "S", 64: "D", 65: "F", 67: "G", 69: "H", 71: "J",
            72: "Q", 74: "W", 76: "E", 77: "R", 79: "T", 81: "Y", 83: "U"}


KEYMAP = build_keymap()
LETTER2PITCH = {v: k for k, v in KEYMAP.items()}


def decode_events(notes_str: str):
    """midi-JSON 的 note 串 → [(ms, 'D'|'U', 键字母)]。'@' 是占位符，跳过。"""
    out, t = [], 0
    for tok in notes_str.split("|"):
        tok = tok.strip()
        if not tok or tok[0] not in "DU":
            continue
        kind, key = tok[0], tok[1]
        t += int(tok[2:]) if tok[2:] else 0
        out.append((t, kind, key))
    return out


def press_intervals(events):
    """[{键字母: [(start_ms, end_ms), ...]}]；同键多次按下按 FIFO 配对。"""
    open_, res = {}, collections.defaultdict(list)
    for ms, kind, key in events:
        if kind == "D":
            open_.setdefault(key, []).append(ms)
        elif open_.get(key):
            res[key].append((open_[key].pop(0), ms))
    return res


def check(name, value, ok, warn=None, fmt=str, note=""):
    """ok / warn 为 None 表示只报数不判定。返回 (status, line)。"""
    if ok is None:
        status = "INFO"
    elif ok:
        status = "PASS"
    elif warn is not None and warn:
        status = "WARN"
    else:
        status = "FAIL"
    line = f"  [{status}] {name}: {fmt(value)}" + (f"   {note}" if note else "")
    return status, line


def analyse(path: str, expect_first: list[str] | None = None, args_mono: bool = False):
    raw = json.load(open(path, encoding="utf-8"))
    notes_str = raw["notes"]
    piv = press_intervals(decode_events(notes_str))
    on = sorted((a, b, LETTER2PITCH[k]) for k, lst in piv.items() for a, b in lst)
    if not on:
        raise SystemExit("成品里没有任何可解析的按下事件")

    seq = [p for _, _, p in on]
    starts = sorted(a for a, _, _ in on)
    dur_ms = max(b for _, b, _ in on)
    dur_s = dur_ms / 1000

    rows = []

    # ---- 1. 基本量 ----
    rows.append(check("音符数", len(on), None))
    rows.append(check("时长", f"{dur_s:.1f}s ({int(dur_s // 60)}:{dur_s % 60:04.1f})", None))
    first_ms = starts[0]
    rows.append(check("首音时刻", f"{first_ms}ms", first_ms <= 1500,
                      note="应 ≈300ms；>1500ms 说明开头有空白没裁"))

    # ---- 2. 音区与按键覆盖（§0.6 ③：别空出一整排） ----
    low = sum(1 for p in seq if p < 60)
    mid = sum(1 for p in seq if 60 <= p < 72)
    high = sum(1 for p in seq if p >= 72)
    used_rows = sum(1 for n in (low, mid, high) if n > 0)
    rows.append(check("音区分布 低Z-M/中A-J/高Q-U", f"{low}/{mid}/{high}",
                      used_rows == 3, warn=used_rows == 2,
                      note="只用 2 排说明移调选窄了（除非该曲音域本就窄）"))
    rows.append(check("按键数", f"{len(piv)}/21", len(piv) >= 15, warn=len(piv) >= 10,
                      note="".join(sorted(piv))))
    rows.append(check("音域", f"{nn(min(seq))}–{nn(max(seq))}", None))
    allwhite = all(p % 12 in MAJOR_PC for p in seq)
    rows.append(check("全白键（无黑键被错放）", allwhite, allwhite))

    # ---- 3. 时间分布：每 10s 音符数（§0.6 ① 抓"中间大段空白"） ----
    nb = int(dur_ms // 10000) + 1
    bucket = collections.Counter(int(a // 10000) * 10 for a, _, _ in on)
    per10 = [bucket.get(i * 10, 0) for i in range(nb)]
    last_bucket = int(starts[-1] // 10000)
    # 只判"内部"空档：末尾那个不满 10s 的桶不算（短曲会被误报，实测天路 192s 在 190s 桶为 0 -> 假 FAIL）
    zeros = [i * 10 for i, c in enumerate(per10) if c == 0 and i <= last_bucket]
    rows.append(check("每10s音符数", per10, not zeros,
                      note=(f"★ {zeros} 秒处无音符 —— 检查是否漏了互补轨（§0.6 ②）" if zeros else "")))

    # ---- 4. 长空档 ----
    blanks = [(starts[i], starts[i + 1] - starts[i]) for i in range(len(starts) - 1)
              if starts[i + 1] - starts[i] > 2000]
    rows.append(check(">2s 空档", len(blanks),
                      len(blanks) <= 2, warn=len(blanks) <= 5,
                      note="; ".join(f"{t/1000:.1f}s 起空 {g/1000:.1f}s" for t, g in blanks) or "无"))

    # ---- 5. 同键重击间隔（§4c 游标陷阱） ----
    gaps = []
    for lst in piv.values():
        srt = sorted(lst)
        gaps.extend(srt[i + 1][0] - srt[i][1] for i in range(len(srt) - 1))
    min_gap = min(gaps) if gaps else None
    rows.append(check("同键最小间隔", f"{min_gap}ms" if min_gap is not None else "n/a",
                      (min_gap is None) or min_gap >= 30,
                      note="<30ms 会让解析器游标漂移（§4c）"))

    # ---- 6. 大音程占比（§0.5 ① 抓"乱按"；对多层编曲会偏高，见下方说明） ----
    # 说明：这个指标是为**单声部旋律**校准的（实测折叠翻车版 45%、正常单旋律 ≤2%）。
    # 但**带琶音/伴奏层的编曲**天然会高：琶音跨两个八度，相邻音常差 ≥12，实测正常成品 57%。
    # 所以阈值按"是否显式声明了单声部"分档，并在 WARN 时提示人工确认。
    jumps = tot = 0
    for i in range(len(on) - 1):
        if on[i + 1][0] - on[i][0] < 900:          # 同句内
            tot += 1
            if abs(on[i + 1][2] - on[i][2]) >= 12:
                jumps += 1
    rate = jumps / tot * 100 if tot else 0.0
    rows.append(check(f"大音程(≥12)占比 同句内{'' if args_mono else ' [多层编曲阈值]'}",
                      f"{jumps}/{tot} = {rate:.1f}%",
                      rate <= (2 if args_mono else 65),
                      warn=rate <= (5 if args_mono else 85),
                      note=("单声部旋律应 ≤2%" if args_mono
                            else "多层编曲天然偏高；若 >85% 或听着像「跨排乱跳」才可疑")))

    # ---- 7. 最大同按（两个口径）----
    # 口径①按住峰值：按区间扫描；长音叠置会把数放大（钢琴转谱常见），只报数不判定。
    _ev = decode_events(notes_str)
    _piv = press_intervals(_ev)
    _pts = [(a, 1) for l in _piv.values() for a, _ in l] + [(b, -1) for l in _piv.values() for _, b in l]
    _pts.sort(key=lambda x: (x[0], x[1]))
    _cur = _held = 0
    for _, _d in _pts:
        _cur += _d
        _held = max(_held, _cur)
    rows.append(check("最大同按(按住峰值)", _held, None, note="长音叠置会放大，仅供参考"))
    # 口径②30ms 内起手：真正"同时按下一组和弦"的键数，判定用。
    # 注意跳过 '@' 占位符（它对应用里不产生按键）；旧版把它当抬起计入净减，会报成 4 而实际 13。
    _downs = sorted(ms for ms, kind, key in _ev if kind == "D" and key != "@")
    _att = 0
    for _i in range(len(_downs)):
        _j = _i
        while _j < len(_downs) and _downs[_j] - _downs[_i] <= 30:
            _j += 1
        _att = max(_att, _j - _i)
    rows.append(check("最大同按(30ms 起手)", _att, _att <= 5, warn=_att <= 8,
                      note=">8 键人类/脚本都吃不消；长音叠置不计入"))

    # ---- 8. 开头音级核对（可选） ----
    if expect_first:
        want = expect_first
        got = [nn(p) for p in seq[:len(want)]]
        same = all(g.rstrip("0123456789") == w.rstrip("0123456789") for g, w in zip(got, want))
        rows.append(check("开头音名核对", f"{' '.join(got)}  (期望 {' '.join(want)})", same,
                          note="只比音名不比八度" if not same else ""))

    return rows, dict(on=on, piv=piv, seq=seq, dur_s=dur_s, per10=per10)


def main():
    ap = argparse.ArgumentParser(description="成品 JSON 的交付前硬验收")
    ap.add_argument("json_path")
    ap.add_argument("--expect-first-notes", default=None,
                    help="逗号分隔的音名，如 E4,E4,G4,A4,C5（只比音名不比八度）")
    ap.add_argument("--quiet", action="store_true", help="只打 PASS/FAIL 汇总")
    ap.add_argument("--mono", action="store_true",
                    help="声明这是单声部旋律（大音程≥12 的阈值收紧到 2%%，用于抓折叠/跨排乱跳）")
    args = ap.parse_args()

    if not os.path.exists(args.json_path):
        raise SystemExit(f"文件不存在: {args.json_path}")
    expect = [x.strip() for x in args.expect_first_notes.split(",")] if args.expect_first_notes else None

    print(f"=== 交付验收: {os.path.basename(args.json_path)} ===")
    rows, info = analyse(args.json_path, expect, args_mono=args.mono)
    if not args.quiet:
        print(f"  （文件 {os.path.getsize(args.json_path)} 字节）")
    for _, line in rows:
        print(line)

    fails = [l for st, l in rows if st == "FAIL"]
    warns = [l for st, l in rows if st == "WARN"]
    print(f"\n汇总: PASS {sum(1 for st,_ in rows if st=='PASS')} / "
          f"WARN {len(warns)} / FAIL {len(fails)}")
    if fails:
        print("★ 有 FAIL，不要交付：")
        for l in fails:
            print("   " + l.strip())
        return 1
    if warns:
        print("⚠ 有 WARN，确认每一项都是「原曲本身如此」再交付")
    else:
        print("✓ 全部通过，可以交付")
    return 0


if __name__ == "__main__":
    sys.exit(main())
