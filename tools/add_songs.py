#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add_songs.py — 将 MIDI (.mid/.midi) 转换为 BetterGI 21 键 `midi` JSON
========================================================================
面向单个或批量 MIDI 文件转换：支持音轨分析、按轨筛选、限制最大同时按键、
整体移调、解析器级强校验，并输出到指定目录（默认 ./output/）。

用法
  python tools/add_songs.py song.mid
  python tools/add_songs.py midi_dir/ --outdir output
  python tools/add_songs.py song.mid --tracks 0 --transpose -12 --name "曲名"
  python tools/add_songs.py song.mid --melody-only
  python tools/add_songs.py song.mid --max-keys 6
  python tools/add_songs.py song.mid --dry-run
  python tools/add_songs.py --list-tracks song.mid
"""

import os, sys, re, json, argparse, collections, importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE) if os.path.basename(_HERE) == "tools" else _HERE
DEFAULT_OUTDIR = os.path.join(ROOT, "output")

# 复用 MIDI 转换器（SMF 解析 / 八度折叠 / 半音吸附 / 校验）
_spec = importlib.util.spec_from_file_location("m2j", os.path.join(_HERE, "midi_to_midijson.py"))
m2j = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m2j)
KEYMAP = m2j.KEYMAP
KEYS = set(KEYMAP.values())

TAG = ""
GENERIC_TRACK = re.compile(r"^(track|轨道|melody|piano|声部|conductor|tempo|untitled|\d+)$", re.I)


def load_midi(path):
    info = m2j.parse_smf(path)
    return info["notes"], dict(kind="MIDI(.mid)", div=info["div"],
                               last=info["last"], names=info["names"]), None


def load_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".mid", ".midi"):
        return load_midi(path)
    raise ValueError(f"不支持的格式 {ext}（仅支持 .mid / .midi）")


# ---------------- 轨道选择 / 限流 ----------------
def track_table(notes, names):
    tab = collections.defaultdict(list)
    for s, e, p, ti, ch in notes:
        tab[ti].append((p, ch))
    rows = []
    for ti in sorted(tab):
        ps = [p for p, _ in tab[ti]]
        ch = collections.Counter(c for _, c in tab[ti])
        name = names[ti] if ti < len(names) else f"轨道{ti+1}"
        rows.append(dict(idx=ti, name=name, n=len(ps),
                         lo=min(ps), hi=max(ps),
                         avg=sum(ps) / len(ps), chans=dict(ch)))
    return rows


def pick_tracks(notes, tracks_arg, melody_only):
    if melody_only:
        tab = collections.Counter(ti for *_, ti, _ in notes)
        keep = {tab.most_common(1)[0][0]}
    elif tracks_arg:
        keep = {int(x) for x in tracks_arg.split(",") if x.strip() != ""}
    else:
        keep = None
    if keep is None:
        return notes
    return [n for n in notes if n[3] in keep]


def cap_polyphony(notes, max_keys):
    """同刻最多按 N 个键：按起始时刻分组，超出时丢掉最低音（旋律通常在高声部）"""
    if not max_keys:
        return notes, 0
    groups = collections.defaultdict(list)
    for n in notes:
        groups[round(n[0] * 1000)].append(n)
    kept, dropped = [], 0
    for t, g in groups.items():
        if len(g) <= max_keys:
            kept.extend(g)
        else:
            g2 = sorted(g, key=lambda x: -x[2])[:max_keys]
            kept.extend(g2)
            dropped += len(g) - len(g2)
    return kept, dropped


# ---------------- 导入 ----------------
def safe_name(s):
    s = re.sub(r"[\\/:*?\"<>|]", "_", (s or "").strip())
    return s[:120] or "未命名"


def guess_title(path, meta_title):
    if meta_title and not GENERIC_TRACK.match(meta_title.strip()):
        return safe_name(meta_title)
    return safe_name(os.path.splitext(os.path.basename(path))[0])


def import_one(path, args):
    print("=" * 74)
    print("输入：", path)
    try:
        notes, info, meta_title = load_any(path)
    except Exception as ex:
        print(f"  [x] 解析失败：{ex}")
        return None
    if not notes:
        print("  [x] 文件里没有音符")
        return None

    rows = track_table(notes, info["names"])
    print(f"  格式 {info['kind']}｜音轨 {len(rows)}｜音符 {len(notes)}｜"
          f"原时长 {info['last']:.1f}s｜速度基准 div={info['div']}")
    for r in rows:
        print(f"    轨{r['idx']:>2} {r['name'][:28]:30s} {r['n']:6d} 音  音域 {r['lo']}-{r['hi']} "
              f"(均 {r['avg']:.0f})  通道 {sorted(r['chans'])}")
    if args.list_tracks:
        return None

    notes = pick_tracks(notes, args.tracks, args.melody_only)
    if not notes:
        print("  [x] 选轨后没有音符了")
        return None
    notes, capped = cap_polyphony(notes, args.max_keys)

    intervals, st = m2j.convert(notes, "snap", args.transpose)
    notes_str, events = m2j.to_midijson(intervals)

    # 写文件前自校验：复刻解析器重放 + 逐键比对按下区间（能抓按下/抬起写反、时间轴漂移）
    try:
        back = m2j.replay(notes_str, m2j.JSON_BPM, m2j.JSON_TICKS)
        okv, dev, pairs, miss = m2j.verify_intervals(intervals, notes_str)
    except Exception as ex:
        print(f"  [x] 自校验失败，未写入：{ex}")
        return None
    ks = {k for _, kk, _ in back for k in kk}
    if ks - KEYS or not okv:
        print(f"  [x] 自校验失败（越界按键 {sorted(ks - KEYS)}｜区间偏差 {dev:.0f}ms/缺 {miss}），未写入")
        return None
    print(f"  自校验：{pairs} 个按键区间与源谱一致，最大偏差 {dev:.0f}ms ✅")

    base_title = re.sub(r"\s{2,}", " ", (args.name or guess_title(path, meta_title))).strip()
    title = base_title if base_title.endswith(TAG) else base_title + TAG
    outdir = os.path.abspath(args.outdir)
    out = os.path.join(outdir, title + ".json")
    dup = ""
    if os.path.exists(out):
        dup = "（覆盖同名旧文件）"
    print(f"  映射：原可演奏 {st['orig_ok'] / st['total'] * 100:.1f}% → 100%"
          f"｜八度折叠 {st['folded']}｜半音吸附 ↑{st['snapped_up']}/↓{st['snapped_down']}"
          f"｜同键合并 {st['merged']}｜最大同按 {st['max_chord']} 键"
          + (f"｜限流丢弃 {capped} 音" if capped else ""))
    print(f"  输出：{out} {dup}")

    if args.dry_run:
        print("  （--dry-run：未写文件）")
        return None

    os.makedirs(outdir, exist_ok=True)
    artist = (info.get("artist") or "").strip()
    src_txt = f"源：{info['kind']}｜原文件：{os.path.basename(path)}"
    doc = {
        "name": title,
        "author": artist if artist else "MIDI 转换",
        "instrument": "风物之诗琴",
        "type": "midi",
        "description": (f"{src_txt}｜原音符 {st['total']}，可演奏 {st['mapped_notes']}，"
                        f"八度折叠 {st['folded']}，半音吸附 ↑{st['snapped_up']}/↓{st['snapped_down']}，"
                        f"原映射率 {st['orig_ok'] / st['total'] * 100:.1f}%，转换后 100%"),
        "time_signature": "4/4",
        "bpm": str(m2j.JSON_BPM),
        "ticks": str(m2j.JSON_TICKS),
        "notes": notes_str,
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    return out


def collect_inputs(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if os.path.splitext(f)[1].lower() in (".mid", ".midi"):
                    out.append(os.path.join(p, f))
        else:
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser(description="将 MIDI (.mid/.midi) 转换为 BetterGI 21 键 midi JSON")
    ap.add_argument("paths", nargs="*", help="MIDI 文件或包含 .mid/.midi 的目录")
    ap.add_argument("--outdir", default=DEFAULT_OUTDIR, help="输出目录（默认 ./output/）")
    ap.add_argument("--name", help="指定输出曲名（默认取文件名）")
    ap.add_argument("--transpose", type=int, default=0, help="整体移调半音数")
    ap.add_argument("--tracks", help="只保留指定轨道，如 0 或 0,3")
    ap.add_argument("--melody-only", action="store_true", help="自动只留音符最多的那一轨")
    ap.add_argument("--max-keys", type=int, default=0, help="同刻最多按键数（0=不限）")
    ap.add_argument("--dry-run", action="store_true", help="只分析不写文件")
    ap.add_argument("--list-tracks", action="store_true", help="只列出各轨统计")
    args = ap.parse_args()

    if not args.paths:
        ap.print_help()
        return 2
    files = collect_inputs(args.paths)
    if not files:
        print("[x] 没找到 .mid/.midi 文件")
        return 2

    written = []
    for f in files:
        out = import_one(f, args)
        if out:
            written.append(out)

    print("=" * 74)
    if not written:
        print("没有曲目被写入。")
        return 0
    if not args.dry_run:
        print(f"已写入 {len(written)} 首 → {os.path.abspath(args.outdir)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
