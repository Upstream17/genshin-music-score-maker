#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add_songs.py — 把「任意来源的谱子」导入曲库（library-private/）
==============================================
曲库扩展的唯一缺的是什么：源。这个脚本负责「源 → 曲库」这最后一步。

支持的输入格式
  .mid / .midi  标准 MIDI —— 任意来源：midishow / MuseScore / Sky Studio 导出 / 手机自动弹琴 App 导出
  .json         光遇 Sky Studio 谱（{songs:[{notes:[{time,key:"1Key0"}]}]}）
                ⭐ 光遇 15 键与原神 21 键**都是纯 C 大调**，跨游戏转换几乎无损，是最省事的源
  .txt          MRevenger 键谱（第 1 行 = 一拍秒数）

用法
  python add_songs.py 蓝莲花.mid
  python add_songs.py 下载目录/                     # 批量导入目录下所有谱子
  python add_songs.py 等你下课.mid --tracks 0       # 多轨 MIDI 只留轨道 0（主旋律）
  python add_songs.py xxx.mid --melody-only         # 自动挑音符最多的那轨
  python add_songs.py xxx.mid --transpose -12       # 整体降八度
  python add_songs.py xxx.mid --max-keys 6          # 同刻最多按 6 个键（超出丢最低音）
  python add_songs.py xxx.mid --dry-run             # 只看分析结果，不写文件
  python add_songs.py --list-tracks xxx.mid         # 只看每轨统计，帮你决定留下哪轨

输出：library-private/<--to 指定的子目录，默认 05_我的新增>/<曲名>.json
     （merge_library.py 不会动 05_我的新增/，那里放你自己加的曲子最安全）
"""

import os, sys, re, json, csv, argparse, collections, importlib.util

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE) if os.path.basename(_HERE) == "tools" else _HERE
REPORTS = os.path.join(ROOT, "reports")
LIB = os.path.join(ROOT, "library-private")
DEFAULT_TO = "05_我的新增"
MANIFEST = os.path.join(REPORTS, "library-manifest.csv")

# 复用 MIDI 转换器（SMF 解析 / 八度折叠 / 半音吸附 / 校验）
_spec = importlib.util.spec_from_file_location("m2j", os.path.join(_HERE, "midi_to_midijson.py"))
m2j = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m2j)
KEYMAP = m2j.KEYMAP
KEYS = set(KEYMAP.values())

# 标题只用曲名（与 merge_library.py 的 TAG="" 保持一致）；归属信息只写进 author 字段
TAG = ""

# 光遇 15 键 = C 大调两个八度 + 1（C4..C6）；原神 21 键 = C3..B5
SKY_PITCHES = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84]

GENERIC_TRACK = re.compile(r"^(track|轨道|melody|piano|声部|conductor|tempo|untitled|\d+)$", re.I)


# ---------------- 各格式 → 统一音符表 [(start_s, end_s, pitch, track, channel)] ----------------
def load_midi(path):
    info = m2j.parse_smf(path)
    return info["notes"], dict(kind="MIDI(.mid)", div=info["div"],
                               last=info["last"], names=info["names"]), None


def load_sky_json(path):
    """光遇 Sky Studio 谱 → 统一音符表。支持四种形态（Sky1984 合集用的是前两种）：
       · 顶层 JSON 数组（Sky1984 / 多曲合集）
       · {"songs":[...]}（多曲） / 单曲 dict
       · v3 composed：songNotes=[{"key":"1Key4","time":100}]
       · v2 recorded：notes=[[keyIdx, timeMs, "1"], ...]
    Sky 时间单位是毫秒；谱只给按下时刻，按住时长取到下一个音的间隔。"""
    j = json.load(open(path, encoding="utf-8-sig"))
    if isinstance(j, list):
        songs = j
    elif isinstance(j, dict) and j.get("songs"):
        songs = j["songs"]
    elif isinstance(j, dict):
        songs = [j]
    else:
        raise ValueError("不是 Sky Studio 谱（顶层既不是数组也不是对象）")
    notes = []
    for si, song in enumerate(songs):
        ev = []

        def _push(key, t_ms):
            mt = re.search(r"(\d+)\s*$", str(key))
            if mt and 0 <= int(mt.group(1)) < len(SKY_PITCHES):
                ev.append((float(t_ms) / 1000.0, SKY_PITCHES[int(mt.group(1))]))

        # 注意：有些文件 notes 与 songNotes 同时存在且内容重复 → 只用其一，避免音符翻倍
        sn = song.get("songNotes") or []
        if sn:
            for n in sn:                                 # v3 composed
                if isinstance(n, dict):
                    _push(n.get("key", ""), n.get("time", 0))
        else:
            for n in (song.get("notes") or []):           # v2 recorded / 单曲
                if isinstance(n, (list, tuple)) and len(n) >= 2:
                    idx = int(n[0])
                    if 0 <= idx < len(SKY_PITCHES):
                        ev.append((float(n[1]) / 1000.0, SKY_PITCHES[idx]))
                elif isinstance(n, dict):
                    _push(n.get("key", ""), n.get("time", 0))
        ev.sort()
        ev = sorted(set(ev))                              # 去重（同刻同音只留一个）
        for k, (t, p) in enumerate(ev):                  # 按住时长取到下一个音的间隔
            end = ev[k + 1][0] if k + 1 < len(ev) else t + 0.5
            notes.append((t, end, p, si, 0))
    if not notes:
        raise ValueError("谱里没有可识别音符")
    head = songs[0] if songs else {}
    return notes, dict(kind="光遇 Sky Studio JSON", div=None,
                       last=max(e for _, e, _, _, _ in notes),
                       artist=(head.get("author") or "").strip(),           # 原曲作者（Sky 谱自带）
                       transcriber=(head.get("transcribedBy") or "").strip(),
                       names=[s.get("name") or f"光遇轨道{si+1}" for si, s in enumerate(songs)]), \
        (head.get("name") if songs else None)


def load_txt(path):
    """MRevenger 键谱 → 先转成 midi-JSON（复用 convert_dedupe 的逻辑），再反解成音符表。"""
    cd_spec = importlib.util.spec_from_file_location("cd", os.path.join(_HERE, "convert_dedupe.py"))
    cd = importlib.util.module_from_spec(cd_spec)
    cd_spec.loader.exec_module(cd)
    text = open(path, encoding="utf-8-sig", errors="replace").read()
    chords, part = cd.parse_txt(text)
    nums = [n for i, (keys, atoms) in enumerate(chords) for n in _keys_to_pitch(keys)]
    ev, t = [], 0.0
    for keys, atoms in chords:
        dur = atoms * part / 4.0                      # 1 原子 = 1/4 拍
        for ch in keys:
            p = _letter_to_pitch(ch)
            if p is not None:
                ev.append((t, t + dur, p, 0, 0))
        t += dur
    if not ev:
        raise ValueError("键谱里没有可识别音符")
    return ev, dict(kind="MRevenger 键谱(.txt)", div=None, last=t, names=["键谱"]), None


def _letter_to_pitch(ch):
    """风物之诗琴键位字母 → MIDI 音高（键谱用的就是这套键位）"""
    rev = {v: k for k, v in KEYMAP.items()}
    return rev.get(ch.upper())


def _keys_to_pitch(keys):
    out = []
    for ch in keys:
        p = _letter_to_pitch(ch)
        if p is not None:
            out.append(p)
    return out


def load_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".mid", ".midi"):
        return load_midi(path)
    if ext == ".json":
        return load_sky_json(path)
    if ext == ".txt":
        # Sky1984 合集的 .txt 里其实是 Sky Studio JSON —— 按内容嗅探，不能只看扩展名
        with open(path, "rb") as fh:
            head = fh.read(1)
        if head in (b"[", b"{"):
            return load_sky_json(path)
        return load_txt(path)
    raise ValueError(f"不支持的格式 {ext}（支持 .mid/.midi/.json(光遇)/.txt(键谱)）")


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


def append_manifest(rows):
    """把新曲目追加进 library-manifest.csv（保留原表头；被占用则退化为 _new）"""
    def dump(p, existing):
        with open(p, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["曲名", "文件名", "所在目录", "类型", "来源", "可演奏率", "备注"])
            w.writerows(existing)
            w.writerows(rows)
    try:
        existing = []
        if os.path.exists(MANIFEST):
            existing = list(csv.reader(open(MANIFEST, encoding="utf-8-sig")))[1:]
            existing = [r for r in existing if len(r) >= 7]
        dump(MANIFEST, existing)
        return MANIFEST
    except PermissionError:
        alt = MANIFEST[:-4] + "_new.csv"
        dump(alt, existing)
        return alt


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
    outdir = os.path.join(LIB, args.to)
    out = os.path.join(outdir, title + ".json")
    dup = ""
    if os.path.exists(out):
        dup = "（覆盖同名旧文件）"
    lose = st["total"] - st["mapped_notes"]
    print(f"  映射：原可演奏 {st['orig_ok'] / st['total'] * 100:.1f}% → 100%"
          f"｜八度折叠 {st['folded']}｜半音吸附 ↑{st['snapped_up']}/↓{st['snapped_down']}"
          f"｜同键合并 {st['merged']}｜最大同按 {st['max_chord']} 键"
          + (f"｜限流丢弃 {capped} 音" if capped else ""))
    print(f"  输出：{os.path.relpath(out, ROOT)} {dup}")

    if args.dry_run:
        print("  （--dry-run：未写文件）")
        return None

    os.makedirs(outdir, exist_ok=True)
    artist = (info.get("artist") or "").strip()
    src_txt = f"源：{info['kind']}｜原文件：{os.path.basename(path)}"
    if info.get("transcriber"):
        src_txt += f"（转录：{info['transcriber']}）"
    doc = {
        "name": title,
        # 规范：第一作者（原曲作者）排前面，再写我方转换信息；没有作者元数据时就只写转换信息
        "author": f"{artist} | Hermes 转换" if artist else "Hermes 转换",
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
    return dict(title=title, file=title + ".json", sub=args.to, kind="MIDI JSON(外部导入)",
                src=os.path.basename(path), rate="100.0%",
                note=f"来源 {info['kind']}｜{info['last']:.0f}s｜原可演奏 "
                     f"{st['orig_ok'] / st['total'] * 100:.1f}%（丢约 {lose} 音）"
                     f"｜折叠 {st['folded']}｜吸附 {st['snapped_up'] + st['snapped_down']}"
                     f"｜最大同按 {st['max_chord']} 键")


def collect_inputs(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if os.path.splitext(f)[1].lower() in (".mid", ".midi", ".json", ".txt"):
                    out.append(os.path.join(p, f))
        else:
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser(description="把任意来源的谱子导入曲库（library-private/）")
    ap.add_argument("paths", nargs="*", help="谱子文件或目录（.mid/.midi/.json/.txt）")
    ap.add_argument("--to", default=DEFAULT_TO, help=f"曲库内子目录（默认 {DEFAULT_TO}）")
    ap.add_argument("--name", help="指定曲名（默认取 MIDI 元信息 / 文件名）")
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
        print("[x] 没找到可导入的谱子（.mid/.midi/.json/.txt）")
        return 2

    rows = []
    for f in files:
        r = import_one(f, args)
        if r:
            rows.append([r["title"], r["file"], r["sub"], r["kind"], r["src"], r["rate"], r["note"]])

    print("=" * 74)
    if not rows:
        print("没有曲目被写入。")
        return 0
    if not args.dry_run:
        man = append_manifest(rows)
        print(f"已写入 {len(rows)} 首 → {os.path.relpath(os.path.join(LIB, args.to), ROOT)}")
        print(f"清单已更新：{os.path.relpath(man, ROOT)}")
        print("挂载点：BetterGI → 选择曲谱目录 → library-private/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
