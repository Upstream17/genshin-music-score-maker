#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A/B 争议片段剪辑与 MP3 试听渲染模块（合并原 make_ab_excerpt 与 render_preview）。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import midi_to_midijson as m2  # noqa: E402

SR = 44100


def make_excerpts(outdir: str, src_specs: list[str], win_specs: list[str], gap_ms: int = 7000) -> int:
    """从多个候选 JSON 抽取指定毫秒时间窗，拼成短对照 JSON。"""
    wins = []
    for i, w in enumerate(win_specs):
        s, e = (int(x) for x in w.replace("-", ":").split(":"))
        if e <= s:
            raise ValueError(f"窗口不合法: {w}")
        wins.append((s, e, i))

    offs, acc = [], 0
    for s, e, _ in wins:
        offs.append(acc)
        acc += (e - s) + gap_ms
    os.makedirs(outdir, exist_ok=True)

    written = 0
    for item in src_specs:
        label, sep, path = item.partition("=")
        label = label.strip()
        if not sep or not path:
            raise ValueError(f"--src 参数须写成 标签=路径: {item}")

        doc, _, iv_by_key = m2.load_json_intervals(path)
        spans = [(s, e, m2.LETTER2PITCH[k]) for k, lst in iv_by_key.items()
                 if k in m2.LETTER2PITCH for s, e in lst]
        picked = []
        for ws, we, idx in wins:
            for s, e, p in spans:
                if ws <= s < we:
                    picked.append(((s - ws + offs[idx]) / 1000.0,
                                   (min(e, we) - ws + offs[idx]) / 1000.0, p))
        if not picked:
            print(f"[x] {label}: 窗口内没有任何音（检查 --win 毫秒范围）")
            continue

        conv, st = m2.convert(sorted(picked), "raw", 0)
        ns, _ = m2.to_midijson(conv)
        ok, dev, _, miss = m2.verify_intervals(conv, ns)
        span = max(e for _, e, _ in conv)
        out_doc = m2.build_score_doc(
            f"{doc.get('name', '')} 对照 {label}".strip(),
            ns,
            author=doc.get("author", "MIDI 转换"),
            description=f"短对照试听（窗口 {win_specs}）｜{label}｜源自 {os.path.basename(path)}",
            time_signature=doc.get("time_signature", "4/4"),
            instrument=doc.get("instrument", "风物之诗琴"),
        )
        p_out = os.path.join(outdir, f"对比_{label}.json")
        with open(p_out, "w", encoding="utf-8") as f:
            json.dump(out_doc, f, ensure_ascii=False, indent=1)
        written += 1
        print(f"  {label}: 剪出 {len(conv)} 按键｜长 {span:.1f}s｜最大同按 {st['max_chord']}"
              f"｜校验 {'OK' if ok else 'FAIL'} dev={dev:.1f}ms miss={miss} → {p_out}")
    return 0 if written else 1


def _synth_notes(notes_str: str, bpm, ticks, sr: int = SR):
    import numpy as np  # 延迟导入，保证无 numpy 时其余功能零依赖

    iv = m2.press_intervals(m2.decode_events(notes_str, bpm=bpm, ticks=ticks))
    spans = [(k, s, e) for k, v in iv.items() for s, e in v]
    if not spans:
        return None, 0.0
    end_ms = max(e for _, _, e in spans)
    buf = np.zeros(int(sr * (end_ms + 2600) / 1000.0) + 1, dtype=np.float64)
    for k, s, e in spans:
        p = m2.LETTER2PITCH.get(k)
        if p is None:
            continue
        held = max(0.35, (e - s) / 1000.0)
        dur = min(2.6, held * 1.7 + 0.35)
        n = int(sr * dur)
        if n <= 1:
            continue
        t = np.arange(n) / sr
        f = 440.0 * 2 ** ((p - 69) / 12.0)
        tau = 2.0 * 2 ** (-(p - 48) / 55.0)
        env = np.exp(-t / tau) * np.minimum(1.0, t / 0.004)
        sig = (
            np.sin(2 * np.pi * f * t)
            + 0.40 * np.sin(4 * np.pi * f * t)
            + 0.18 * np.sin(6 * np.pi * f * t)
            + 0.09 * np.sin(8 * np.pi * f * t)
            + 0.04 * np.sin(10 * np.pi * f * t)
        ) * env
        i0 = int(sr * s / 1000.0)
        buf[i0:i0 + n] += sig * 0.22
    buf = np.tanh(buf * 1.6)
    peak = float(np.abs(buf).max()) or 1.0
    return buf / peak * 0.92, end_ms / 1000.0


def _write_audio(buf, wav_path: str, mp3_path: str, bitrate: str = "64k", sr: int = SR):
    import numpy as np

    pcm = (np.clip(buf, -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    res = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path, "-codec:a", "libmp3lame", "-b:a", bitrate, mp3_path],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        return wav_path, res.stderr.strip()[:200]
    os.unlink(wav_path)
    return mp3_path, ""


def render_previews(inputs: list[str], outdir: str, bitrate: str = "64k") -> int:
    """将单个或多个 type:midi JSON 合成为本地试听 MP3/WAV。"""
    files = []
    for p in inputs:
        if os.path.isdir(p):
            files.extend(os.path.join(p, f) for f in sorted(os.listdir(p)) if f.endswith(".json"))
        else:
            files.append(p)
    if not files:
        print("[x] 未找到 JSON 文件")
        return 2
    os.makedirs(outdir, exist_ok=True)
    for p in files:
        try:
            j = json.load(open(p, encoding="utf-8-sig"))
        except Exception as ex:
            print(f"[x] {os.path.basename(p)}: {ex}")
            continue
        buf, dur = _synth_notes(
            j["notes"],
            bpm=j.get("bpm", m2.JSON_BPM),
            ticks=j.get("ticks", m2.JSON_TICKS),
        )
        if buf is None:
            print(f"[x] {os.path.basename(p)}: 没有音符")
            continue
        base = os.path.splitext(os.path.basename(p))[0]
        wav = os.path.join(outdir, base + ".wav")
        mp3 = os.path.join(outdir, base + ".mp3")
        out, err = _write_audio(buf, wav, mp3, bitrate=bitrate)
        press = sum(1 for x in j["notes"].split("|") if x.startswith("D"))
        size = os.path.getsize(out) / 1024 / 1024
        print(f"  {base[:34]:36s} {dur:6.0f}s  按键 {press:5d}  → {os.path.basename(out)} "
              f"({size:.1f}MB){'  ⚠ ' + err if err else ''}")
    return 0
