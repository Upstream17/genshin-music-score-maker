#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一曲谱验收与外科手术对比模块（合并原 verify_delivery 与 diff_press_intervals）。"""
from __future__ import annotations

import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import midi_to_midijson as m2  # noqa: E402


def _check(name, value, ok, warn=None, fmt=str, note=""):
    if ok is None:
        status = "INFO"
    elif ok:
        status = "PASS"
    elif warn:
        status = "WARN"
    else:
        status = "FAIL"
    line = f"  [{status}] {name}: {fmt(value)}" + (f"   {note}" if note else "")
    return status, line


def analyse_score(path: str, expect_first=None, mono: bool = False):
    """读取 type:midi JSON，按真实 bpm/ticks 执行 11 项交付硬验收。"""
    doc, intervals_s, piv = m2.load_json_intervals(path)
    on = sorted((round(s * 1000), round(e * 1000), p) for s, e, p in intervals_s)
    if not on:
        raise ValueError("成品里没有任何可解析的按下事件")

    seq = [p for _, _, p in on]
    starts = sorted(a for a, _, _ in on)
    durs = sorted(b - a for a, b, _ in on)
    dur_ms = max(b for _, b, _ in on)
    dur_s = dur_ms / 1000.0

    rows = []
    rows.append(_check("音符数", len(on), None))
    rows.append(_check("时长", f"{dur_s:.1f}s ({int(dur_s // 60)}:{dur_s % 60:04.1f})", None))
    rows.append(_check("首音时刻", f"{starts[0]}ms", starts[0] <= 1500,
                       note="建议 ≈300ms；>1500ms 说明前导空拍未裁"))
    rows.append(_check("时长中位数", f"{durs[len(durs) // 2]}ms", durs[len(durs) // 2] >= 150,
                       warn=durs[len(durs) // 2] >= 60,
                       note="<60ms 常见于时值当结束时刻误算或短音截断"))

    low = sum(1 for p in seq if p < 60)
    mid = sum(1 for p in seq if 60 <= p < 72)
    high = sum(1 for p in seq if p >= 72)
    used_rows = sum(1 for n in (low, mid, high) if n > 0)
    rows.append(_check("音区分布 低Z-M/中A-J/高Q-U", f"{low}/{mid}/{high}",
                       used_rows == 3, warn=used_rows == 2,
                       note="只用 2 排说明移调或音区偏窄（窄音域曲目除外）"))
    rows.append(_check("按键数", f"{len(piv)}/21", len(piv) >= 15, warn=len(piv) >= 10,
                       note="".join(sorted(piv))))
    rows.append(_check("音域", f"{m2.note_name(min(seq))}–{m2.note_name(max(seq))}", None))
    allwhite = all(p % 12 in m2.MAJOR_PC for p in seq)
    rows.append(_check("全白键合法性", allwhite, allwhite))

    nb = int(dur_ms // 10000) + 1
    bucket = collections.Counter(int(a // 10000) * 10 for a, _, _ in on)
    per10 = [bucket.get(i * 10, 0) for i in range(nb)]
    last_bucket = int(starts[-1] // 10000)
    zeros = [i * 10 for i, c in enumerate(per10) if c == 0 and i <= last_bucket]
    rows.append(_check("每10s音符数", per10, not zeros,
                       note=(f"{zeros} 秒处无音符，检查是否漏了互补轨" if zeros else "")))

    blanks = [(starts[i], starts[i + 1] - starts[i]) for i in range(len(starts) - 1)
              if starts[i + 1] - starts[i] > 2000]
    rows.append(_check(">2s 空档", len(blanks), len(blanks) <= 2, warn=len(blanks) <= 5,
                       note="; ".join(f"{t / 1000:.1f}s 起空 {g / 1000:.1f}s" for t, g in blanks) or "无"))

    gaps = []
    for lst in piv.values():
        srt = sorted(lst)
        gaps.extend(srt[i + 1][0] - srt[i][1] for i in range(len(srt) - 1))
    min_gap = min(gaps) if gaps else None
    rows.append(_check("同键最小间隔", f"{min_gap}ms" if min_gap is not None else "n/a",
                       (min_gap is None) or min_gap >= 30,
                       note="<30ms 可能触发解析器游标漂移"))

    jumps = tot = 0
    for i in range(len(on) - 1):
        if on[i + 1][0] - on[i][0] < 900:
            tot += 1
            if abs(on[i + 1][2] - on[i][2]) >= 12:
                jumps += 1
    rate = jumps / tot * 100 if tot else 0.0
    rows.append(_check(f"大音程(≥12)占比 同句内{'' if mono else ' [多层编曲阈值]'}",
                       f"{jumps}/{tot} = {rate:.1f}%",
                       rate <= (2 if mono else 65), warn=rate <= (5 if mono else 85),
                       note=("单声部应 ≤2%" if mono else "多层编曲天然偏高；>85% 或乱跳需核对")))

    pts = [(a, 1) for lst in piv.values() for a, _ in lst] + [(b, -1) for lst in piv.values() for _, b in lst]
    pts.sort(key=lambda x: (x[0], x[1]))
    cur = held = 0
    for _, d in pts:
        cur += d
        held = max(held, cur)
    rows.append(_check("最大同按(按住峰值)", held, None, note="长音叠置会放大，仅供参考"))

    downs = sorted(a for a, _, _ in on)
    att = 0
    for i in range(len(downs)):
        j = i
        while j < len(downs) and downs[j] - downs[i] <= 30:
            j += 1
        att = max(att, j - i)
    rows.append(_check("最大同按(30ms 起手)", att, att <= 5, warn=att <= 8,
                       note=">8 键手弹或脚本易漏按"))

    if expect_first:
        got = [m2.note_name(p) for p in seq[:len(expect_first)]]
        same = all(g.rstrip("0123456789") == w.rstrip("0123456789") for g, w in zip(got, expect_first))
        rows.append(_check("开头音名核对", f"{' '.join(got)} (期望 {' '.join(expect_first)})", same,
                           note="只比音名不比八度" if not same else ""))

    return rows, doc


def run_verify(path: str, *, expect_first=None, mono: bool = False, quiet: bool = False) -> int:
    if not os.path.exists(path):
        print(f"[x] 文件不存在: {path}")
        return 2
    print(f"=== 交付验收: {os.path.basename(path)} ===")
    rows, _ = analyse_score(path, expect_first=expect_first, mono=mono)
    if not quiet:
        print(f"  （文件 {os.path.getsize(path)} 字节）")
    for _, line in rows:
        print(line)
    fails = [line for st, line in rows if st == "FAIL"]
    warns = [line for st, line in rows if st == "WARN"]
    passes = sum(1 for st, _ in rows if st == "PASS")
    print(f"\n汇总: PASS {passes} / WARN {len(warns)} / FAIL {len(fails)}")
    if fails:
        print("★ 存在 FAIL 项，不建议交付")
        return 1
    print("⚠ 有 WARN，请核对确系原曲特点后再交付" if warns else "✓ 全部通过，可以交付")
    return 0


def parse_windows(spec: str):
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        a, b = part.replace(":", "-").split("-")
        a, b = float(a), float(b)
        if a > 100000:
            a, b = a / 1000.0, b / 1000.0
        out.append((a, b))
    return out


def diff_intervals(old_path: str, new_path: str, windows_spec: str = "") -> int:
    """比对两份 JSON 在编辑时间窗之外是否逐键完全一致。"""
    _, old_iv, _ = m2.load_json_intervals(old_path)
    _, new_iv, _ = m2.load_json_intervals(new_path)
    old = sorted((round(s, 3), round(e, 3), p) for s, e, p in old_iv)
    new = sorted((round(s, 3), round(e, 3), p) for s, e, p in new_iv)
    wins = parse_windows(windows_spec)
    if not wins:
        print("⚠ 未指定 --windows：执行整曲逐键比对")
    print(f"旧 {len(old)} 键｜新 {len(new)} 键｜窗口 {len(wins)} 个")

    inside = lambda t: any(w0 <= t <= w1 for w0, w1 in wins)
    crossing = lambda s, e: any((not inside(s)) and w0 < e <= w1 for w0, w1 in wins)

    o_out = [x for x in old if not inside(x[0]) and not crossing(x[0], x[1])]
    n_out = [x for x in new if not inside(x[0]) and not crossing(x[0], x[1])]
    same = o_out == n_out
    print(f"\n① 编辑区之外: 旧 {len(o_out)} vs 新 {len(n_out)} → {'逐键完全一致 ✓' if same else '✗ 存在差异'}")
    if not same:
        only_o = sorted(set(o_out) - set(n_out))
        only_n = sorted(set(n_out) - set(o_out))
        print(f"   仅旧有 {len(only_o)} 个，仅新有 {len(only_n)} 个（展示前 5 个）:")
        for x in only_o[:5]:
            print("     旧", x)
        for x in only_n[:5]:
            print("     新", x)

    cut_old = [x for x in old if not inside(x[0]) and crossing(x[0], x[1])]
    cut_new = [x for x in new if not inside(x[0]) and crossing(x[0], x[1])]
    changed_tails = []
    for x in cut_old:
        matched = [y[1] - y[0] for y in cut_new if y[0] == x[0] and y[2] == x[2]]
        after_dur = matched[0] if matched else None
        if after_dur is None or abs((x[1] - x[0]) - after_dur) > 0.002:
            changed_tails.append((x, after_dur))
    print(f"\n② 跨窗尾巴截短（合法区外调整）{len(changed_tails)} 个:")
    for x, after_dur in changed_tails:
        after = f"{after_dur:.3f}s" if after_dur is not None else "（已消失）"
        print(f"     pitch {x[2]} @ {x[0]:.3f}s  {x[1] - x[0]:.3f}s → {after}")

    ins = [x for x in new if inside(x[0])]
    oin = [x for x in old if inside(x[0])]
    add = [x for x in ins if x not in oin]
    rem = [x for x in oin if x not in ins]
    print(f"\n③ 编辑窗内: 新增 {len(add)} 个，删除 {len(rem)} 个")
    for x in sorted(add)[:20]:
        print(f"     + {m2.note_name(x[2])}({x[2]}) @ {x[0]:.3f}s")
    return 0 if same else 1
