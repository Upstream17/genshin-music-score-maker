#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把各乐器的 21 个采样 mp3 内联成 JS（base64 data URI）
================================================================
为什么要内联：播放器要能**双击 file:// 直接打开**，而 file:// 下
`fetch()` / XHR 读本地文件会被 CORS 拦掉 —— 只有 base64 内联能让
`decodeAudioData` 拿到 ArrayBuffer，同时保持 Web Audio 的采样级精确调度。

产物（全部在 app/js/ 下）：
  samples.js                 清单 + **默认音色**（风物之诗琴），随页面一起加载
  samples-<instrument>.js    其余音色，切换时按需用 <script> 动态加载

用法：
    python app/tests/gen_samples.py <sets_dir> [out_js_dir]

<sets_dir> 结构（每套一个子目录，文件名 = 科学音高记号）：
    windsong_lyre/C3.mp3 … B5.mp3
    floral_zither/C3.mp3 …
缺失的音不报错，播放器会用最邻近的采样变调顶上。
"""
import base64
import os
import sys

PLAYER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PITCHES = [
    ('C3', 48), ('D3', 50), ('E3', 52), ('F3', 53), ('G3', 55), ('A3', 57), ('B3', 59),
    ('C4', 60), ('D4', 62), ('E4', 64), ('F4', 65), ('G4', 67), ('A4', 69), ('B4', 71),
    ('C5', 72), ('D5', 74), ('E5', 76), ('F5', 77), ('G5', 79), ('A5', 81), ('B5', 83),
]

# id -> 显示名（顺序即下拉框顺序，第一个是默认）
INSTRUMENTS = [
    ('windsong_lyre', '风物之诗琴'),
    ('vintage_lyre', '老旧的诗琴'),
    ('floral_zither', '镜花之琴'),
    ('harmonic_key', '谐律键琴'),
    ('leaping_spirit_piano', '跃律琴'),
    ('ukulele', '悠可琴'),
    ('lingering_euphonia', '余音'),
    ('nightwind_horn', '晚风圆号'),
]

# 持续吹奏/长音乐器的额外元数据（sustain 包络参数）
SUSTAIN_META = {
    'nightwind_horn': {'sustain': True, 'release': 0.12, 'minLength': 0.06},
}

DEFAULT_ID = 'windsong_lyre'

HEADER_COMMON = """/* ==========================================================================
   {title}
   --------------------------------------------------------------------------
   来源：
     - https://github.com/JularDepick/WindsongLyre-Simulator.fork（诗琴/古琴/键琴/悠可琴/余音）
     - https://github.com/Specy/genshin-music（晚风圆号 NightwindHorn，Q-U / A-J 两排 14 键）
   转码：ffmpeg -ac 1 -ar 44100 -c:a libmp3lame -b:a 48k（拨弦 2.2s / 圆号长音 8.0s）

   ⚠ 音频版权归 miHoYo 所有。仅供本机自用，**请勿再分发**。
   ⚠ 这些文件是**可选**的：删掉它们，播放器自动回退到内置合成音色。
   由 app/tests/gen_samples.py 生成，请勿手改。
   ========================================================================== */
"""


def load_set(src_dir, inst_id):
    """返回 (名称, [(音名, base64), ...], 缺失列表)"""
    notes = []
    missing = []
    for name, _midi in PITCHES:
        p = os.path.join(src_dir, inst_id, name + '.mp3')
        if not os.path.exists(p):
            missing.append(name)
            continue
        with open(p, 'rb') as f:
            notes.append((name, base64.b64encode(f.read()).decode('ascii')))
    return notes, missing


def render_set(inst_id, name, notes):
    body = ',\n'.join("      '%s': 'data:audio/mpeg;base64,%s'" % (n, b) for n, b in notes)
    meta = SUSTAIN_META.get(inst_id)
    meta_lines = ''
    if meta:
        meta_lines = (
            "  sustain: %s,\n"
            "  release: %s,\n"
            "  minLength: %s,\n"
            % ('true' if meta['sustain'] else 'false', meta['release'], meta['minLength'])
        )
    return (
        "window.BGI_SAMPLE_SETS = window.BGI_SAMPLE_SETS || {};\n"
        "window.BGI_SAMPLE_SETS['%s'] = {\n"
        "  name: '%s',\n"
        "%s"
        "  notes: {\n%s\n  }\n};\n" % (inst_id, name, meta_lines, body)
    )


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    src = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(PLAYER, 'js')
    if not os.path.isdir(src):
        print('源目录不存在: %s' % src)
        return 2
    os.makedirs(out_dir, exist_ok=True)

    manifest = []
    total_bytes = 0
    default_block = None
    default_count = 0

    for inst_id, name in INSTRUMENTS:
        d = os.path.join(src, inst_id)
        if not os.path.isdir(d):
            print('跳过（无目录）: %s' % inst_id)
            continue
        notes, missing = load_set(src, inst_id)
        if not notes:
            print('跳过（无采样）: %s' % inst_id)
            continue

        block = render_set(inst_id, name, notes)
        total_bytes += len(block)

        if inst_id == DEFAULT_ID:
            default_block = block
            default_count = len(notes)
            manifest.append({'id': inst_id, 'name': name, 'file': None,
                             'count': len(notes), 'missing': missing})
            # 默认音色随 samples.js 一起发出，不单独建文件
            continue

        fname = 'samples-%s.js' % inst_id
        header = HEADER_COMMON.format(title='%s · 真实采样（%d 音）' % (name, len(notes)))
        with open(os.path.join(out_dir, fname), 'w', encoding='utf-8', newline='\n') as f:
            f.write(header + '\n' + block)
        manifest.append({'id': inst_id, 'name': name, 'file': 'js/' + fname,
                         'count': len(notes), 'missing': missing})
        print('  %-24s %2d 音  %6.1f KB  -> %s' % (inst_id, len(notes), len(block) / 1024.0, fname))

    if default_block is None:
        print('✗ 找不到默认音色 %s' % DEFAULT_ID)
        return 1

    # samples.js = 清单 + 默认音色
    entries = []
    for m in manifest:
        meta = SUSTAIN_META.get(m['id'])
        extra = ''
        if meta:
            extra = ", sustain: %s, release: %s, minLength: %s" % (
                'true' if meta['sustain'] else 'false', meta['release'], meta['minLength']
            )
        entries.append(
            "  { id: '%s', name: '%s', file: %s, count: %d%s }"
            % (m['id'], m['name'], ("'" + m['file'] + "'") if m['file'] else 'null', m['count'], extra)
        )
    header = HEADER_COMMON.format(title='音色清单 + 默认音色（风物之诗琴）')
    doc = (
        header + '\n'
        "/* 下拉框里的音色清单；file 为 null 表示数据就在本文件里 */\n"
        "window.BGI_SAMPLE_MANIFEST = [\n" + ',\n'.join(entries) + "\n];\n\n"
        "/* 默认音色（随页面一起加载，避免首屏再发请求） */\n"
        + default_block
    )
    with open(os.path.join(out_dir, 'samples.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(doc)

    print('  %-24s %2d 音  %6.1f KB  -> samples.js（含清单，默认音色）'
          % (DEFAULT_ID, default_count, len(doc) / 1024.0))
    print('\n清单：%d 套音色；总计 %.1f KB' % (len(manifest), total_bytes / 1024.0))
    for m in manifest:
        if m['missing']:
            print('  ⚠ %s 缺 %d 个音：%s（用邻近采样变调兜底）'
                  % (m['name'], len(m['missing']), ', '.join(m['missing'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
