#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
原神键谱(.txt) -> BetterGI 可读 JSON 转换器 + 全库去重
=====================================================
1) 转换：把 MRevenger/GenshinAutoPlayLyre 的 .txt 键谱转成 BetterGI「自动演奏」
   能直接解析的 `type: "midi"` 曲谱 JSON（tick 级 D/U 事件，无精度损失）。

   源格式（依据 lib.h 的 play() 实现）：
     第 1 行 = 一个数字 part（秒），表示「+=1 拍」对应的秒数
     字母连续书写 = 同时按下（和弦）；+ 累加 part，- 累加 part/2，= 累加 part/4
     一个音组后面跟着的符号总和 = 该和弦的按住时长；遇到下一个字母才触发上一组

   目标格式（依据 BetterGI MusicScoreParser.cs 的 ParseMidiJsonTimeline）：
     notes = "D<keys><Δticks>|U<keys><Δticks>|..."，Δticks 为相对上一事件的增量，
             时长(ms) = Δticks * 60000 / (bpm * ticks)
     取 ticks=480、原子(1/4 拍)=120 ticks，则 bpm = 60/part，四分音符 = part 秒
     —— 与源格式 1 拍 = part 秒 完全等价，所有时长都是整数 tick。

2) 校验：用 Python 复刻 ParseMidiJsonTimeline + ApplyRepeatedKeyGap 的时间轴算法，
   把生成的 JSON 重放一遍，跟源 txt 的时间轴逐事件比对，必须完全一致。
3) 去重：跨来源按「规范化曲名」分组，同组保留优先级最高的一份，
   其余复制进去重报告（原目录不动）。
"""
import json, os, re, sys, hashlib, unicodedata, csv, collections

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE) if os.path.basename(_HERE) == "tools" else _HERE
REPORTS = os.path.join(ROOT, "reports")
SCORES = os.path.join(ROOT, "publicsource", "sources")
TXT_DIR = os.path.join(SCORES, "3_AutoPlayLyre_键谱txt")
OUT_DIR = os.path.join(SCORES, "7_键谱转换_MidiJson")
TICKS = 480
ATOM_TICKS = 120                     # 1 原子 = 1/4 拍 = 120 ticks
SUPPORTED = set("QWERTYUASDFGHJZXCVBNM")   # BetterGI SupportedKeys


# ---------------- 源格式解析 ----------------
def parse_txt(text):
    """返回 (part, [(keys, atoms), ...], 非法字符集合)"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    head, _, body = text.partition("\n")
    head = head.strip()
    if not re.fullmatch(r"\d+(\.\d+)?", head):
        raise ValueError(f"首行不是数字: {head!r}")
    part = float(head)
    if part <= 0:
        raise ValueError("part 必须大于 0")

    chords, keys, atoms, flag, bad = [], "", 0, False, set()
    for ch in body:
        if ch.isalpha():
            ch = ch.upper()
            if ch not in SUPPORTED:
                bad.add(ch)
                continue
            if flag:                      # 上一组收尾
                if keys:
                    chords.append((keys, max(atoms, 1)))
                keys, atoms, flag = "", 0, False
            keys += ch
        elif ch == "+":
            flag = True; atoms += 4
        elif ch == "-":
            flag = True; atoms += 2
        elif ch == "=":
            flag = True; atoms += 1
    if keys:
        chords.append((keys, max(atoms, 1)))
    return part, chords, bad


def to_midijson(chords, part):
    """按时间顺序输出 D/U 事件对（同一和弦内多个键同时按下）"""
    bpm = 60.0 / part
    parts = []
    for keys, atoms in chords:
        parts.append(f"D{keys}0")                       # 紧接上一事件
        parts.append(f"U{keys}{atoms * ATOM_TICKS}")    # 按住 atoms 个原子
    return "|".join(parts), bpm


# ---------------- BetterGI 解析器复刻（校验用） ----------------
EVENT_RE = re.compile(r"^([DU])([A-Z@]+)(\d+)$")


def replay(notes, bpm, ticks, apply_gap=True):
    """复刻 ParseMidiJsonTimeline（含 30ms 连按处理），返回 [(t_ms, key, is_down)]"""
    events, cursor = [], 0.0
    prev_status = prev_keys = ""
    prev_was_event = False
    raw = [p.strip() for p in notes.split("|") if p.strip()]
    for i, part in enumerate(raw):
        if part.startswith("*"):
            bpm = float(part[1:]); prev_was_event = False; continue
        m = EVENT_RE.match(part)
        if not m:
            raise ValueError(f"无法解析 MIDI JSON 事件: {part}")
        status, keys, dt = m.group(1), m.group(2), int(m.group(3))
        delay = dt * 60000.0 / (bpm * ticks)
        cursor += delay
        if apply_gap:
            if status == "D" and prev_was_event and prev_status == "U" \
               and any(k in keys for k in prev_keys) and delay < 30:
                cursor += 30
            elif status == "U" and keys != "@" and delay >= 30 and i + 1 < len(raw):
                nm = EVENT_RE.match(raw[i + 1])
                if nm and nm.group(1) == "D" and any(k in keys for k in nm.group(2)):
                    cursor -= 30
        if keys != "@":
            for k in dict.fromkeys(keys):
                if k in SUPPORTED:
                    events.append((cursor, k, status == "D"))
        prev_status, prev_keys, prev_was_event = status, keys, True
    return events


def expected_timeline(chords, part):
    """源 txt 的真实时间轴（ms）—— 独立于生成器的第二套推导"""
    out, t = [], 0.0
    for keys, atoms in chords:
        start, dur = t, atoms * part / 4 * 1000
        for k in dict.fromkeys(keys):
            out.append((start, k, True)); out.append((start + dur, k, False))
        t += dur
    return out


# ---------------- 规范化曲名（去重用） ----------------
VERSION_WORDS = [
    "midi转谱", "原琴和弦版", "原琴缩编版", "钢琴缩编版", "原谱增强版", "修改版", "精简版",
    "简慢速版", "慢速版", "单音版", "单音", "无前奏", "完美版", "附和弦", "和弦版", "缩编版",
    "增强版", "演奏版", "适配版", "钢琴版", "片段", "简化版", "完整版", "原版", "修正版",
    "ost", "ver", "demo",
]
BRACKET_RE = re.compile(r"[（(【\[《][^）)】\]》]*[）)】\]》]")
# 官方曲谱文件名形如「曲名 - LZ5hp0vW」。随机码特征：含数字，或有 >=2 个大写字母（kFuKhouJ）。
# 如此才不会把 magnet / Summer / Air 这类真曲名当成随机码删掉。
CODE_RE = re.compile(
    r"\s*[-_]\s*(?=[A-Za-z0-9]{5,10}\s*$)"
    r"(?=[A-Za-z0-9]*(?:\d|(?:[^A-Za-z]*[A-Z][^A-Z]*){2,}))"
    r"[A-Za-z0-9]{5,10}\s*$")


def norm_title(name):
    s = unicodedata.normalize("NFKC", name)
    s = BRACKET_RE.sub("", s)
    s = CODE_RE.sub("", s)
    low = s.lower()
    for w in VERSION_WORDS:
        low = low.replace(w, "")
    low = re.sub(r"[\s\-_·、,，.。!！?？:：;；'\"“”‘’/\\|+~=＊*]+", "", low)
    return low


# ---------------- 主流程 ----------------
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    report = []
    total_ok = total_bad = 0
    all_bad_chars = collections.Counter()

    for fn in sorted(os.listdir(TXT_DIR)):
        if not fn.lower().endswith(".txt"):
            continue
        path = os.path.join(TXT_DIR, fn)
        raw = open(path, encoding="utf-8", errors="replace").read()
        name = os.path.splitext(fn)[0]
        try:
            part, chords, bad = parse_txt(raw)
        except Exception as e:
            report.append((name, "解析失败", str(e), 0, 0)); total_bad += 1; continue
        notes, bpm = to_midijson(chords, part)

        # 校验：重放必须与源时间轴一致（关闭 30ms 补偿时应当逐条相等）
        # 注：BetterGI 把同一和弦的多个 keydown 连续输出，故按 (时间,键,按下/抬起) 排序后比对
        got = replay(notes, bpm, TICKS, apply_gap=False)
        exp = expected_timeline(chords, part)
        sort_key = lambda x: (round(x[0], 6), x[1], 0 if x[2] else 1)
        gs, es = sorted(got, key=sort_key), sorted(exp, key=sort_key)
        diff = max((abs(a[0] - b[0]) for a, b in zip(gs, es)), default=0.0)
        same = (len(got) == len(exp)
                and all(a[1] == b[1] and a[2] == b[2] for a, b in zip(gs, es))
                and diff < 1e-6)

        obj = {
            "name": name,
            "author": "原谱: GenshinAutoPlayLyre (MRevenger) / 转换: Hermes",
            "instrument": "风物之诗琴",
            "type": "midi",
            "description": f"由键谱 txt 无损转换（原速 part={part}s，bpm={round(bpm,4)}，ticks={TICKS}）",
            "time_signature": "4/4",
            "bpm": round(bpm, 6),
            "ticks": TICKS,
            "notes": notes,
        }
        out = os.path.join(OUT_DIR, f"{name}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)

        report.append((name, "OK" if same else "时间轴不一致",
                       f"和弦{len(chords)}个/事件{len(got)}条/最大偏差{diff:.3f}ms"
                       + (f"/丢弃非法键{''.join(sorted(bad))}" if bad else ""),
                       len(chords), len(got)))
        if same: total_ok += 1
        else: total_bad += 1
        all_bad_chars.update(bad)

    print(f"[转换] 成功 {total_ok} / 失败 {total_bad}  -> {OUT_DIR}")
    if all_bad_chars:
        print(f"[转换] 源文件里出现过 BetterGI 不支持的按键（已丢弃）: {dict(all_bad_chars)}")
    with open(os.path.join(REPORTS, "转换报告.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(["曲名", "结果", "说明", "和弦数", "事件数"]); w.writerows(report)

    # ---------- 去重 ----------
    src_priority = [
        ("1_BetterGI官方_原琴JSON", 0), ("7_键谱转换_MidiJson", 1), ("2_WindSong_MIDI", 2),
        ("4_acgmusic_MIDI", 3), ("5_lyre_overlay", 4), ("6_balance_BVC", 5),
    ]
    groups = collections.defaultdict(list)
    for folder, pri in src_priority:
        d = os.path.join(SCORES, folder)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            p = os.path.join(d, fn)
            if not os.path.isfile(p):
                continue
            h = hashlib.md5(open(p, "rb").read()).hexdigest()
            groups[norm_title(os.path.splitext(fn)[0])].append(
                {"folder": folder, "file": fn, "pri": pri, "md5": h,
                 "size": os.path.getsize(p)})

    # 人工确认过的同曲合并表（规范化名互不相同，但实为同一首；已逐条看过谱面/来源）
    MANUAL_MERGE = [
        ("aliez", "泽野弘之"),                            # 「泽野弘之 - aLIEZ.mid」尾串被随机码正则误删（唯一一处误删，已核对）
        ("lemon", "lemon欢快的版本"),
        ("onelastkiss", "宇多田光onelastkiss"),
        ("rubia", "崩坏3rdrubia"),
        ("穿越时空的思念", "超越时空的思念"),                 # 异体字/错别字
        ("红莲华", "鬼灭之刃红莲华"),
        ("让风告诉你", "让风告诉你原神内"),
        ("起风了", "起风了c调"),
        ("青鸟", "青鸟火影忍者"),
        ("鸟之诗", "鸟之诗air"),
        ("溯", "溯rese"),
        ("千本樱", "初音未来千本樱"),
        ("千本樱", "悠可琴千本樱"),                          # 同一首曲子的另一乐器版
        ("周杰伦夜曲", "夜曲"),
        ("远航星的告别", "远航星的告别new"),
    ]
    for a, b in MANUAL_MERGE:
        if a in groups and b in groups:
            groups[a].extend(groups.pop(b))
        elif b in groups:
            groups[a] = groups.pop(b)

    # 只把「BetterGI 真能解析」的文件放进曲库，其余单独归档
    def bettergi_ok(p):
        ext = os.path.splitext(p)[1].lower()
        if ext in (".mid", ".midi"):
            try:
                return open(p, "rb").read(4) == b"MThd"
            except OSError:
                return False
        if ext == ".json":
            try:
                j = json.load(open(p, encoding="utf-8"))
            except Exception:
                return False
            return isinstance(j, dict) and "notes" in j \
                and str(j.get("type", "yuanqin")).lower() in ("yuanqin", "midi", "keyboard")
        return False

    keep_dir = os.path.join(ROOT, "archive", "中间产物", "去重后曲库")
    other_dir = os.path.join(ROOT, "archive", "非BetterGI格式")
    os.makedirs(keep_dir, exist_ok=True)
    os.makedirs(other_dir, exist_ok=True)
    rows, n_keep, n_dupe, n_other = [], 0, 0, 0
    for key, items in sorted(groups.items()):
        usable = [x for x in items if bettergi_ok(os.path.join(SCORES, x["folder"], x["file"]))]
        for x in items:
            if x not in usable:      # 非 BetterGI 格式（Sky/覆盖层等），仅归档不参与去重
                open(os.path.join(other_dir, x["file"]), "wb").write(
                    open(os.path.join(SCORES, x["folder"], x["file"]), "rb").read())
                n_other += 1
        items = usable
        if not items:
            continue
        items.sort(key=lambda x: (x["pri"], x["file"]))
        keeper = items[0]
        others = items[1:]
        ext = os.path.splitext(keeper["file"])[1]
        target = os.path.join(keep_dir, keeper["file"])
        if not os.path.exists(target):
            open(target, "wb").write(
                open(os.path.join(SCORES, keeper["folder"], keeper["file"]), "rb").read())
        n_keep += 1
        for o in others:
            n_dupe += 1
            same_md5 = any(o["md5"] == k["md5"] for k in items if k is not o)
            rows.append([key or "(空)", keeper["folder"] + "/" + keeper["file"],
                         o["folder"] + "/" + o["file"],
                         "完全相同(内容哈希一致)" if same_md5 else "同曲不同编曲",
                         len(items)])
    with open(os.path.join(REPORTS, "去重报告.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["规范化曲名", "保留(优先级最高)", "被合并的重复文件", "判定依据", "该曲目总份数"])
        w.writerows(rows)
    print(f"[去重] BetterGI 可解析曲目 {n_keep} 首（唯一）｜合并重复份 {n_dupe}"
          f"｜非 BetterGI 格式归档 {n_other} 个 -> {other_dir}")
    print(f"[去重] 曲库副本在 {keep_dir}")

    # 模糊匹配：规范化后仍不同名、但疑似同一首（只标记，不合并）
    def lev(a, b):
        if a == b: return 0
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
            prev = cur
        return prev[-1]

    keys = sorted(k for k in groups if k)
    fuzzy = []
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            if a in b or b in a:
                if 0 < abs(len(a) - len(b)) <= 6:
                    fuzzy.append((a, b, "包含关系"))
            elif min(len(a), len(b)) >= 4 and lev(a, b) <= 2:
                fuzzy.append((a, b, "编辑距离≤2"))
    with open(os.path.join(REPORTS, "去重报告.csv"), "a", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([]); w.writerow(["【以下为疑似同一首，未自动合并，请人工确认】"])
        w.writerow(["曲目A", "曲目B", "判定依据"])
        for a, b, why in fuzzy:
            ga = [x["file"] for x in groups[a]]
            gb = [x["file"] for x in groups[b]]
            w.writerow([a, b, f"{why}｜A:{'、'.join(ga)}｜B:{'、'.join(gb)}"])
    print(f"[去重] 疑似同一首（待人工确认）: {len(fuzzy)} 组")
    print(f"[去重] 报告 {os.path.join(REPORTS,'去重报告.csv')}")


if __name__ == "__main__":
    main()
