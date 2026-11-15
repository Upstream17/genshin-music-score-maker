#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""MidiJson 整体平移（默认降八度 −12）：把偏高八度的谱面搬进含低音区（C3–B5）。

为什么需要它：
    部分高音区编曲主要落在 C4–C6，**一个低音键（Z X C V B N M）都没有**，听感容易偏飘。
    把整首**降八度**（−12）→ C3–C5，正好落进原神 21 键低音+中音区，且不破坏 C 大调音阶结构。

为什么平移而不是重转：
    只允许 ±12（换别的半音数会破坏 C 大调 → 出现变化音、被吸附成错音）。
    而 −12 对 C4–C6 是**一一映射**：每个音都仍落在 21 键表里，不触发折叠/吸附/合并，
    所以「改键字母」与「用 transpose=−12 重新转换」结果完全一致 —— 但省掉重解析源谱。

校验（每首必过，不通过就不写盘）：
    ① 平移后所有键 ⊆ 21 键；② 按下/抬起事件数与按键总数与原版逐一相等；
    ③ 强校验：把平移后的谱交给 midi_to_midijson.verify_intervals 重放比对按下区间，
       最大偏差 ≤2ms 且无缺失（能抓出 D/U 写反、时间轴漂移）。

用法:
    python transpose_midijson.py <输入目录或文件...> --semitones -12 --outdir <输出目录>
    python transpose_midijson.py <...> --semitones -12 --outdir <...> --limit 50   # 试跑
"""
import argparse
import csv
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import midi_to_midijson as m2                       # 复用 KEYMAP / 强校验

REV = {v: k for k, v in m2.KEYMAP.items()}          # "Z" -> 48
PITCHES = set(m2.KEYMAP.keys())                     # {48,50,…,83}：m2.KEYMAP 是 音高->键字母，键才是音高
PART = re.compile(r"^([DU])([A-Z@]+)(\d+)$")
LOW = set("ZXCVBNM")


def shift(notes_str, semis):
    """整体平移 semis 个半音；@ 占位符原样保留。越界抛错。"""
    out = []
    for part in notes_str.split("|"):
        m = PART.match(part)
        if not m:
            out.append(part)
            continue
        st, keys, dt = m.group(1), m.group(2), m.group(3)
        nk = []
        for k in keys:
            if k == "@":
                nk.append("@")
                continue
            p = REV[k] + semis
            if p not in PITCHES:
                raise ValueError(f"键 {k}(音高 {REV[k]}) 平移 {semis} 后越界")
            nk.append(m2.KEYMAP[p])
        out.append(f"{st}{''.join(nk)}{dt}")
    return "|".join(out)


def stats(notes_str):
    """(按下数, 抬起数, 按键总数, 低音键数)"""
    d = u = tot = low = 0
    for part in notes_str.split("|"):
        m = PART.match(part)
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
            if k in LOW:
                low += 1
    return d, u, tot, low


def to_intervals(notes_str):
    iv = m2.press_intervals(m2.decode_events(notes_str))
    return [(s / 1000.0, e / 1000.0, REV[k]) for k, v in iv.items() for s, e in v]


def convert_file(path, outdir, semis, rel):
    """返回报告行 (list)。"""
    row = [rel, "", 0, 0, 0, "", ""]
    try:
        raw = open(path, "r", encoding="utf-8-sig").read()
        j = json.loads(raw)
    except Exception as ex:
        row[5], row[6] = "失败", f"读取/解析：{type(ex).__name__} {ex}"[:90]
        return row
    if not isinstance(j, dict) or not isinstance(j.get("notes"), str):
        row[5], row[6] = "跳过", "不是 type:midi 的 MidiJson（notes 非字符串）"
        return row
    notes = j["notes"]
    row[1] = str(j.get("name") or "")
    try:
        new = shift(notes, semis)
    except Exception as ex:
        row[5], row[6] = "失败", str(ex)[:90]
        return row

    od, ou, ot, olow = stats(notes)
    nd, nu, nt, nlow = stats(new)
    if (od, ou, ot) != (nd, nu, nt):
        row[5], row[6] = "失败", f"事件数不一致：{od}/{ou}/{ot} → {nd}/{nu}/{nt}"
        return row

    ok, dev, pairs, miss = m2.verify_intervals(to_intervals(new), new)
    if not ok:
        row[5], row[6] = "失败", f"强校验不过：偏差 {dev:.0f}ms｜缺 {miss}"
        return row

    j["notes"] = new
    j["description"] = ((str(j.get("description") or "").rstrip("｜|"))
                        + f"｜整体移调（{semis} 半音）：零折叠零吸附；低音键 {olow} → {nlow}")
    outp = os.path.join(outdir, rel)
    os.makedirs(os.path.dirname(outp), exist_ok=True)
    with open(outp, "w", encoding="utf-8") as f:
        json.dump(j, f, ensure_ascii=False, indent=1)
    row[2], row[3], row[4] = ot, olow, nlow
    row[5], row[6] = "OK", f"偏差 {dev:.0f}ms"
    return row


def collect(inputs):
    out = []
    for p in inputs:
        p = os.path.abspath(p)
        if os.path.isdir(p):
            for dp, _, fs in os.walk(p):
                for f in sorted(fs):
                    if f.endswith(".json"):
                        fp = os.path.join(dp, f)
                        out.append((fp, os.path.relpath(fp, p)))
        elif os.path.isfile(p):
            out.append((p, os.path.basename(p)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--semitones", type=int, default=-12)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--report", default="")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个（试跑）")
    a = ap.parse_args()

    items = collect(a.inputs)
    if a.limit:
        items = items[:a.limit]
    os.makedirs(a.outdir, exist_ok=True)
    print(f"[平移] {a.semitones} 半音 | 待处理 {len(items)} 个 -> {a.outdir}", flush=True)

    rows, ok, bad, tot_in, tot_out = [], 0, 0, 0, 0
    for i, (fp, rel) in enumerate(items, 1):
        r = convert_file(fp, a.outdir, a.semitones, rel)
        rows.append(r)
        if r[5] == "OK":
            ok += 1
            tot_in += r[2]; tot_out += r[4]
        else:
            bad += 1
            if bad <= 20:
                print(f"  [!] {rel} -> {r[5]} {r[6]}", flush=True)
        if i % 1000 == 0:
            print(f"  … {i}/{len(items)}  已写 {ok} 失败 {bad}", flush=True)

    if a.report:
        with open(a.report, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["相对路径", "曲名", "按键总数", "低音键(改前)", "低音键(改后)", "结果", "备注"])
            w.writerows(rows)
    print(f"[平移] 完成：成功 {ok} / 失败 {bad}；低音键 {tot_in} -> {tot_out}"
          f"（占全部按键 {tot_out/max(sum(r[2] for r in rows if r[5]=='OK'),1)*100:.1f}%）", flush=True)
    if a.report:
        print(f"[平移] 报告 {a.report}", flush=True)


if __name__ == "__main__":
    main()
