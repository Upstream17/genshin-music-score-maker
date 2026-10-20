#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一条命令摸清一个陌生 MIDI 的底细：全局量 / 结构 / 调性 / **移调扫描表** / 顶声部音区带 / **整首是否弹了两遍**。

用途：拿到任何陌生 `.mid` 时先跑这个拿客观量，再决定怎么转 —— 不要凭听感或直方图肉眼判调。

输出六块：
  ① 全局：音符数 / 时长 / 密度 / 首音 / **基本音头间隔众数**（= 成品的一个基准音符值，SKILL §4e 拿它跟原曲八分音符比）
  ② 逐 30 秒：音符数 / 音头数 / 每音头音数 / 音域        → 看密度与段落突变
  ③ 调性：24 个调（12 大调 + 12 小调）的全谱覆盖率 top6    → 判调号
  ④ **移调扫描表**：−6…+6 每个偏移的「黑键% / 折叠后可演奏率 / 折叠数」（SKILL §1.4）
     → 出现「黑键 0%」那一行 = 该曲音级正好是一套调式音阶，**整首移调即无损**；每行都有黑键 = 只能 snap
  ⑤ 顶声部（每音头最高音）音高分布 + 中位音 + 建议过滤带
  ⑥ 重复扫描：顶声部在 +dt 处找 ±0.2s 内同音高，对 dt 扫描 → 真偏移会从 5–16% 跳到 ≥60%（整首被复制了一份）

用法:
    python scan_midi_structure.py 歌.mid
    python scan_midi_structure.py 歌.mid --bucket 30 --no-dup

只依赖标准库；需与本目录的 `list_midi_gm_tracks.py` 放在一起（复用它的 SMF 解析 + tempo 表）。
21 键映射表在本文件里自带一份（不依赖项目路径）。
"""
import argparse
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import list_midi_gm_tracks as lt  # noqa: E402  (同目录下的 SMF 解析器)

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJ = [0, 2, 4, 5, 7, 9, 11]
MIN = [0, 2, 3, 5, 7, 8, 10]

# 风物之诗琴 21 键（音高 → 键字母），InstrumentProfileService.StandardMappings
KEY21 = {48: "Z", 50: "X", 52: "C", 53: "V", 55: "B", 57: "N", 59: "M",
         60: "A", 62: "S", 64: "D", 65: "F", 67: "G", 69: "H", 71: "J",
         72: "Q", 74: "W", 76: "E", 77: "R", 79: "T", 81: "Y", 83: "U"}
KEYSET = set(KEY21)
LO, HI = min(KEY21), max(KEY21)


def nn(p):
    return f"{NAMES[p % 12]}{p // 12 - 1}"


def fold(n):
    while n < LO:
        n += 12
    while n > HI:
        n -= 12
    return n


def collect(path):
    """解析一份 SMF，返回 6 元组：
    (fmt, div, tracks, notes, tempos, last_sec)
      notes   = [(sec_start, sec_end, pitch, track), ...]，已按起点排序
      tempos  = 拍长 µs/四分音符的**裸 int 列表**（不是 (tick, µs) 元组；
                要元组请用 list_midi_gm_tracks.sec_fn 那条路），空 = 源里没写 tempo
      last_sec= 全曲末事件秒数
    """
    fmt, div, tracks = lt.parse(path)
    to_sec = lt.sec_fn(div, tracks)
    notes = []
    for ti, ev in enumerate(tracks):
        opened = {}
        for e in ev:
            if e[1] == "on":
                opened[e[2]] = e[0]
            elif e[1] == "off":
                st = opened.pop(e[2], None)
                if st is not None:
                    notes.append((to_sec(st), to_sec(e[0]), e[2][0], ti))
        last_tick = max([e[0] for e in ev] or [0])
        for key, st in opened.items():                 # 没配对的 note-on：按轨尾收
            notes.append((to_sec(st), to_sec(last_tick), key[0], ti))
    notes.sort()
    tempos = sorted({e[0]: e[2] for tr in tracks for e in tr if e[1] == "tempo"}.values())
    last = to_sec(max((max([e[0] for e in ev] or [0]) for ev in tracks), default=0))
    return fmt, div, tracks, notes, tempos, last


def global_stats(notes, last, tempos):
    """`tempos` 是拍长 µs 的 int 列表（见 collect()），故 tempos[0] 直接用，不要再下标一次。"""
    print("\n=== ① 全局 ===")
    if not notes:
        return
    ons = sorted(s for s, _, _, _ in notes)
    gaps = collections.Counter(round((b - a) * 1000) for a, b in zip(ons, ons[1:]))
    durs = collections.Counter(round((e - s) * 1000 / 10) * 10 for s, e, _, _ in notes)
    dens = len(notes) / max(last, 1e-9)
    # collect() keeps only the tempo values, so tempos[0] is already µs/quarter.
    bpm = 60000000.0 / (tempos[0] if tempos else 500000)
    print(f"  音符 {len(notes)}｜时长 {last:.1f}s｜密度 {dens:.2f} 音/秒｜首音 {ons[0]:.3f}s｜tempo ≈{bpm:.1f}BPM")
    print(f"  基本音头间隔众数(ms): {gaps.most_common(6)}")
    print("   ← 众数那个值就是成品的一个基准音符值；SKILL §4e：拿它跟原曲八分音符(60000/BPM/2 ms)比")
    print(f"  时值众数(ms): {durs.most_common(6)}")
    if ons[0] > 0.5:
        print(f"  ⚠ 首音在 {ons[0]:.3f}s = 前导空拍，转换时平移到 0.3s（SKILL §4b6）")


def structure(notes, last, bucket):
    print(f"\n=== ② 逐 {bucket} 秒结构 ===")
    print(f"  {'窗口':<14}{'音符':>7}{'音头':>7}{'每音头':>9}{'密度/s':>9}   音域")
    t = 0.0
    while t < last:
        seg = [(s, e, p) for s, e, p, _ in notes if t <= s < t + bucket]
        if seg:
            ons = collections.Counter(round(s, 2) for s, _, _ in seg)
            ps = sorted(p for _, _, p in seg)
            print(f"  {t:5.0f}-{t + bucket:5.0f}s{len(seg):7d}{len(ons):7d}"
                  f"{len(seg) / len(ons):9.1f}{len(seg) / min(bucket, last - t):9.2f}"
                  f"   {nn(ps[0])}-{nn(ps[-1])}")
        t += bucket


def tonality(notes):
    print("\n=== ③ 调性（全谱 pitch-class 覆盖率）===")
    pc = collections.Counter(p % 12 for _, _, p, _ in notes)
    tot = float(len(notes))
    rows = []
    for r in range(12):
        for iv, tag in ((MAJ, "大调"), (MIN, "小调")):
            st = {(r + x) % 12 for x in iv}
            rows.append((sum(pc[k] for k in st) / tot, f"{NAMES[r]}{tag}"))
    for v, k in sorted(rows, reverse=True)[:6]:
        print(f"  {k:<8}{v * 100:5.1f}%")
    best = sorted(rows, reverse=True)[0]
    print(f"  → 最可能 {best[1]}（{best[0] * 100:.1f}%）。覆盖率 <95% = 含较多变化音，"
          f"移调后不会「零处理」——看 ④ 的残余黑键率，如实报「残余吸附数」。")
    return best


def transpose_scan(notes):
    """SKILL §1.4：−6…+6 每个偏移的「黑键% / 折叠后可演奏率 / 折叠数」"""
    print("\n=== ④ 移调扫描表（挑「黑键 0%」那一行 = 整首移调即无损）===")
    ps = [p for _, _, p, _ in notes]
    n = len(ps)
    if not n:
        return []
    rows = []
    for tr in range(-6, 7):
        pc = collections.Counter((p + tr) % 12 for p in ps)
        sharp = sum(v for k, v in pc.items() if k not in MAJ)
        ok = fl = 0
        for p in ps:
            v = p + tr
            f = fold(v)
            ok += f in KEYSET
            fl += (f != v)
        rows.append((tr, sharp / n * 100, ok / n * 100, fl))
        flag = ""
        if sharp == 0 and ok == n:
            flag = "  ← 整首移调即无损（零黑键零丢音），同余类里再挑八度"
        print(f"  {tr:+d}: 黑键 {sharp / n * 100:5.1f}%  可演奏 {ok / n * 100:5.1f}%  折叠 {fl}{flag}")
    best = min(rows, key=lambda r: (r[1], -r[2], r[3]))
    print(f"  → 残余黑键最少的是 {best[0]:+d}（黑键 {best[1]:.1f}%、可演奏 {best[2]:.1f}%、折叠 {best[3]}）"
          f"；若不能到 0，就取这一行当调性，并如实报「{best[1]:.1f}% 变化音被吸附」。")
    print("  → 同一同余类的 ±12 两版音高内容完全相同，只差哪一端要折：比折叠数与低音键数，两版都渲 mp3 让用户挑。")
    return rows


def skyline(notes):
    ons = collections.defaultdict(list)
    for s, e, p, _ in notes:
        ons[round(s, 2)].append(p)
    sky = sorted((t, max(v)) for t, v in ons.items())
    print("\n=== ⑤ 顶声部（每音头最高音）音区带 ===")
    hist = collections.Counter(p for _, p in sky)
    for lo in range(12, 108, 12):
        n = sum(c for p, c in hist.items() if lo <= p < lo + 12)
        if n:
            print(f"  {nn(lo):>4}-{nn(lo + 11):<4}{n:6d}  {'#' * max(1, n // 8)}")
    ps = sorted(p for _, p in sky)
    med = ps[len(ps) // 2]
    lo_cut, hi_cut = med - 9, med + 12
    inside = sum(1 for _, p in sky if lo_cut <= p <= hi_cut)
    print(f"  中位音 {nn(med)}({med})｜音域 {nn(ps[0])}-{nn(ps[-1])}（{ps[-1] - ps[0]} 半音）")
    print(f"  建议旋律过滤带 [{nn(lo_cut)},{nn(hi_cut)}] = [{lo_cut},{hi_cut}]：带内 {inside}/{len(sky)}"
          f" ({inside / len(sky) * 100:.0f}%)，带外的音头按「此处旋律没在响」处理。")
    print("  ⚠ 顶声部会在「只有伴奏低音在响」的音头上掉下去（实测掉到 F#2）→ 必须过滤，别直接当年主旋律。")
    return sky


def dup_scan(sky, last):
    print("\n=== ⑥ 重复扫描（整首是否弹了两遍）===")
    idx = collections.defaultdict(list)
    for t, p in sky:
        idx[round(t, 1)].append(p)

    def rate(dt):
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

    coarse = max(((rate(dt / 2.0), dt / 2.0) for dt in range(60, int(last * 1.4), 4)),
                 key=lambda x: x[0][0] / max(x[0][1], 1))
    (h, tot), dt0 = coarse
    fine = max(((rate(dt / 10.0), dt / 10.0) for dt in range(max(0, int(dt0 * 10) - 20), int(dt0 * 10) + 21)),
               key=lambda x: x[0][0] / max(x[0][1], 1))
    (h, tot), dt = fine
    r = h / max(tot, 1)
    print(f"  最佳偏移 +{dt:.1f}s：{h}/{tot} = {r * 100:.0f}%  （其它偏移通常只有 5–16%）")
    if r >= 0.60:
        print(f"  → 判为整首重复：只保留第一份（0–{dt:.1f}s），不砍的话游戏里会老老实实弹两遍；"
              f"     并在 description 里写明「源文件含重复的一半，已裁」。")
    else:
        print("  → 没找到重复段（最高也在噪声区间）。")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("midi")
    ap.add_argument("--bucket", type=int, default=30, help="结构分桶秒数，默认 30")
    ap.add_argument("--no-dup", action="store_true", help="跳过重复扫描（长文件较慢）")
    a = ap.parse_args()
    fmt, div, tracks, notes, tempos, last = collect(a.midi)
    print(f"{a.midi}")
    print(f"SMF type {fmt}｜轨 {len(tracks)}｜div {div}｜tempo {tempos[:3] or 'default 500000'}"
          f"｜时长 {last:.1f}s｜音符 {len(notes)}")
    pertrack = collections.Counter(t for _, _, _, t in notes)
    print("每轨音符数：" + "  ".join(f"轨{t}:{n}" for t, n in sorted(pertrack.items())))
    if len(pertrack) == 1:
        print("⚠ 只有一条轨装了全部音符 —— 没有旋律轨可读，走 SKILL.md §4(b4)；"
              "**先读 §4(b4)-0：先问用户有没有轨分得清的版本（双手钢琴谱/全曲版）。**")
    global_stats(notes, last, tempos)
    structure(notes, last, a.bucket)
    tonality(notes)
    transpose_scan(notes)
    sky = skyline(notes)
    if not a.no_dup:
        dup_scan(sky, last)


if __name__ == "__main__":
    main()
