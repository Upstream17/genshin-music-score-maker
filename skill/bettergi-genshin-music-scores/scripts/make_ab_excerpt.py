#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把一份成品曲谱里「有争议的几段」剪出来、拼成一段短试听 —— 供多个候选版本 A/B。

为什么需要：一首 2–3 分钟的曲子发 4 个版本给用户听，他得在 4 个全长 mp3 里各找一遍那几个音；
把有争议的时间窗**剪下来拼成一段 30 来秒**，用户一次就能听出差别（实测用户第一遍就能指出差别位置）。

用法（在项目根跑）：
    python skill/bettergi-genshin-music-scores/scripts/make_ab_excerpt.py "output/短对照" \
        --tools tools \
        --win 56000:62500 --win 88000:114000 --gap 7000 \
        --src "1_现在就近挪=output/九儿_v1.json" \
        --src "2_全往下挪=output/九儿_v4.json" \
        --src "3_两键同按=output/九儿_v5.json"
    python tools/render_preview.py "output/短对照" --outdir "output/mp3" --bitrate 64k
然后直接把 mp3 发进聊天让用户 A/B。

⚠⚠ 时间单位：`--win` 写**毫秒**，因为 `midi_to_midijson.press_intervals()` 返回的就是毫秒。
   拿「秒」去比 `ws <= s < we` 不会报错，只会每版剩个位数的音（实测每版只剩 3 个按键）。
   每版跑完都看一遍打印的「剪出 N 按键」——数量明显偏少就是单位或窗口错了。
⚠ 标签（`--src 标签=路径`）要写**实际做法**（「往下挪」「两键同按」），别写「新版/上一版」；
   标签会进文件名和 JSON 的 name，写错了要改文件名（实测把「往上挪」写进文件后才发现方向是上下文决定的）。
"""
import argparse
import io
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir", help="输出目录（每个候选一份短 JSON，随后用 render_preview 渲染）")
    ap.add_argument("--src", action="append", required=True, help="标签=曲谱 JSON 路径（可多次）")
    ap.add_argument("--win", action="append", required=True, help="起:止（**毫秒**），如 56000:62500（可多次）")
    ap.add_argument("--gap", type=int, default=7000, help="两段之间留的毫秒空档（默认 7000）")
    default_tools = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "tools"))
    if not os.path.isdir(default_tools):
        default_tools = "tools"
    ap.add_argument("--tools", default=default_tools,
                    help="项目 tools 目录（里面是 midi_to_midijson.py）")
    a = ap.parse_args()
    sys.path.insert(0, a.tools)
    import midi_to_midijson as m2

    wins = []
    for i, w in enumerate(a.win):
        s, e = (int(x) for x in w.replace("-", ":").split(":"))
        if e <= s:
            sys.exit(f"[x] 窗口不合法: {w}")
        wins.append((s, e, i))
    offs, acc = [], 0
    for s, e, _ in wins:
        offs.append(acc)
        acc += (e - s) + a.gap
    os.makedirs(a.outdir, exist_ok=True)
    REV = {v: k for k, v in m2.KEYMAP.items()}

    for item in a.src:
        label, _, path = item.partition("=")
        label = label.strip()
        if not path:
            sys.exit(f"[x] --src 要写成 标签=路径: {item}")
        d = json.load(io.open(path, encoding="utf-8"))
        iv = m2.press_intervals(m2.decode_events(d["notes"]))
        spans = [(s, e, REV[k]) for k, l in iv.items() for s, e in l]
        new = []
        for ws, we, i in wins:                       # ws/we 是毫秒，spans 也是毫秒
            for s, e, p in spans:
                if ws <= s < we:
                    new.append(((s - ws + offs[i]) / 1000.0,
                                (min(e, we) - ws + offs[i]) / 1000.0, p))
        if not new:
            print(f"[x] {label}: 窗口内没有任何音 —— 先检查窗口单位（要毫秒）和范围")
            continue
        conv, st = m2.convert([(s, e, v, 0, 0) for s, e, v in sorted(new)], "raw", 0)
        ns, _ = m2.to_midijson(conv)
        ok, dev, pairs, miss = m2.verify_intervals(conv, ns)
        span = max(e for _, e, _ in conv)
        out = dict(name=f"{d.get('name', '')} 对照 {label}",
                   author=d.get("author", "MIDI 转换"),
                   instrument=d.get("instrument", "风物之诗琴"), type="midi",
                   description=f"短对照试听（窗口 {a.win}）｜{label}｜源自 {os.path.basename(path)}",
                   time_signature=d.get("time_signature", "4/4"),
                   bpm=d.get("bpm", 60), ticks=d.get("ticks", 1000), notes=ns)
        p_out = os.path.join(a.outdir, f"对比_{label}.json")
        io.open(p_out, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
        print(f"  {label}: 剪出 {len(conv)} 按键｜长 {span:.1f}s｜最大同按 {st['max_chord']}"
              f"｜校验 {'OK' if ok else 'FAIL'} dev={dev:.1f}ms miss={miss} → {p_out}")
    print("\n下一步：python tools/render_preview.py \"%s\" --outdir <mp3目录> --bitrate 64k" % a.outdir)


if __name__ == "__main__":
    main()
