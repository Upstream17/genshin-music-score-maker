#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""比对两份 MidiJson 的按键区间，证明「外科手术编辑区之外一点没动」。

用法:
    python diff_press_intervals.py 旧.json 新.json --tools <项目>/tools \
        [--windows 115.5-117.3,138.0-141.0]     # 秒（>100000 自动当毫秒）

输出:
    ① 编辑区之外：两版 (start,end,pitch) 列表是否逐一相等
    ② 「尾巴被截短」清单 —— 起点在区外、尾巴跨进区内的音（重拨同键腾位置的合法副作用）
    ③ 区内新增/删除计数
退出码: 0 = 区外完全相同；1 = 有非预期差异（可用于门禁）。
"""
import argparse
import io
import json
import sys


def load(path, m2):
    d = json.load(io.open(path, encoding="utf-8"))
    iv = m2.press_intervals(m2.decode_events(d["notes"]))
    rev = {v: k for k, v in m2.KEYMAP.items()}
    return sorted((round(s / 1000.0, 3), round(e / 1000.0, 3), rev[k])
                  for k, lst in iv.items() for s, e in lst)


def parse_windows(spec):
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        a, b = part.split("-")
        a, b = float(a), float(b)
        if a > 100000:          # 写成毫秒了
            a, b = a / 1000.0, b / 1000.0
        out.append((a, b))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("old")
    ap.add_argument("new")
    ap.add_argument("--tools", required=True, help="项目 tools 目录（含 midi_to_midijson.py）")
    ap.add_argument("--windows", default="", help="编辑窗口，逗号分隔，如 115.5-117.3,138.0-141.0")
    a = ap.parse_args()

    sys.path.insert(0, a.tools)
    import midi_to_midijson as m2                                    # noqa: E402

    W = parse_windows(a.windows)
    if not W:
        print("⚠ 未给 --windows：整份逐键比对")
    old, new = load(a.old, m2), load(a.new, m2)
    print("旧 %d 键｜新 %d 键｜窗口 %d 个" % (len(old), len(new), len(W)))

    inside = lambda t: any(w0 <= t <= w1 for w0, w1 in W)
    crossing = lambda s, e: any((not inside(s)) and w0 < e <= w1 for w0, w1 in W)

    o_out = [x for x in old if not inside(x[0]) and not crossing(x[0], x[1])]
    n_out = [x for x in new if not inside(x[0]) and not crossing(x[0], x[1])]
    print("\n① 编辑区之外：旧 %d vs 新 %d → %s"
          % (len(o_out), len(n_out), "逐键完全一致 ✓" if o_out == n_out else "✗ 有差异"))
    if o_out != n_out:
        only_o = sorted(set(o_out) - set(n_out))
        only_n = sorted(set(n_out) - set(o_out))
        print("   仅旧有 %d 个，仅新有 %d 个（前 5 个）:" % (len(only_o), len(only_n)))
        for x in only_o[:5]:
            print("     旧", x)
        for x in only_n[:5]:
            print("     新", x)

    cut_old = [x for x in old if not inside(x[0]) and crossing(x[0], x[1])]
    cut_new = [x for x in new if not inside(x[0]) and crossing(x[0], x[1])]
    print("\n② 尾巴被截短（合法的区外变动）%d 个:" % len(cut_old))
    for x in cut_old:
        print("     pitch %d @ %.3fs  %.3fs → %s" % (x[2], x[0], x[1] - x[0],
              "%.3fs" % ([y[1] - y[0] for y in cut_new if y[0] == x[0] and y[2] == x[2]] or [0])[0]
              if any(y[0] == x[0] and y[2] == x[2] for y in cut_new) else "（已消失）"))

    ins = [x for x in new if inside(x[0])]
    oin = [x for x in old if inside(x[0])]
    add = [x for x in ins if x not in oin]
    rem = [x for x in oin if x not in ins]
    print("\n③ 区内：新增 %d 个，删除 %d 个" % (len(add), len(rem)))
    for x in sorted(add)[:20]:
        print("     + pitch %d @ %.3fs" % (x[2], x[0]))
    sys.exit(0 if o_out == n_out else 1)


if __name__ == "__main__":
    main()
