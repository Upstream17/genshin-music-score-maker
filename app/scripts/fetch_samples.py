#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_samples.py — 下载游戏乐器 21 音采样并生成 app/js/samples*.js
======================================================================
为什么要有这个脚本：游戏音频的版权归 miHoYo，默认不随 Git 仓库分发。
想在本机或自行部署站点使用真实音色，跑一次这个脚本即可生成采样包
（本地产物已被 .gitignore 排除）。

数据来源：https://github.com/JularDepick/WindsongLyre-Simulator.fork
          instruments/<id>/audio/{1-,1,1+,…,7+}.mp3   （与 21 键一一对应）

用法：
    python app/scripts/fetch_samples.py              # 下载 + 转码 + 生成
    python app/scripts/fetch_samples.py --keep       # 保留中间 mp3
    python app/scripts/fetch_samples.py --only windsong_lyre
    python app/scripts/fetch_samples.py --no-transcode   # 不压，直接用原始 mp3 内联
    python app/scripts/fetch_samples.py --outdir <dir>   # 指定输出 JS 目录

转码需要 ffmpeg 在 PATH 里（没有就自动 --no-transcode，体积大一些但仍可用）。
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

RAW = 'https://raw.githubusercontent.com/JularDepick/WindsongLyre-Simulator.fork/main/instruments/'

# 站点命名 -> 科学音高（与原神 21 键一一对应）
KEY_TO_NOTE = [
    ('1-', 'C3'), ('2-', 'D3'), ('3-', 'E3'), ('4-', 'F3'), ('5-', 'G3'), ('6-', 'A3'), ('7-', 'B3'),
    ('1', 'C4'), ('2', 'D4'), ('3', 'E4'), ('4', 'F4'), ('5', 'G4'), ('6', 'A4'), ('7', 'B4'),
    ('1+', 'C5'), ('2+', 'D5'), ('3+', 'E5'), ('4+', 'F5'), ('5+', 'G5'), ('6+', 'A5'), ('7+', 'B5'),
]

INSTRUMENTS = [
    'windsong_lyre', 'vintage_lyre', 'floral_zither', 'floral_zither_old',
    'harmonic_key', 'leaping_spirit_piano', 'ukulele', 'lingering_euphonia',
]

UA = {'User-Agent': 'Mozilla/5.0 (compatible; genshin-music-score-maker/1.0)'}


def fetch(url, dest, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            if len(data) > 1000 and (data[:3] == b'ID3' or data[0] == 0xFF):
                with open(dest, 'wb') as f:
                    f.write(data)
                return True
        except Exception:
            pass
        time.sleep(0.6 * (i + 1))
    return False


def have_ffmpeg():
    return shutil.which('ffmpeg') is not None


def transcode(src_dir, dst_dir):
    os.makedirs(dst_dir, exist_ok=True)
    ok = 0
    for f in sorted(os.listdir(src_dir)):
        if not f.lower().endswith('.mp3'):
            continue
        out = os.path.join(dst_dir, f)
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', os.path.join(src_dir, f),
               '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '48k', '-t', '2.2', out]
        if subprocess.call(cmd) == 0 and os.path.exists(out) and os.path.getsize(out) > 1500:
            ok += 1
    return ok


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    only = None
    out_js = os.path.join(ROOT, 'app', 'js')
    keep = '--keep' in args
    do_transcode = '--no-transcode' not in args
    if '--only' in args:
        idx = args.index('--only')
        if idx + 1 >= len(args):
            print('缺少 --only 参数值')
            return 2
        only = args[idx + 1]
    if '--outdir' in args:
        idx = args.index('--outdir')
        if idx + 1 >= len(args):
            print('缺少 --outdir 参数值')
            return 2
        out_js = args[idx + 1]

    if do_transcode and not have_ffmpeg():
        print('⚠ 没找到 ffmpeg，改为不压缩（体积约 7 MB，仍能正常使用）')
        do_transcode = False

    todo = [i for i in INSTRUMENTS if (only is None or i == only)]
    if not todo:
        print('没有匹配的乐器：%s' % only)
        return 2

    work = tempfile.mkdtemp(prefix='lyre-samples-')
    raw_dir = os.path.join(work, 'raw')
    out_src = os.path.join(work, 'ready')
    total_ok = total_miss = 0

    try:
        tasks = []
        for inst in todo:
            d = os.path.join(raw_dir, inst)
            os.makedirs(d, exist_ok=True)
            for key, note in KEY_TO_NOTE:
                url = RAW + inst + '/audio/' + urllib.parse.quote(key) + '.mp3'
                tasks.append((inst, url, os.path.join(d, note + '.mp3')))

        counts = {inst: [0, 0] for inst in todo}
        with ThreadPoolExecutor(max_workers=12) as pool:
            futs = {pool.submit(fetch, url, dest): inst for inst, url, dest in tasks}
            for fut in as_completed(futs):
                inst = futs[fut]
                if fut.result():
                    counts[inst][0] += 1
                else:
                    counts[inst][1] += 1

        for inst in todo:
            ok, miss = counts[inst]
            total_ok += ok
            total_miss += miss
            print('  %-24s %2d/21%s' % (inst, ok, '  （缺 %d 个音，用邻近采样兜底）' % miss if miss else ''))

        if total_ok == 0:
            print('✗ 未能下载任何采样音频，请检查网络连接')
            return 1

        src_dir = raw_dir
        if do_transcode:
            print('\n转码中（mono 44.1k / 48kbps / 2.2s）…')
            for inst in todo:
                a = os.path.join(raw_dir, inst)
                b = os.path.join(out_src, inst)
                if os.path.isdir(a):
                    transcode(a, b)
            src_dir = out_src
            if not os.path.isdir(out_src):
                src_dir = raw_dir

        print('\n生成 samples*.js …')
        rc = subprocess.call([sys.executable,
                              os.path.join(ROOT, 'app', 'tests', 'gen_samples.py'),
                              src_dir,
                              out_js])
        if rc != 0:
            print('生成失败（gen_samples.py 返回 %d）' % rc)
            return rc

        if keep:
            print('\n中间文件保留在：%s' % raw_dir)
    finally:
        if not keep:
            shutil.rmtree(work, ignore_errors=True)

    print('\n完成：下载 %d 个采样，失败 %d 个。' % (total_ok, total_miss))
    print('产物：%s/samples.js（默认音色） + samples-<id>.js（其余）' % out_js)
    return 0


if __name__ == '__main__':
    sys.exit(main())
