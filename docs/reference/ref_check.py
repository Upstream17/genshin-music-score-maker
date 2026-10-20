#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立参照实现（Python，逐条照抄 BetterGI C# 源码，用整数 tick 模拟 TimeSpan）+
跨实现一致性校验：把 Python 参照实现的解析产物与 player/js/bettergi-parse.js
的产物逐音符比对（容差 1ms，吸收 C#/JS 浮点与 tick 取整差异）。

运行：
    python research/_tmp/ref_check.py "完整曲库"
退出码：0 = 全部一致；1 = 有差异。
"""
import json
import os
import re
import subprocess
import sys

TICK = 10000  # TimeSpan 1 tick = 100ns；1ms = 10000 ticks
MIN_GAP_MS = 30
SUPPORTED = set("QWERTYUASDFGHJZXCVBNM")
KEY_TO_PITCH = {
    'Z': 48, 'X': 50, 'C': 52, 'V': 53, 'B': 55, 'N': 57, 'M': 59,
    'A': 60, 'S': 62, 'D': 64, 'F': 65, 'G': 67, 'H': 69, 'J': 71,
    'Q': 72, 'W': 74, 'E': 76, 'R': 77, 'T': 79, 'Y': 81, 'U': 83,
}
MIDI_EVENT_RE = re.compile(r'^([DU])([A-Z@]+)([0-9]+)$')
TUPLET_RE = re.compile(r'^([0-9]+)\.([36$])$')


def ms_to_ticks(ms):
    return int(round(ms * TICK))


def add_note(events, start_ms, dur_ms, keys):
    if keys == '@':
        return
    if not keys:
        return
    seen = set()
    for ch in keys.upper():
        if ch not in KEY_TO_PITCH or ch in seen:
            continue
        seen.add(ch)
        events.append((ms_to_ticks(start_ms), ch, True))
        events.append((ms_to_ticks(start_ms + dur_ms), ch, False))


def _ev_order(e):
    # e = (ticks, key, down)
    # C#: OrderBy(Time).ThenBy(Type == KeyUp ? 0 : 1) —— 同刻「抬起(UP)」在前。
    # down=True 是 KeyDown -> 排后面(1)；down=False 是 KeyUp -> 排前面(0)
    return (e[0], 0 if not e[2] else 1)


def quantize_ticks(events):
    """BetterGI 全程用 TimeSpan（1 tick = 100ns）；这里把时刻对齐到 tick。"""
    return [(int(round(t)), k, d) for (t, k, d) in events]


def normalize(events):
    """
    MusicTimelineBuilder.Normalize —— 装配期整理器（三种 JSON type 统一调用）。
    与 apply_repeated_key_gap 的区别：本函数**不看同刻**，而是按
    「同键上一个音还没松开就又按下」(activeCounts[key] > 0) 判断，
    插入 KeyUp @ (newStart - 30ms) 并吞掉被交叠的旧 KeyUp。

    阶段 2 与 apply_repeated_key_gap 同算法，但两处排序都必须是**纯稳定排序**
    （只按 Time，不按 Type 二次排序）—— 上游注释专门警告重排会粘键。
    """
    sorted_events = sorted(quantize_ticks(events), key=lambda e: e[0])   # 纯稳定排序
    active_counts, hold_starts, result = {}, {}, []

    for t, key, down in sorted_events:
        count = active_counts.get(key, 0)
        if down:
            if count > 0 and key in hold_starts:
                retrigger_up = t - MIN_GAP_MS * TICK
                result.append((retrigger_up if retrigger_up > hold_starts[key] else t, key, False))
            result.append((t, key, True))
            hold_starts[key] = t
            active_counts[key] = count + 1
        else:
            if count <= 0:
                continue                       # 孤儿 KeyUp：丢弃
            active_counts[key] = count - 1
            if count == 1:
                result.append((t, key, False))
                hold_starts.pop(key, None)
            # count > 1：属于已被重触发闭合的按住，吞掉

    previous_down, previous_up_index = {}, {}
    for index, (t, key, down) in enumerate(result):
        if down:
            up_index = previous_up_index.get(key)
            if (up_index is not None and result[up_index][0] == t
                    and key in previous_down):
                early = t - MIN_GAP_MS * TICK
                if early > previous_down[key]:
                    result[up_index] = (early, key, False)
            previous_down[key] = t
        else:
            previous_up_index[key] = index

    return sorted(result, key=lambda e: e[0])   # 仍是纯稳定排序


def apply_repeated_key_gap(events):
    evs = sorted(events, key=_ev_order)
    previous_down, previous_up_index = {}, {}
    for i, item in enumerate(evs):
        t, key, down = item
        if down:
            up_index = previous_up_index.get(key)
            if up_index is not None and evs[up_index][0] == t and key in previous_down:
                early = t - MIN_GAP_MS * TICK
                if early > previous_down[key]:
                    evs[up_index] = (early, key, False)
            previous_down[key] = t
        else:
            previous_up_index[key] = i
    return sorted(evs, key=_ev_order)


def max_polyphony(notes):
    """同时发声的最大键数（按 (start, end) 扫描线；同刻同键的 KeyDown 会被传输层去重）。"""
    evs = []
    for _k, s, e in notes:
        evs.append((s, 1))
        evs.append((e, 0))          # 结束优先，避免把首尾相接算成重叠
    evs.sort(key=lambda x: (x[0], x[1]))
    cur = best = 0
    for _t, kind in evs:
        cur += 1 if kind == 1 else -1
        if cur > best:
            best = cur
    return best


def pair(events):
    stacks, notes = {}, []
    for t, key, down in events:
        if down:
            stacks.setdefault(key, []).append(t)
        else:
            st = stacks.get(key)
            if st:
                s = st.pop(0)
                e = t if t > s else s + 1 * TICK
                notes.append((key, s, e))
    return notes


# ---------------- yuanqin ----------------

def parse_yuanqin_tokens(sheet):
    sheet = sheet.replace('\r', '').replace('\n', '')
    tokens, index = [], 0
    while index < len(sheet):
        if sheet[index] == '|':
            index += 1
            continue
        if sheet[index] == '(':
            end = sheet.find(')', index + 1)
            if end < 0:
                raise ValueError('和弦缺少右括号')
            keys = sheet[index + 1:end]
            index = end + 1
        elif sheet[index] == '[':
            keys = ''                      # 裸 [n] token：无前置键
        else:
            keys = sheet[index]
            index += 1
        if index >= len(sheet) or sheet[index] != '[':
            raise ValueError('音符 %s 缺少时值' % keys)
        bracket_end = sheet.find(']', index + 1)
        if bracket_end < 0:
            raise ValueError('缺少右方括号')
        value = sheet[index + 1:bracket_end]
        index = bracket_end + 1
        if value in ('^', '&'):
            tokens.append((keys, 0.0, value))
            continue
        sep = value.find('-')
        denom_text = value[:sep] if sep >= 0 else value
        special = value[sep + 1:] if sep >= 0 else 'none'
        tokens.append((keys, float(denom_text), special))
    return tokens


def beat_denominator(ts):
    parts = str(ts).split('/')
    if len(parts) == 2:
        try:
            d = int(parts[1])
            if d > 0:
                return d
        except ValueError:
            pass
    return 4


def note_duration_ms(bpm, bd, n):
    if bpm <= 0 or n <= 0:
        raise ValueError('BPM 和音符时值必须大于 0')
    return 60000.0 / bpm * bd / n


def parse_yuanqin(sheet, bpm0, ts):
    tokens = parse_yuanqin_tokens(sheet)
    events, cursor, bpm = [], 0.0, bpm0
    bd = beat_denominator(ts)
    i = 0
    while i < len(tokens):
        keys, denom, special = tokens[i]
        if special == '%':
            if denom > 0:
                bpm = denom
            i += 1
            continue
        if special in ('^', '&'):
            for ch in keys.upper():
                if ch in KEY_TO_PITCH:
                    events.append((ms_to_ticks(cursor), ch, special == '^'))
            if special == '&':
                cursor += MIN_GAP_MS
            i += 1
            continue
        m = TUPLET_RE.match(special)
        if m:
            group = []
            while i < len(tokens):
                group.append(tokens[i])
                if tokens[i][2].endswith('$'):
                    break
                i += 1
            if not group[-1][2].endswith('$'):
                raise ValueError('连音缺少 .$ 结束标记')
            total = note_duration_ms(bpm, bd, denom)
            weights = [1.0 / float(TUPLET_RE.match(g[2]).group(1)) for g in group]
            wsum = sum(weights)
            for g, w in zip(group, weights):
                share = total * w / wsum
                add_note(events, cursor, share, g[0])
                cursor += share
            i += 1
            continue

        if special == '#':
            dur = 60000.0 / bpm / 16.0
        else:
            dur = note_duration_ms(bpm, bd, denom)
        if special == '*':
            dur = dur * 1.5
        if special in ('none', '*'):
            orn = 0
            nxt = i + 1
            while nxt < len(tokens) and tokens[nxt][2] == '#':
                orn += 1
                nxt += 1
            ornaments = 60000.0 / bpm / 16.0 * orn
            if ornaments < dur:
                dur -= ornaments
        add_note(events, cursor, dur, keys)
        cursor += dur
        i += 1
    return apply_repeated_key_gap(events), cursor


# ---------------- midi ----------------

def parse_midi(sheet, bpm0, ticks):
    events, cursor, bpm = [], 0.0, bpm0
    prev_status, prev_keys, prev_was_event = '', '', False
    parts = [p.strip() for p in str(sheet).split('|')]
    parts = [p for p in parts if p]
    for idx, raw in enumerate(parts):
        if raw.startswith('*'):
            bpm = float(raw[1:])
            if bpm <= 0:
                raise ValueError('变速标记非法')
            prev_was_event = False
            continue
        m = MIDI_EVENT_RE.match(raw)
        if not m:
            raise ValueError('无法解析 MIDI JSON 事件：' + raw)
        status, keys, dt = m.group(1), m.group(2), int(m.group(3))
        delay = dt * 60000.0 / (bpm * ticks)
        cursor += delay
        if (status == 'D' and prev_was_event and prev_status == 'U'
                and any(c in keys for c in prev_keys) and delay < MIN_GAP_MS):
            cursor += MIN_GAP_MS
        elif (status == 'U' and keys != '@' and delay >= MIN_GAP_MS and idx + 1 < len(parts)):
            nm = MIDI_EVENT_RE.match(parts[idx + 1])
            if nm and nm.group(1) == 'D' and any(c in nm.group(2) for c in keys):
                cursor -= MIN_GAP_MS
        if keys != '@':
            seen = set()
            for ch in keys.upper():
                if ch in KEY_TO_PITCH and ch not in seen:
                    seen.add(ch)
                    events.append((ms_to_ticks(cursor), ch, status == 'D'))
        prev_status, prev_keys, prev_was_event = status, keys, True
    return events, cursor, bpm


# ---------------- keyboard ----------------

def preprocess_keyboard(sheet):
    p = re.sub(r'/\(([^)]+)\)', r'{\1}', str(sheet))
    p = re.sub(r'/([A-Z])', r'{\1}', p)
    p = p.replace(' ', '0')
    p = re.sub(r'/\[([^\]]+)\]', r'{[\1]}', p)
    return p.replace('/', '').replace('>', '')


def parse_keyboard_nodes(text, state, closing):
    nodes = []
    while state[0] < len(text):
        cur = text[state[0]]
        if closing and cur == closing:
            state[0] += 1
            return nodes
        if cur in '([{':
            state[0] += 1
            exp = {'(': ')', '[': ']', '{': '}'}[cur]
            node = [cur, None, parse_keyboard_nodes(text, state, exp), 1]
        elif cur in ')]}':
            raise ValueError('键谱出现不匹配的括号：' + cur)
        elif cur == '-':
            if not nodes:
                raise ValueError('键谱延音符号前没有音符')
            nodes[-1][3] += 1
            state[0] += 1
            continue
        else:
            node = ['\0', cur, [], 1]
            state[0] += 1
        while state[0] < len(text) and text[state[0]] == '-':
            node[3] += 1
            state[0] += 1
        nodes.append(node)
    if closing:
        raise ValueError('键谱缺少右括号')
    return nodes


def unfold(node, start_beat, dur_beat, out):
    if node[1] is not None:
        k = node[1].upper()
        if k != '0' and k in KEY_TO_PITCH:
            out.append((k, start_beat, 0.0, dur_beat))
        return
    offset = 0.001 if node[0] == '{' else 0.0
    if node[0] == '[' and node[2]:
        unit = dur_beat / len(node[2])
        for i, ch in enumerate(node[2]):
            unfold(ch, start_beat + i * unit, unit, out)
    else:
        for ch in node[2]:
            unfold(ch, start_beat + offset, dur_beat, out)


def parse_keyboard(sheet, bpm):
    processed = preprocess_keyboard(sheet)
    nodes = parse_keyboard_nodes(processed, [0], None)
    flat, cum = [], 0.0
    for nd in nodes:
        unfold(nd, cum, nd[3], flat)
        cum += nd[3]
    beat = 60000.0 / bpm
    events = []
    for k, sb, ob, db in flat:
        add_note(events, (sb + ob) * beat, db * beat, k)
    return apply_repeated_key_gap(events), cum * beat


# ---------------- 主流程 ----------------

def reference(obj):
    typ = str(obj.get('type', 'yuanqin')).strip().lower()

    def getnum(name, fallback):
        v = obj.get(name, fallback)
        try:
            f = float(str(v))
            return f if f > 0 else fallback
        except (TypeError, ValueError):
            return fallback

    bpm = getnum('bpm', 120.0)
    ticks = max(1, int(round(getnum('ticks', 480.0))))
    ts = str(obj.get('time_signature', '4/4'))
    notes = obj.get('notes')
    if notes is None:
        raise ValueError('缺 notes')
    # 装配期整理：三种 type 统一走 normalize（对应上游 BuildKeyTimeline 里的 Normalize(events)）
    if typ == 'midi':
        ev, cur, bpm2 = parse_midi(notes, bpm, ticks)
        return pair(normalize(ev)), cur, bpm2
    if typ == 'keyboard':
        ev, cur = parse_keyboard(notes, bpm)
        return pair(normalize(ev)), cur, bpm
    if typ == 'yuanqin':
        ev, cur = parse_yuanqin(notes, bpm, ts)
        return pair(normalize(ev)), cur, bpm
    raise ValueError('不支持的曲谱类型：' + typ)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '完整曲库'
    files = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower().endswith('.json'):
                files.append(os.path.join(dirpath, fn))
    files.sort()

    # 让 Node 把同样的文件逐个解析成 JSON 行，避免重复实现遍历
    node_script = r'''
const fs=require('fs');
const B=require(process.argv[1]);
const files=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const out=[];
for(const f of files){
  let o;
  try{o=JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));}catch(e){out.push({f,err:'json'});continue;}
  let s;
  try{s=B.parseScore(o);}catch(e){out.push({f,err:'throw '+e.message});continue;}
  if(!s.ok){out.push({f,err:s.error});continue;}
  out.push({f,ok:1,dur:s.stats.durationMs,bpm:s.bpm,poly:s.stats.maxPolyphony,
            n:s.notes.map(x=>[x.key,x.start,x.end])});
}
process.stdout.write(JSON.stringify(out));
'''
    parser_abs = os.path.abspath(os.path.join('player', 'js', 'bettergi-parse.js'))
    list_path = os.path.abspath(os.path.join('research', '_tmp', 'files.json'))
    with open(list_path, 'w', encoding='utf-8') as fh:
        json.dump(files, fh, ensure_ascii=False)
    proc = subprocess.run(
        ['node', '-e', node_script, parser_abs, list_path],
        capture_output=True, text=True, encoding='utf-8')
    if proc.returncode != 0:
        print('node 调用失败：', proc.stderr[:2000])
        return 2
    js = {r['f']: r for r in json.loads(proc.stdout)}

    mismatches, compared, notes_cmp = [], 0, 0
    order_only = []
    for f in files:
        try:
            obj = json.loads(open(f, encoding='utf-8-sig').read())
        except Exception as e:
            mismatches.append((f, 'json 读取: %s' % e))
            continue
        try:
            ref_notes, ref_dur, ref_bpm = reference(obj)
        except Exception as e:
            # 参照实现认为该文件不该解析成功 —— 与 JS 的 ok:false 对齐
            if f in js and 'err' not in js[f]:
                mismatches.append((f, 'JS ok 但参照失败: %s' % e))
            continue
        j = js.get(f)
        if j is None or 'err' in j:
            mismatches.append((f, '参照 ok 但 JS 失败: %s' % (j or {}).get('err')))
            continue
        compared += 1
        # 比对音符数
        if len(ref_notes) != len(j['n']):
            mismatches.append((f, '音符数 %d vs %d' % (len(ref_notes), len(j['n']))))
            continue
        bad = None
        # 1) 内容比对：按 (start, end, key) 排序后逐个比 —— 与「插入顺序」无关，
        #    只检验时间/音高语义是否逐音符一致（容差 1ms）。
        rs_sorted = sorted(ref_notes, key=lambda x: (x[1], x[2], x[0]))
        js_sorted = sorted(j['n'], key=lambda x: (x[1], x[2], x[0]))
        for bi, (a, b) in enumerate(zip(rs_sorted, js_sorted)):
            notes_cmp += 1
            rk, rs, re_ = a[0], a[1] / TICK, a[2] / TICK
            if rk != b[0] or abs(rs - b[1]) > 1.0 or abs(re_ - b[2]) > 1.0:
                bad = ('内容第 %d 个音符不一致\n' % bi) + \
                      '           ref  ... %s\n' % [
                          '%s@%.3f..%.3f' % (x[0], x[1] / TICK, x[2] / TICK)
                          for x in rs_sorted[max(0, bi - 2):bi + 3]] + \
                      '           js   ... %s' % [
                          '%s@%.3f..%.3f' % (x[0], x[1], x[2])
                          for x in js_sorted[max(0, bi - 2):bi + 3]]
                break
        if bad is None:
            # 2) 同刻顺序比对：把 start 量化到 0.001ms 后按组比较 key 集合
            #    （契约规定 start 升序 + 同刻保持 BetterGI 发送顺序；
            #     不同 start 之间的先后由 start 决定，不必比）
            ref_groups, js_groups = {}, {}
            for k, s, e in ref_notes:
                ref_groups.setdefault(round(s / TICK, 3), []).append(k)
            for k, s, e in j['n']:
                js_groups.setdefault(round(s, 3), []).append(k)
            all_starts = set(ref_groups) | set(js_groups)
            mismatch_groups = 0
            only_keys_ref, only_keys_js = 0, 0
            for st in sorted(all_starts):
                a = sorted(ref_groups.get(st, []))
                b = sorted(js_groups.get(st, []))
                if a != b:
                    mismatch_groups += 1
                    # 区分「真差异」与「只是分箱错位」：看这个 start 附近两侧是否
                    # 存在同 key 的音（分箱错位时 key 会出现在相邻 start）
                    if not a:
                        only_keys_js += 1
                    elif not b:
                        only_keys_ref += 1
                    if mismatch_groups <= 3 and bad is None:
                        bad = '同刻音符集合不同 @%.3fms ref=%s js=%s' % (st, a, b)
            if mismatch_groups == 0:
                pass
            elif only_keys_ref + only_keys_js == mismatch_groups:
                # 全是「空 vs 非空」-> 很可能只是 0.001ms 分箱边界错位，等下用
                # 逐音符（已按内容排序）的结果判定；这里记为顺序类
                order_only.append((f, mismatch_groups))
                bad = None
            else:
                order_only.append((f, mismatch_groups))
        if bad:
            mismatches.append((f, bad))
            continue
        if abs(ref_dur - j['dur']) > 1.0:
            mismatches.append((f, 'durationMs %.3f vs %.3f' % (ref_dur, j['dur'])))
        elif abs(ref_bpm - j['bpm']) > 1e-9:
            mismatches.append((f, 'bpm %s vs %s' % (ref_bpm, j['bpm'])))
        else:
            ref_poly = max_polyphony(ref_notes)
            if 'poly' in j and ref_poly != j['poly']:
                mismatches.append((f, 'maxPolyphony %d vs %d' % (ref_poly, j['poly'])))

    print('参照实现 vs JS 实现 —— 跨实现一致性校验')
    print('  文件总数        :', len(files))
    print('  双方都解析成功  :', compared)
    print('  逐音符比对个数  :', notes_cmp)
    print('  内容不一致文件  :', len(mismatches))
    if order_only:
        print('  仅顺序不同文件  :', len(order_only),
              '（同一 start 组内 key 顺序不同；内容/时长完全一致）')
        for f, n in order_only[:5]:
            print('     - %s (%d 组)' % (f, n))
    if mismatches:
        for f, why in mismatches[:40]:
            print('   ✗', f)
            print('       ', why)
        if len(mismatches) > 40:
            print('    … 还有', len(mismatches) - 40, '个')
        return 1
    print('  结论            : 内容与时长完全一致 ✅')
    return 0


if __name__ == '__main__':
    sys.exit(main())
