#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列出一个 MIDI 里每一轨的角色：通道 / GM 音色 / 音符数 / 音域 / 每 onset 单音比例 / 活跃区段。

用途：拿到一条十几轨的 GM 编曲 MIDI（扒谱站下载的多轨伴奏），**先认清谁在奏主旋律、哪条是鼓、
哪条是伴奏织体**，再决定抽哪几轨去做原琴 21 键转换。判据全在输出里，不要靠猜。

用法:
    python list_midi_gm_tracks.py 月亮代表我的心.mid
    python list_midi_gm_tracks.py 歌.mid --bucket 10

只依赖标准库。
"""
import argparse
import collections
import struct

GM = [
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


def _vlq(b, i):
    v = 0
    while True:
        c = b[i]
        i += 1
        v = (v << 7) | (c & 0x7F)
        if not c & 0x80:
            return v, i


def parse(path):
    d = open(path, "rb").read()
    if d[:4] != b"MThd":
        raise SystemExit("不是标准 MIDI 文件（缺 MThd）")
    hlen = struct.unpack(">I", d[4:8])[0]
    fmt, ntrks, div = struct.unpack(">HHH", d[8:14])
    if div & 0x8000:
        raise SystemExit("SMPTE 时间基准，未支持")
    i = 8 + hlen
    tracks = []
    for _ in range(ntrks):
        if d[i:i + 4] != b"MTrk":
            raise SystemExit("轨道头损坏")
        tl = struct.unpack(">I", d[i + 4:i + 8])[0]
        i += 8
        end, t, run, ev = i + tl, 0, None, []
        while i < end:
            dt, i = _vlq(d, i)
            t += dt
            b = d[i]
            if b == 0xFF:
                i += 1
                mt = d[i]
                i += 1
                ln, i = _vlq(d, i)
                data = d[i:i + ln]
                i += ln
                if mt == 0x51 and ln == 3:
                    ev.append((t, "tempo", int.from_bytes(data, "big")))
                continue
            if b in (0xF0, 0xF7):
                i += 1
                ln, i = _vlq(d, i)
                i += ln
                continue
            if b & 0x80:
                run = b
                i += 1
            hi = run >> 4
            if hi in (0x9, 0x8):
                n, v = d[i], d[i + 1]
                i += 2
                if hi == 0x9 and v > 0:
                    ev.append((t, "on", (n, run & 0xF)))
                else:
                    ev.append((t, "off", (n, run & 0xF)))
            elif hi in (0xA, 0xB, 0xE):
                i += 2
            elif hi == 0xC:
                ev.append((t, "prog", (d[i], run & 0xF)))
                i += 1
            elif hi == 0xD:
                i += 1
            else:
                raise SystemExit(f"未知状态字节 {run:#x}")
        tracks.append(ev)
        i = end
    return fmt, div, tracks


def sec_fn(div, tracks):
    tempos = sorted({e[0]: (e[0], e[2]) for tr in tracks for e in tr if e[1] == "tempo"}.values())
    if not tempos:
        tempos = [(0, 500000)]

    def f(tick):
        sec, prev, us = 0.0, 0, tempos[0][1]
        for tt, us2 in tempos:
            if tt >= tick:
                break
            sec += (tt - prev) * us / 1e6 / div
            prev, us = tt, us2
        return sec + (tick - prev) * us / 1e6 / div

    return f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("midi")
    ap.add_argument("--bucket", type=int, default=10, help="活跃度分桶秒数，默认 10")
    a = ap.parse_args()
    fmt, div, tracks = parse(a.midi)
    to_sec = sec_fn(div, tracks)
    print(f"{a.midi}\n格式 SMF type {fmt}｜轨 {len(tracks)}｜div {div}")

    infos = []
    for ti, ev in enumerate(tracks):
        prog = next((e[2][0] for e in ev if e[1] == "prog"), None)
        chans = sorted({e[2][1] for e in ev if e[1] == "prog"})
        opened, notes = {}, []
        for e in ev:
            if e[1] == "on":
                n, ch = e[2]
                opened[(ch, n)] = e[0]
            elif e[1] == "off":
                n, ch = e[2]
                st = opened.pop((ch, n), None)
                if st is not None:
                    notes.append((to_sec(st), to_sec(e[0]), n, ch))
        for (ch, n), st in opened.items():
            notes.append((to_sec(st), to_sec(max([e[0] for e in ev] or [0])), n, ch))
        infos.append((ti, prog, chans, notes))

    total_last = max((max(e[0] for e in ev) for ev in tracks if ev), default=0)
    nb = int(to_sec(total_last) / a.bucket) + 1
    print("        " + "".join(str(i % 10) for i in range(nb)) + f"   ({a.bucket}s/格)")
    for ti, prog, chans, notes in infos:
        if not notes:
            tag = f"GM {GM[prog]}" if prog is not None else "(无音符/meta 轨)"
            print(f"轨{ti:>2}  {tag}")
            continue
        onsets = collections.Counter(round(s, 2) for s, _, _, _ in notes)
        single = sum(1 for c in onsets.values() if c == 1)
        ps = [n for _, _, n, _ in notes]
        secs = [(s, e) for s, e, _, _ in notes]
        span = max(e for _, e in secs) - min(s for s, _ in secs)
        buckets = collections.Counter(int(s / a.bucket) for s, _ in secs)
        bar = "".join("#" if buckets.get(i) else "." for i in range(nb))
        name = GM[prog] if prog is not None else "?"
        if 9 in chans:
            name = "*** DRUMS (通道9) —— 必须排除 ***"
        print(f"轨{ti:>2}  {name:<28} ch{','.join(map(str, chans)) or '-':<4} "
              f"n={len(notes):5d} 音域 {min(ps)}-{max(ps)} 单音 {single}/{len(onsets)}"
              f"({single / max(len(onsets), 1) * 100:.0f}%) {span:6.0f}s  {bar}")

    print("\n读法："
          "\n  · 单音比例高（~100%）+ 音域窄 + 活跃区段首尾相接 → 旋律乐器，把它们并起来 = 主旋律。"
          "\n  · 通道 9（或显示为 10）没有 Program Change 的那条 = 鼓轨，排除。"
          "\n  · 钢琴轨（Acoustic Grand Piano）是旋律+伴奏混在一起，整轨转会糊；要拆就取每 onset 最高音。"
          "\n  · 轨 0 常只有 meta（conductor）→ `add_songs.py --list-tracks` 只打有音符的轨，那边的编号是索引 +1。")


if __name__ == "__main__":
    main()
