#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一 MIDI 诊断模块（合并原 GM 轨角色识别与结构/调性/移调扫描）。

完全复用同目录 `midi_to_midijson` 的 SMF 解析与 21 键定义，消除重复实现。
"""
from __future__ import annotations

import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import midi_to_midijson as m2  # noqa: E402

GM_NAMES = [
    "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano",
    "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavi",
    "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
    "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion",
    "Harmonica", "Tango Accordion",
    "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)", "Electric Guitar (jazz)", "Electric Guitar (clean)",
    "Electric Guitar (muted)", "Overdriven Guitar", "Distortion Guitar", "Guitar harmonics",
    "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass",
    "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
    "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
    "String Ensemble 1", "String Ensemble 2", "SynthStrings 1", "SynthStrings 2",
    "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
    "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "SynthBrass 1", "SynthBrass 2",
    "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
    "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
    "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)", "Lead 5 (charang)",
    "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass + lead)",
    "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)",
    "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
    "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)",
    "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
    "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
    "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum",
    "Reverse Cymbal", "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet",
    "Telephone Ring", "Helicopter", "Applause", "Gunshot",
]
MIN_INTERVALS = [0, 2, 3, 5, 7, 8, 10]


def print_tracks(smf: dict, bucket_s: int = 10):
    """按轨输出 GM 音色、通道、音域、单音比例及时间活跃条。"""
    notes = smf["notes"]
    names = smf["names"]
    programs = smf["programs"]
    by_track = collections.defaultdict(list)
    for item in notes:
        by_track[item[3]].append(item)

    nb = int(smf["last"] / max(1, bucket_s)) + 1
    print("\n=== 音轨角色盘点 ===")
    print("        " + "".join(str(i % 10) for i in range(nb)) + f"   ({bucket_s}s/格)")
    for ti in range(len(names)):
        tr_notes = by_track.get(ti, [])
        tr_prog = programs.get(ti, {})
        prog = next(iter(tr_prog.values()), None)
        chans = sorted(set(tr_prog.keys()) | {n[4] for n in tr_notes})
        if not tr_notes:
            tag = f"GM {GM_NAMES[prog]}" if prog is not None else f"(meta/无音符: {names[ti]})"
            print(f"轨{ti:>2}  {tag}")
            continue
        onsets = collections.Counter(round(s, 2) for s, _, _, _, _ in tr_notes)
        single = sum(1 for c in onsets.values() if c == 1)
        ps = [p for _, _, p, _, _ in tr_notes]
        span = max(e for _, e, _, _, _ in tr_notes) - min(s for s, _, _, _, _ in tr_notes)
        buckets = collections.Counter(int(s / max(1, bucket_s)) for s, _, _, _, _ in tr_notes)
        bar = "".join("#" if buckets.get(i) else "." for i in range(nb))
        label = GM_NAMES[prog] if prog is not None else names[ti]
        if 9 in chans:
            label = "*** DRUMS (通道9) —— 必须排除 ***"
        print(
            f"轨{ti:>2}  {label:<28} ch{','.join(map(str, chans)) or '-':<4} "
            f"n={len(tr_notes):5d} 音域 {min(ps)}-{max(ps)} 单音 {single}/{len(onsets)}"
            f"({single / max(len(onsets), 1) * 100:.0f}%) {span:5.0f}s  {bar}"
        )


def _global_stats(notes, last: float, tempos):
    print("\n=== ① 全局概况 ===")
    if not notes:
        print("  (无音符)")
        return
    ons = sorted(s for s, _, _, _, _ in notes)
    gaps = collections.Counter(round((b - a) * 1000) for a, b in zip(ons, ons[1:]))
    durs = collections.Counter(round((e - s) * 1000 / 10) * 10 for s, e, _, _, _ in notes)
    bpm = 60000000.0 / (tempos[0][1] if tempos else 500000)
    print(f"  音符 {len(notes)}｜时长 {last:.1f}s｜密度 {len(notes) / max(last, 1e-9):.2f} 音/秒｜"
          f"首音 {ons[0]:.3f}s｜tempo ≈{bpm:.1f}BPM")
    print(f"  音头间隔众数(ms): {gaps.most_common(6)}")
    print(f"  音符时值众数(ms): {durs.most_common(6)}")
    if ons[0] > 0.5:
        print(f"  ⚠ 首音在 {ons[0]:.3f}s（存在前导空拍，转换可加 --trim-start 平移至 0.30s）")


def _structure(notes, last: float, bucket: int):
    print(f"\n=== ② 逐 {bucket} 秒结构 ===")
    print(f"  {'窗口':<14}{'音符':>7}{'音头':>7}{'每音头':>9}{'密度/s':>9}   音域")
    t = 0.0
    while t < last:
        seg = [(s, e, p) for s, e, p, _, _ in notes if t <= s < t + bucket]
        if seg:
            ons = collections.Counter(round(s, 2) for s, _, _ in seg)
            ps = sorted(p for _, _, p in seg)
            print(
                f"  {t:5.0f}-{t + bucket:5.0f}s{len(seg):7d}{len(ons):7d}"
                f"{len(seg) / len(ons):9.1f}{len(seg) / min(bucket, last - t):9.2f}"
                f"   {m2.note_name(ps[0])}-{m2.note_name(ps[-1])}"
            )
        t += bucket


def _tonality(notes):
    print("\n=== ③ 调性覆盖（24 大小调 Top 6）===")
    if not notes:
        print("  (无音符)")
        return
    pc = collections.Counter(p % 12 for _, _, p, _, _ in notes)
    tot = float(len(notes)) or 1.0
    rows = []
    for r in range(12):
        for iv, tag in ((sorted(m2.MAJOR_PC), "大调"), (MIN_INTERVALS, "小调")):
            scale = {(r + x) % 12 for x in iv}
            rows.append((sum(pc[k] for k in scale) / tot, f"{m2.PITCH_NAMES[r]}{tag}"))
    rows.sort(reverse=True)
    for ratio, name in rows[:6]:
        print(f"  {name:<8}{ratio * 100:5.1f}%")
    if rows[0][0] < 0.95:
        print("  ⚠ 最高调式覆盖率 <95%，可能含较多变化音或中途转调。")


def _transpose_scan(notes):
    print("\n=== ④ 移调扫描表 (-6..+6) ===")
    ps = [p for _, _, p, _, _ in notes]
    n = len(ps)
    if not n:
        return
    keyset = set(m2.KEYMAP)
    rows = []
    for tr in range(-6, 7):
        sharp = sum(1 for p in ps if (p + tr) % 12 not in m2.MAJOR_PC)
        ok = fl = 0
        for p in ps:
            v = p + tr
            f = m2.fold(v)
            ok += f in keyset
            fl += int(f != v)
        rows.append((tr, sharp / n * 100, ok / n * 100, fl))
        flag = "  ← 整首移调无损（0% 黑键）" if (sharp == 0 and ok == n) else ""
        print(f"  {tr:+d}: 黑键 {sharp / n * 100:5.1f}%  可演奏 {ok / n * 100:5.1f}%  折叠 {fl}{flag}")
    best = min(rows, key=lambda r: (r[1], -r[2], r[3]))
    print(f"  → 最优候选 {best[0]:+d}（黑键 {best[1]:.1f}%｜可演奏 {best[2]:.1f}%｜折叠 {best[3]}；同类八度差异可比较 ±12）")


def _skyline_and_dup(notes, last: float, check_dup: bool):
    ons = collections.defaultdict(list)
    for s, _, p, _, _ in notes:
        ons[round(s, 2)].append(p)
    sky = sorted((t, max(v)) for t, v in ons.items())
    if not sky:
        return
    print("\n=== ⑤ 顶声部音区分布 ===")
    hist = collections.Counter(p for _, p in sky)
    for lo in range(12, 108, 12):
        cnt = sum(c for p, c in hist.items() if lo <= p < lo + 12)
        if cnt:
            print(f"  {m2.note_name(lo):>4}-{m2.note_name(lo + 11):<4}{cnt:6d}  {'#' * max(1, cnt // 8)}")
    ps = sorted(p for _, p in sky)
    med = ps[len(ps) // 2]
    lo_cut, hi_cut = med - 9, med + 12
    inside = sum(1 for _, p in sky if lo_cut <= p <= hi_cut)
    print(f"  中位音 {m2.note_name(med)}({med})｜音域 {m2.note_name(ps[0])}-{m2.note_name(ps[-1])}（{ps[-1] - ps[0]} 半音）"
          f"｜建议过滤带 [{m2.note_name(lo_cut)},{m2.note_name(hi_cut)}] 覆盖 {inside}/{len(sky)} ({inside / len(sky) * 100:.0f}%)")

    if not check_dup:
        return
    print("\n=== ⑥ 全曲重复片段扫描 ===")
    idx = collections.defaultdict(list)
    for t, p in sky:
        idx[round(t, 1)].append(p)

    def _rate(dt: float):
        hit = tot = 0
        for t, p in sky:
            if t + dt > last:
                break
            tot += 1
            for k in range(-2, 3):
                if any(q == p for q in idx.get(round(t + dt + k / 10, 1), [])):
                    hit += 1
                    break
        return hit, tot

    if int(last * 1.4) <= 60:
        print("  （曲目较短，跳过重复扫描）")
        return
    coarse = max(((_rate(dt / 2.0), dt / 2.0) for dt in range(60, int(last * 1.4), 4)),
                 key=lambda x: x[0][0] / max(x[0][1], 1))
    dt0 = coarse[1]
    fine = max(((_rate(dt / 10.0), dt / 10.0) for dt in range(max(0, int(dt0 * 10) - 20), int(dt0 * 10) + 21)),
               key=lambda x: x[0][0] / max(x[0][1], 1))
    (h, tot), dt = fine
    r = h / max(tot, 1)
    print(f"  最佳偏移 +{dt:.1f}s：{h}/{tot} = {r * 100:.0f}%")
    if r >= 0.60:
        print(f"  ⚠ 疑似整首弹了两遍：若确认为重复，可只保留前 {dt:.1f}s。")


def inspect_midi(path: str, *, mode: str = "all", track_bucket: int = 10,
                 struct_bucket: int = 30, check_dup: bool = True):
    smf = m2.parse_smf(path)
    print(f"{path}\n格式 SMF type {smf['fmt']}｜轨 {len(smf['names'])}｜div {smf['div']}｜总长 {smf['last']:.1f}s｜音符 {len(smf['notes'])}")
    if mode in ("all", "tracks"):
        print_tracks(smf, bucket_s=track_bucket)
    if mode in ("all", "structure"):
        notes = sorted(smf["notes"])
        per_track = collections.Counter(item[3] for item in notes)
        if len(per_track) == 1:
            print("\n⚠ 所有音符集中在单条轨内：若含密集和弦织体，需按顶声部音区带手动提取旋律。")
        _global_stats(notes, smf["last"], smf["tempos"])
        _structure(notes, smf["last"], struct_bucket)
        _tonality(notes)
        _transpose_scan(notes)
        _skyline_and_dup(notes, smf["last"], check_dup)
