#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""光遇 Sky 谱 → 原神 21 键 MidiJson 批量迁移（试验用，不碰 library-private/）。

用法:
    python sky_batch_migrate.py --src <Songs 目录> --out <输出目录> --recon 300   # 抽样侦察，不写文件
    python sky_batch_migrate.py --src <Songs 目录> --out <输出目录>               # 全量迁移
    python sky_batch_migrate.py --src <Songs 目录> --out <输出目录> --limit 200   # 只跑前 200 个

档位（写进报告，决定落到哪个子目录）:
    A_丝滑   原谱 100% 落在 21 键内、零折叠零吸附、时长 ≥25s、密度 ≤8 音/秒
    B_可弹   能 100% 弹出来，但有八度折叠或半音吸附
    C_不适合 解析失败 / 音符太少 / 太短 / 密度过高 / 多乐器谱（需两人以上合奏）
"""
import argparse
import csv
import json
import os
import re
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import add_songs as A                                     # 复用四种 Sky 格式的解析器
import midi_to_midijson as m2j                            # 复用转换器 + 强校验

KEYS = set(m2j.KEYMAP.values())
TAG = ""
AUTHOR_TAG = "Hermes"


def safe(s):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', " ", s or "").strip(" .")
    s = re.sub(r"\s{2,}", " ", s)
    return (s or "未命名")[:80]


def convert_file(path, out_root, write=True, seen=None):
    """返回一行报告 dict；write=True 时同时落盘。"""
    rel = os.path.relpath(path, SRC)
    row = dict(rel=rel, title="", artist="", tracks=0, notes=0, dur=0.0, density=0.0,
               orig_rate=0.0, folded=0, snapped=0, chord=0, merged=0, tier="C", why="", out="")
    try:
        notes, info, meta_title = A.load_any(path)
    except Exception as ex:
        row["why"] = f"解析失败：{type(ex).__name__} {ex}"[:90]
        return row
    if not notes:
        row["why"] = "文件里没有音符"
        return row

    row["tracks"] = len(info.get("names") or [])
    row["notes"] = len(notes)
    row["dur"] = round(info.get("last") or 0, 1)
    row["artist"] = (info.get("artist") or "").strip()

    if row["tracks"] > 1:
        row["why"] = f"多乐器谱（{row['tracks']} 个谱面，需多人合奏）"
        return row

    intervals, st = m2j.convert(notes, "snap", 0)
    notes_str, _ = m2j.to_midijson(intervals)
    back = m2j.replay(notes_str, m2j.JSON_BPM, m2j.JSON_TICKS)
    okv, dev, pairs, miss = m2j.verify_intervals(intervals, notes_str)
    ks = {k for _, kk, _ in back for k in kk}
    if ks - KEYS or not okv or miss:
        row["why"] = f"自校验失败（越界 {sorted(ks - KEYS)}｜偏差 {dev:.0f}ms｜缺 {miss}）"[:90]
        return row

    total = st["total"] or 1
    row.update(orig_rate=round(st["orig_ok"] / total * 100, 1), folded=st["folded"],
               snapped=st["snapped_up"] + st["snapped_down"], chord=st["max_chord"],
               merged=st["merged"])
    row["density"] = round(len(intervals) / max(row["dur"], 0.001), 2)
    title = safe(meta_title or os.path.splitext(os.path.basename(path))[0])
    row["title"] = title

    # —— 档位判定 ——
    # 光遇 15 键 = C4–C6，原神 21 键 = C3–B5：只差「最高那个 C6」超出上限，往下折一个八度即可。
    # 两边都是纯 C 大调，所以正常谱**不该有半音吸附**（实测 0）——有吸附说明谱本身带变化音，需人工听。
    if row["density"] > 10:
        row["tier"], row["why"] = "D", f"密度过高（{row['density']:.1f} 音/秒），弹起来会糊"
    elif row["notes"] < 30 or row["density"] < 1.0:
        # 空谱/残留标记音：几十个音拖几百秒，时长长但没内容（评分器会给它高分，必须在这里拦掉）
        row["tier"], row["why"] = "D", f"几乎没有内容（{int(row['notes'])} 音 / {row['dur']:.0f}s，密度 {row['density']:.2f}）"
    elif row["snapped"] > 0:
        row["tier"], row["why"] = "D", f"含变化音，半音吸附 {row['snapped']} 处，音高会变"
    elif row["dur"] < 25:
        row["tier"], row["why"] = "C", f"短曲（{row['dur']:.0f}s，可弹但太短）"
    elif row["folded"] == 0:
        row["tier"], row["why"] = "A", "零改动"
    else:
        row["tier"], row["why"] = "B", f"仅最高音折叠 {row['folded']} 处"

    if not write:
        return row

    sub = {"A": "A_丝滑完美", "B": "B_仅折叠最高音", "C": "C_短曲", "D": "D_不适合"}[row["tier"]]
    if row["tier"] == "D":
        return row
    outdir = os.path.join(out_root, sub)
    os.makedirs(outdir, exist_ok=True)
    # 文件名必须唯一：同名（含不同语区/分叉）依次加「（2）（3）…」，绝不允许覆盖
    fname = title + TAG + ".json"
    if seen is not None:
        # ⚠ Windows 文件名大小写不敏感 + 结尾点/空格被吃掉 → 必须用 lower() 去重，
        #   并用 os.path.exists 兜底（seen 只记录本次运行写过的名字）。
        bucket = safe(rel.split(os.sep)[0])

        def taken(nm):
            return (sub, nm.lower()) in seen or os.path.exists(os.path.join(outdir, nm))

        if taken(fname):
            fname = f"{title}（{bucket}）{TAG}.json"
        n = 2
        while taken(fname):
            fname = f"{title}（{bucket}-{n}）{TAG}.json"
            n += 1
        seen.add((sub, fname.lower()))
    artist = row["artist"]
    doc = {
        "name": title + TAG,
        "author": f"{artist} | {AUTHOR_TAG} 转换" if artist else f"{AUTHOR_TAG} 转换",
        "instrument": "风物之诗琴",
        "type": "midi",
        "description": (f"源：光遇 Sky Studio 谱｜原文件：{rel}"
                        f"｜原音符 {st['total']}，可演奏 {st['mapped_notes']}，八度折叠 {st['folded']}，"
                        f"半音吸附 ↑{st['snapped_up']}/↓{st['snapped_down']}，原映射率 {row['orig_rate']}%，转换后 100%"
                        f"｜时长 {row['dur']:.0f}s，密度 {row['density']} 音/秒，最大同按 {st['max_chord']} 键"),
        "time_signature": "4/4",
        "bpm": str(m2j.JSON_BPM),
        "ticks": str(m2j.JSON_TICKS),
        "notes": notes_str,
    }
    with open(os.path.join(outdir, fname), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    row["out"] = os.path.join(sub, fname)          # 记录输出文件名，方便后续按报告精确取文件
    return row


def walk(src):
    out = []
    for dirpath, _, files in os.walk(src):
        for f in files:
            if f.lower().endswith((".txt", ".json")) and f != ".gitkeep":
                out.append(os.path.join(dirpath, f))
    return sorted(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="Sky1984 合集的 Songs 目录")
    ap.add_argument("--out", required=True, help="输出目录（试验用，单独一个文件夹）")
    ap.add_argument("--recon", type=int, default=0, help="只抽样 N 个文件做侦察，不写 JSON")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 个")
    ap.add_argument("--step", type=int, default=1, help="抽样步长（配合 --recon 用大范围覆盖）")
    ap.add_argument("--report", default="", help="报告 CSV 路径")
    args = ap.parse_args()

    global SRC
    SRC = args.src
    files = walk(args.src)
    if args.limit:
        files = files[:args.limit]
    if args.recon:
        files = files[::args.step][:args.recon]
    print(f"待处理 {len(files)} 个文件（src={args.src}）")

    rep = args.report or os.path.join(args.out, "迁移报告.csv" if not args.recon else "侦察报告.csv")
    os.makedirs(os.path.dirname(rep) or ".", exist_ok=True)
    seen, rows, t0 = set(), [], time.time()
    tier = Counter()
    with open(rep, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["档位", "相对路径", "曲名", "原作者", "谱面数", "音符", "时长s", "密度音每秒",
                    "原映射率%", "八度折叠", "半音吸附", "最大同按", "同键合并", "输出文件", "备注"])
        for i, p in enumerate(files, 1):
            try:
                r = convert_file(p, args.out, write=not args.recon, seen=seen)
            except Exception as ex:
                r = dict(rel=os.path.relpath(p, SRC), tier="C", why=f"异常 {type(ex).__name__}: {ex}"[:90],
                         title="", artist="", tracks=0, notes=0, dur=0, density=0, orig_rate=0,
                         folded=0, snapped=0, chord=0, merged=0, out="")
            rows.append(r)
            tier[r["tier"]] += 1
            w.writerow([r["tier"], r["rel"], r["title"], r["artist"], r["tracks"], r["notes"],
                        r["dur"], r["density"], r["orig_rate"], r["folded"], r["snapped"],
                        r["chord"], r["merged"], r.get("out", ""), r["why"]])
            if i % 1000 == 0:
                el = time.time() - t0
                print(f"  {i}/{len(files)}  {el:.0f}s  预计总 {el / i * len(files):.0f}s  "
                      f"A={tier['A']} B={tier['B']} C={tier['C']}", flush=True)

    n = len(rows) or 1
    print(f"\n=== 完成 {len(rows)} 个，用时 {time.time() - t0:.0f}s ===")
    for k, lab in (("A", "A 丝滑完美（零改动）"), ("B", "B 仅折叠最高音"), ("C", "C 短曲"), ("D", "D 不适合")):
        print(f"  {lab:22s} {tier[k]:6d}  {tier[k] / n * 100:5.1f}%")
    reasons = Counter(re.sub(r"\d+", "N", r["why"])[:40] for r in rows if r["tier"] == "D" and r["why"])
    print("\n  D（不适合）的原因分布:")
    for k, v in reasons.most_common(10):
        print(f"    {v:5d}  {k}")
    good = [r for r in rows if r["tier"] in ("A", "B", "C")]
    if good:
        ds = sorted(r["dur"] for r in good)
        dens = sorted(r["density"] for r in good)
        print(f"\n  可弹曲目 时长 中位 {ds[len(ds) // 2]:.0f}s（最短 {ds[0]:.0f}s 最长 {ds[-1]:.0f}s）"
              f"｜密度 中位 {dens[len(dens) // 2]:.1f} 音/秒（最高 {dens[-1]:.1f}）")
    print(f"\n报告：{rep}")


if __name__ == "__main__":
    main()
