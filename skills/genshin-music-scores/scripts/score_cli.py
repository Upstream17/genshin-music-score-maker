#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BetterGI 原神 21 键制谱工具包统一命令行入口（inspect / convert / transpose / verify / excerpt / preview）。"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import audio_preview as apv   # noqa: E402
import inspect_midi as imp    # noqa: E402
import midi_to_midijson as m2  # noqa: E402
import verify_score as vs     # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DEFAULT_OUTDIR = os.path.join(ROOT, "output")
_SAFE_RE = re.compile(r'[\\/:*?"<>|]')


def _collect_files(paths: list[str], exts: tuple[str, ...]) -> list[str]:
    out = []
    for p in paths:
        if os.path.isdir(p):
            for dp, _, fs in os.walk(p):
                for f in sorted(fs):
                    if f.lower().endswith(exts):
                        out.append(os.path.join(dp, f))
        elif os.path.isfile(p):
            out.append(p)
    return out


def _pick_tracks(notes, tracks_arg: str | None, melody_only: bool):
    if not notes:
        return notes
    if melody_only:
        counts = collections.Counter(n[3] for n in notes)
        keep = {counts.most_common(1)[0][0]}
    elif tracks_arg:
        keep = {int(x.strip()) for x in tracks_arg.split(",") if x.strip()}
    else:
        return notes
    return [n for n in notes if n[3] in keep]


def _safe_title(raw: str) -> str:
    s = _SAFE_RE.sub("_", (raw or "").replace("\ufffd", "").strip())
    return re.sub(r"\s{2,}", " ", s)[:120] or "未命名"


def _cmd_inspect(args) -> int:
    mode = "tracks" if args.tracks_only else ("structure" if args.structure_only else "all")
    imp.inspect_midi(
        args.midi,
        mode=mode,
        track_bucket=args.track_bucket,
        struct_bucket=args.bucket,
        check_dup=not args.no_dup,
    )
    return 0


def _cmd_convert(args) -> int:
    files = _collect_files(args.inputs, (".mid", ".midi"))
    if not files:
        print("[x] 未找到 .mid/.midi 文件")
        return 2
    if args.name and len(files) > 1:
        print("[x] --name 仅支持单首文件转换")
        return 2

    outdir = os.path.abspath(args.outdir)
    ok_count = fail_count = 0
    for fp in files:
        print("=" * 72)
        print("输入:", fp)
        try:
            smf = m2.parse_smf(fp)
        except Exception as ex:
            print(f"  [x] 解析失败: {ex}")
            fail_count += 1
            continue

        notes = _pick_tracks(smf["notes"], args.tracks, args.melody_only)
        if args.trim_start:
            notes, trimmed = m2.trim_leading_silence(notes)
            if trimmed > 0:
                print(f"  裁剪开头空拍: -{trimmed:.2f}s（首音移至 0.30s）")
        notes, capped = m2.cap_polyphony(notes, args.max_keys)
        if not notes:
            print("  [x] 选轨后没有音符")
            fail_count += 1
            continue

        intervals, st = m2.convert(notes, args.mode, args.transpose)
        notes_str, events = m2.to_midijson(intervals)
        if not events:
            print("  [x] 转换后无可演奏音符")
            fail_count += 1
            continue

        okv, dev, pairs, miss = m2.verify_intervals(intervals, notes_str)
        if not okv:
            print(f"  [x] 协议校验失败: 最大偏差 {dev:.1f}ms, 缺 {miss}")
            fail_count += 1
            continue

        title = _safe_title(args.name or os.path.splitext(os.path.basename(fp))[0])
        desc = (
            f"源：MIDI(.mid)｜原文件：{os.path.basename(fp)}｜模式 {args.mode}｜移调 {args.transpose:+d}｜"
            f"原音符 {st['total']}，可演奏 {st['mapped_notes']}，八度折叠 {st['folded']}，"
            f"半音吸附 ↑{st['snapped_up']}/↓{st['snapped_down']}，"
            f"原映射率 {st['orig_ok'] / max(st['total'], 1) * 100:.1f}%"
        )
        doc = m2.build_score_doc(title, notes_str, author=f"MIDI 转换（{args.mode} 模式）", description=desc)
        print(
            f"  映射: 原可演奏 {st['orig_ok'] / max(st['total'], 1) * 100:.1f}% → "
            f"{st['mapped_notes'] / max(st['total'], 1) * 100:.1f}%｜折叠 {st['folded']}｜"
            f"吸附 ↑{st['snapped_up']}/↓{st['snapped_down']}｜最大同按 {st['max_chord']} 键"
            + (f"｜限流丢弃 {capped} 音" if capped else "")
        )
        print(f"  协议强校验: {pairs} 个按键区间一致，最大偏差 {dev:.1f}ms ✅")

        out_path = os.path.join(outdir, f"{title}.json")
        if args.dry_run:
            print(f"  （--dry-run：跳过写入 {out_path}）")
            ok_count += 1
            continue

        os.makedirs(outdir, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, indent=1)
        print(f"  已写入: {out_path}")
        if args.verify:
            rc = vs.run_verify(out_path, mono=args.mono, quiet=True)
            if rc != 0:
                fail_count += 1
                continue
        ok_count += 1

    print("=" * 72)
    print(f"转换完成: 成功 {ok_count} / 失败或阻断 {fail_count}")
    return 0 if fail_count == 0 else 1


def _cmd_transpose(args) -> int:
    files = _collect_files(args.inputs, (".json",))
    if args.limit > 0:
        files = files[:args.limit]
    if not files:
        print("[x] 未找到 .json 文件")
        return 2
    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)
    ok = fail = 0
    for fp in files:
        try:
            doc = json.load(open(fp, "r", encoding="utf-8-sig"))
            new_doc, st = m2.transpose_midijson_doc(doc, args.semitones)
            out_path = os.path.join(outdir, os.path.basename(fp))
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump(new_doc, fh, ensure_ascii=False, indent=1)
            print(f"  OK  {os.path.basename(fp)} | 低音 {st['low_before']}→{st['low_after']} | 偏差 {st['dev_ms']:.1f}ms")
            ok += 1
        except Exception as ex:
            print(f"  FAIL {os.path.basename(fp)}: {ex}")
            fail += 1
    print(f"移调完成 ({args.semitones:+d} 半音): 成功 {ok} / 失败 {fail} → {outdir}")
    return 0 if fail == 0 else 1


def _cmd_verify(args) -> int:
    if args.diff_base:
        return vs.diff_intervals(args.diff_base, args.json_path, args.windows)
    expect = [x.strip() for x in args.expect_first_notes.split(",") if x.strip()] if args.expect_first_notes else None
    return vs.run_verify(args.json_path, expect_first=expect, mono=args.mono, quiet=args.quiet)


def _cmd_excerpt(args) -> int:
    return apv.make_excerpts(args.outdir, args.src, args.win, gap_ms=args.gap)


def _cmd_preview(args) -> int:
    return apv.render_previews(args.inputs, args.outdir, bitrate=args.bitrate)


def main():
    ap = argparse.ArgumentParser(description="Genshin Music Score Maker 统一制谱工具入口")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_ins = sub.add_parser("inspect", help="分析 MIDI 音轨角色、调性与移调候选")
    p_ins.add_argument("midi")
    p_ins.add_argument("--tracks-only", action="store_true", help="只打印 GM 音轨盘点")
    p_ins.add_argument("--structure-only", action="store_true", help="只打印调性/结构/移调表")
    p_ins.add_argument("--track-bucket", type=int, default=10, help="音轨活跃条分桶秒数")
    p_ins.add_argument("--bucket", type=int, default=30, help="结构分桶秒数")
    p_ins.add_argument("--no-dup", action="store_true", help="跳过重复片段扫描")
    p_ins.set_defaults(func=_cmd_inspect)

    p_conv = sub.add_parser("convert", help="将 .mid/.midi 转换为 BetterGI 21 键 midi JSON")
    p_conv.add_argument("inputs", nargs="+", help=".mid/.midi 文件或目录")
    p_conv.add_argument("--outdir", default=DEFAULT_OUTDIR, help="输出目录（默认 ./output/）")
    p_conv.add_argument("--name", help="指定单首输出曲名")
    p_conv.add_argument("--mode", choices=["snap", "drop", "raw"], default="snap")
    p_conv.add_argument("--transpose", type=int, default=0, help="移调半音数")
    p_conv.add_argument("--tracks", help="保留轨号，如 0 或 0,3")
    p_conv.add_argument("--melody-only", action="store_true", help="只保留音符最多的一轨")
    p_conv.add_argument("--max-keys", type=int, default=0, help="同刻最多按键数（0=不限）")
    p_conv.add_argument("--trim-start", action="store_true", help="裁剪 >0.3s 的开头空拍至 0.30s")
    p_conv.add_argument("--dry-run", action="store_true", help="只分析不写盘")
    p_conv.add_argument("--verify", action="store_true", help="写盘后顺带跑交付验收汇总")
    p_conv.add_argument("--mono", action="store_true", help="配合 --verify 收紧单声部大音程阈值")
    p_conv.set_defaults(func=_cmd_convert)

    p_tr = sub.add_parser("transpose", help="对已有 midi JSON 整体移调（通常 ±12）")
    p_tr.add_argument("inputs", nargs="+", help=".json 文件或目录")
    p_tr.add_argument("--semitones", type=int, default=-12)
    p_tr.add_argument("--outdir", required=True)
    p_tr.add_argument("--limit", type=int, default=0)
    p_tr.set_defaults(func=_cmd_transpose)

    p_ver = sub.add_parser("verify", help="交付前硬验收 / 外科手术区外零改动对比")
    p_ver.add_argument("json_path", help="待检查的 JSON")
    p_ver.add_argument("--mono", action="store_true", help="单声部模式（大音程 ≤2%%）")
    p_ver.add_argument("--expect-first-notes", default=None, help="期望开头音名，逗号分隔")
    p_ver.add_argument("--quiet", action="store_true")
    p_ver.add_argument("--diff-base", default=None, help="传入旧版 JSON 以证明编辑窗外零改动")
    p_ver.add_argument("--windows", default="", help="编辑时间窗（秒，如 115.5-117.3,138-141）")
    p_ver.set_defaults(func=_cmd_verify)

    p_ex = sub.add_parser("excerpt", help="裁剪多个候选 JSON 的指定毫秒窗口做 A/B 短对照")
    p_ex.add_argument("outdir")
    p_ex.add_argument("--src", action="append", required=True, help="标签=JSON路径")
    p_ex.add_argument("--win", action="append", required=True, help="起:止（毫秒）")
    p_ex.add_argument("--gap", type=int, default=7000)
    p_ex.set_defaults(func=_cmd_excerpt)

    p_pre = sub.add_parser("preview", help="将 midi JSON 渲染为本地试听 MP3/WAV")
    p_pre.add_argument("inputs", nargs="+")
    p_pre.add_argument("--outdir", required=True)
    p_pre.add_argument("--bitrate", default="64k")
    p_pre.set_defaults(func=_cmd_preview)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
