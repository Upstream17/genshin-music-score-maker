#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 MidiJson 曲谱合成为音频，用于「先听再决定挂哪首」（本地预览音色，非游戏音色）。

用法:
    python render_preview.py <文件或目录> [...] --outdir <输出目录>
    python render_preview.py "…/精选去重/起风了.json" --outdir "…/_试听音频"

原理: 21 键 → MIDI 音高 → 加性合成拨弦音（1/2/3/4/5 次谐波 + 指数衰减，低音衰得慢），
     再把所有音符按曲谱的按下时刻叠加、软限幅、归一化，写 WAV 后用 ffmpeg 转 MP3。
"""
import argparse
import json
import os
import subprocess
import sys
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import midi_to_midijson as m2

REV = {v: k for k, v in m2.KEYMAP.items()}          # "Z" → 48
SR = 44100


def synth(notes_str, sr=SR):
    # press_intervals 返回 {键: [(按下ms, 抬起ms), …]}
    iv = m2.press_intervals(m2.decode_events(notes_str))
    spans = [(k, s, e) for k, v in iv.items() for s, e in v]
    if not spans:
        return None, 0.0
    end_ms = max(e for _, _, e in spans)
    buf = np.zeros(int(sr * (end_ms + 2600) / 1000.0) + 1, dtype=np.float64)
    for k, s, e in spans:
        held = max(0.35, (e - s) / 1000.0)
        dur = min(2.6, held * 1.7 + 0.35)           # 拨弦自然余韵，不严格跟随按键时长
        n = int(sr * dur)
        if n <= 1:
            continue
        t = np.arange(n) / sr
        p = REV.get(k)
        if p is None:
            continue
        f = 440.0 * 2 ** ((p - 69) / 12.0)
        tau = 2.0 * 2 ** (-(p - 48) / 55.0)         # 低音衰减慢、高音衰减快
        env = np.exp(-t / tau) * np.minimum(1.0, t / 0.004)
        sig = (np.sin(2 * np.pi * f * t) + 0.40 * np.sin(4 * np.pi * f * t)
               + 0.18 * np.sin(6 * np.pi * f * t) + 0.09 * np.sin(8 * np.pi * f * t)
               + 0.04 * np.sin(10 * np.pi * f * t)) * env
        i0 = int(sr * s / 1000.0)
        buf[i0:i0 + n] += sig * 0.22
    buf = np.tanh(buf * 1.6)                        # 软限幅，防止密集处爆音
    peak = float(np.abs(buf).max()) or 1.0
    return buf / peak * 0.92, end_ms / 1000.0


def write_audio(buf, path_wav, path_mp3, sr=SR, BR="128k"):
    pcm = (np.clip(buf, -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(path_wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path_wav,
                        "-codec:a", "libmp3lame", "-b:a", BR, path_mp3],
                       capture_output=True, text=True)
    if r.returncode != 0:                           # 没装 lame 就留 WAV
        return path_wav, r.stderr.strip()[:200]
    os.unlink(path_wav)
    return path_mp3, ""


def collect(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            out += [os.path.join(p, f) for f in sorted(os.listdir(p)) if f.endswith(".json")]
        else:
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--bitrate", default="128k", help="MP3 码率（试听用 64k 足够）")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    for p in collect(args.inputs):
        try:
            j = json.load(open(p, encoding="utf-8-sig"))
        except Exception as ex:
            print(f"[x] {os.path.basename(p)}: {ex}")
            continue
        buf, dur = synth(j["notes"])
        if buf is None:
            print(f"[x] {os.path.basename(p)}: 没有音符")
            continue
        base = os.path.splitext(os.path.basename(p))[0]
        wav = os.path.join(args.outdir, base + ".wav")
        mp3 = os.path.join(args.outdir, base + ".mp3")
        out, err = write_audio(buf, wav, mp3, BR=args.bitrate)
        press = sum(1 for x in j["notes"].split("|") if x.startswith("D"))
        size = os.path.getsize(out) / 1024 / 1024
        print(f"  {base[:34]:36s} {dur:6.0f}s  按键 {press:5d}  → {os.path.basename(out)} "
              f"({size:.1f}MB){'  ⚠ ' + err if err else ''}")


if __name__ == "__main__":
    main()
