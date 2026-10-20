#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
合并成单一「曲库」（library-private/）
======================
把「去重后曲库(257)」与「MIDI 21键适配产物(80)」合并为一个可长期维护的曲库。

合并规则（默认策略 = 每首歌只留一份，且这一份一定能弹）
  · 原琴/网络键谱 JSON            → 01_原琴JSON/
  · 键谱(.txt)转换来的 JSON       → 02_键谱转换JSON/
  · 原本就可演奏(≥99.9%)的 .mid   → 03_MIDI原版/
  · 原本丢音(<99.9%)的 .mid       → 不进曲库；改用 04_MIDI-21键适配JSON/ 里的适配版

  于是曲目总数不变（257 首），但每一首的可演奏率都 ≥99.9%。
  被顶替的 48 个 .mid 原件**没有删除**，仍在 scores/2_WindSong_MIDI、scores/4_acgmusic_MIDI
  以及 原神曲谱_327首.zip 里，可用 --keep-broken-midi 让它们也进库。

用法
  python merge_library.py                 # 默认策略
  python merge_library.py --keep-broken-midi   # 48 个原件也放进 03_MIDI原版/
  python merge_library.py --adapt-all          # 80 首 MIDI 全部加适配版（不止丢音的 48 首）
"""

import os, sys, json, csv, shutil, zipfile, argparse, collections

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE) if os.path.basename(_HERE) == "tools" else _HERE
REPORTS = os.path.join(ROOT, "reports")
_ARCH = os.path.join(ROOT, "archive", "中间产物")
OLD_LIB = os.path.join(_ARCH, "去重后曲库")
OLD_LIB_ALT = os.path.join(ROOT, "去重后曲库")            # 兼容旧位置
ADAPT = os.path.join(_ARCH, "8_MIDI转换_MidiJson")
ADAPT_ALT = os.path.join(ROOT, "8_MIDI转换_MidiJson")
SCORES = os.path.join(ROOT, "publicsource", "sources")
REPORT = os.path.join(REPORTS, "midi转换报告.csv")
DEST = os.path.join(ROOT, "library-private")
MANIFEST = os.path.join(REPORTS, "library-manifest.csv")

SUF = "（21键适配）"
# ★ 我方（Hermes）转换/适配产物的统一标签：显示名后缀 + author 前缀。
#   官方曲库（01_原琴JSON）不打标签 —— 那些不是我转的。
# 标题只用曲名（用户 2026-09-22 定）：TAG 置空 —— 归属信息只放 author 字段与清单备注，
# 由目录（01=官方 / 02、04=我方）区分谁转的。变体保留「（精简）」这类限定词，否则列表里会重名。
TAG = ""
AUTHOR_TAG = "Hermes"
_HERMES_RE = __import__("re").compile(r"（Hermes[^）]*）")

ARTISTS = {
    # 曲名 → author 字段。规范（用户 2026-09-22 定）：**第一作者（原曲作者）在前，再写我方转换信息**。
    # 作者只取「源文件自带元数据」或「查证过的原唱/作曲者」；查不到就不写（author 只留 `Hermes 转换`），绝不猜。
    # 依据见 `作者核对表.csv`；重跑 merge_library.py 会按本表重写 author。
    "Beyond - 海阔天空": "Beyond | Hermes 转换",   # 文件名·乐队在前
    "ButterFly": "和田光司 | Hermes 转换",   # 数码宝贝 OP
    "Deadman - 蔡徐坤": "蔡徐坤 | Hermes 转换",   # 文件名反序（Deadman 是曲名）
    "Doki Doki Literature Club!": "Dan Salvato | Hermes 转换",   # 游戏作曲
    "Everytime you kissed me": "梶浦由記（Emily Bindiger 演唱） | Hermes 转换",   # 潘多拉之心 OST
    "FF14用——穿越时空的思念": "和田薫 | Hermes 转换",   # 犬夜叉 時代を超える想い
    "Only My Railgun": "fripSide | Hermes 转换",   # 超炮 OP
    "Piano知我": "尹昔眠 | Hermes 转换",   # 《知我》原唱
    "Rosa Walton Hallie Coggins - I really want to stay at your house": "Rosa Walton & Hallie Coggins | Hermes 转换",   # 文件名·赛博朋克 边缘行者
    "Scarborough Fair": "英国传统民谣 | Hermes 转换",   # 传统曲目
    "Take Me Higher": "V6 | Hermes 转换",   # 迪迦奥特曼 OP
    "Tempestissimo": "t+pazolite | Hermes 转换",   # Arcaea 曲目
    "YOASOBI - ハルジオン": "YOASOBI | Hermes 转换",   # 文件名
    "YOASOBI - 夜に駆ける": "YOASOBI | Hermes 转换",   # 文件名
    "YOASOBI - 群青": "YOASOBI | Hermes 转换",   # 文件名
    "aLIEz": "澤野弘之 | Hermes 转换",   # ALDNOAH.ZERO ED
    "jojo的黄金之风": "菅野祐悟 | Hermes 转换",   # JoJo 第五部 作曲
    "letting go": "蔡健雅 | Hermes 转换",   # 同名曲
    "loser": "米津玄師 | Hermes 转换",   # 同名曲
    "lovelive - Snow Halation": "μ's（Love Live!） | Hermes 转换",   # 文件名
    "lovelive - 爱してるばんざい": "μ's（Love Live!） | Hermes 转换",   # 文件名
    "rage your dream": "影山ヒロノブ | Hermes 转换",   # 头文字D
    "undertale": "Toby Fox | Hermes 转换",   # 游戏作曲
    "victory": "Two Steps from Hell | Hermes 转换",   # 同名曲
    "you": "dai | Hermes 转换",   # 查证：寒蝉鸣泣之时 作曲
    "《最伟大的作品》（原神演奏）": "周杰伦 | Hermes 转换",   # 同名曲
    "《枫》“缓缓飘落的枫叶像思念”原神演奏": "周杰伦 | Hermes 转换",   # 同名曲
    "【Animenz】unravel 钢琴版（原神适配）": "TK from 凛として時雨 | Hermes 转换",   # unravel 原作
    "【FF14】不染 - 毛不易（香蜜沉沉烬如霜主题曲）": "毛不易 | Hermes 转换",   # 文件名
    "【ff14演奏】庆云顶-原神BGM": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "【原神】不怕 - 神兵小将片尾曲 - 单轨无黑键版": "潘雅 Panya（曲） | Hermes 转换",   # 查证：原曲泰文歌，中文版赵蓓/赵蕾
    "【原神演奏】Lemon 欢快的版本": "米津玄師 | Hermes 转换",   # Lemon
    "【原神演奏】Lemon 欢快的版本（精简）": "米津玄師 | Hermes 转换",   # Lemon
    "【原神演奏】Lemon 欢快的版本（纯旋律）": "米津玄師 | Hermes 转换",   # Lemon
    "【原神演奏】听我说谢谢你": "李昕融 | Hermes 转换",   # 同名曲
    "【原神演奏】缘之空：遠い空へ（遥远的天空）": "三轮学 | Hermes 转换",   # 缘之空 OST
    "【原神演奏】赤伶": "HITA | Hermes 转换",   # 同名曲
    "【原神演奏】轻轻敲醒沉睡的心灵（明天会更好）": "罗大佑（群星合唱） | Hermes 转换",   # 明天会更好
    "【周杰伦】稻香（原神适配）": "周杰伦 | Hermes 转换",   # 文件名
    "【洗脑神曲】极乐净土（原神适配）": "GARNiDELiA | Hermes 转换",   # 极乐净土
    "【西游记】猪八戒背媳妇（原神适配）": "许镜清 | Hermes 转换",   # 86 版西游记 作曲
    "【许嵩】幻听（原神适配）": "许嵩 | Hermes 转换",   # 文件名
    "【许嵩】素颜（原神适配）": "许嵩 | Hermes 转换",   # 文件名
    "いつも何度でも": "木村弓 | Hermes 转换",   # 千与千寻 ED
    "东方Project - どうして...": "ZUN（上海アリス幻樂団） | Hermes 转换",   # 文件名
    "东方Project - 妖怪之山": "ZUN（上海アリス幻樂団） | Hermes 转换",   # 文件名
    "东方Project - 月まで届け、不死の煙": "ZUN（上海アリス幻樂団） | Hermes 转换",   # 文件名
    "丹砂巍巍": "HOYO-MiX（陈致逸） | Hermes 转换",   # 查证：原神 层岩巨渊 BGM
    "久石让 - Summer": "久石让 | Hermes 转换",   # 文件名
    "久石让 - 天空之城": "久石让 | Hermes 转换",   # 文件名
    "亡灵序曲": "Dreamtale | Hermes 转换",   # 查证：The Dawn
    "像我这样的人": "毛不易 | Hermes 转换",   # 同名曲
    "光るなら": "Goose house | Hermes 转换",   # 四月是你的谎言 OP
    "克罗地亚狂想曲-C调简化版": "Maksim Mrvica | Hermes 转换",   # 马克西姆演奏版
    "凉凉": "杨宗纬 & 张碧晨 | Hermes 转换",   # 三生三世十里桃花
    "初音未来 - magnet": "minato（流星P） | Hermes 转换",   # VOCALOID P 主
    "初音未来 - 朧月": "minato（流星P） | Hermes 转换",   # 查证：词曲 minato
    "初音未来 - 活动小丑": "40mP | Hermes 转换",   # VOCALOID P 主·からくりピエロ
    "初音未来 - 深海少女": "ゆうゆ | Hermes 转换",   # VOCALOID P 主
    "初音未来 - 脑浆炸裂女孩": "れるりり | Hermes 转换",   # VOCALOID P 主
    "初音未来的消失": "cosMo@暴走P | Hermes 转换",   # VOCALOID P 主
    "别看我只是一只羊": "古倩敏 | Hermes 转换",   # 查证：2005 创作演唱
    "前前前前世": "RADWIMPS | Hermes 转换",   # 君の名は。
    "加勒比海盗": "Hans Zimmer / Klaus Badelt | Hermes 转换",   # 电影配乐
    "勾指起誓": "ilem（洛天依 演唱） | Hermes 转换",   # VOCALOID 中文曲
    "千年龙诗": "植松伸夫 | Hermes 转换",   # 查证：FF14 Dragonsong
    "千本桜": "黒うさP | Hermes 转换",   # VOCALOID P 主
    "原神 - 疾如猛火": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "原神《庆云顶》适配风物之琴": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "原神【风物之琴】溯（超还原）适用于大多数可演奏游戏": "CORSAK & 马吟吟 | Hermes 转换",   # 《溯 Reverse》
    "原神【风物之琴】缘之空记忆": "三轮学 | Hermes 转换",   # 缘之空 OST
    "只因你太美": "蔡徐坤 | Hermes 转换",   # 同名曲
    "君の名 约会": "RADWIMPS | Hermes 转换",   # 查证：君の名は。OST「デート」
    "告白气球-周杰伦": "周杰伦 | Hermes 转换",   # 文件名
    "周杰伦 - 星晴": "周杰伦 | Hermes 转换",   # 文件名
    "哀と愁(火影忍者)": "増田俊郎 | Hermes 转换",   # 火影 OST 作曲
    "国际歌": "欧仁·鲍狄埃 / 皮埃尔·狄盖特 | Hermes 转换",   # 词曲作者
    "夏影": "戸越まごめ（Key） | Hermes 转换",   # AIR OST
    "夜に駆ける": "YOASOBI | Hermes 转换",   # 同名曲
    "夜曲": "周杰伦 | Hermes 转换",   # 同名曲
    "夜的钢琴曲五 - 石进": "石进 | Hermes 转换",   # 文件名
    "大鱼海棠（FF14演奏)": "周深 | Hermes 转换",   # 《大鱼》演唱
    "奇迹再现": "毛华锋 | Hermes 转换",   # 查证：迪迦中文版片头头曲 演唱
    "奇迹再现 - 游戏（原神）适配版": "毛华锋 | Hermes 转换",   # 同上（同名不同文件）
    "妈妈的话": "Zyboy忠宇 | Hermes 转换",   # 查证：词曲唱 2021
    "孤勇者": "陈奕迅 | Hermes 转换",   # 英雄联盟
    "寄明月-SING女团 FF14适配原神演奏《完美版》": "SING女团 | Hermes 转换",   # 文件名
    "尘世闲游": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "快乐星猫": "牛奶咖啡 | Hermes 转换",   # 查证：2008 动画主题曲
    "我和我的祖国": "李谷一（曲：秦咏诚） | Hermes 转换",   # 同名曲
    "手紙 〜拝啓　十五の君へ〜": "アンジェラ・アキ | Hermes 转换",   # 同名曲
    "旋转吧！雪月花 - 机巧少女不会受伤": "原田ひとみ 等 | Hermes 转换",   # 机巧少女 ED
    "无论你多怪异我还是会喜欢你": "周子琰 | Hermes 转换",   # 查证：刺客伍六七 推广版片尾曲
    "无论你多怪异我还是喜欢你-刺客伍六七ed-游戏（原神）适配版": "周子琰 | Hermes 转换",   # 查证：刺客伍六七 推广版片尾曲
    "星の在り処": "Falcom Sound Team jdk（う〜み 演唱） | Hermes 转换",   # 空之轨迹 ED
    "春はゆく - Aimer": "Aimer | Hermes 转换",   # 文件名反序
    "普通disco": "ilem（洛天依 演唱） | Hermes 转换",   # VOCALOID 中文曲
    "曾经我也想过一了百了": "中島美嘉 | Hermes 转换",   # 同名曲
    "未闻花名": "ZONE | Hermes 转换",   # secret base 原唱
    "未闻花名 - secret base 你给我的所有": "ZONE | Hermes 转换",   # secret base 原唱
    "杀死那个石家庄人": "万能青年旅店 | Hermes 转换",   # 同名曲
    "某科学的超电磁炮 - only my railgun": "fripSide | Hermes 转换",   # 超炮 OP
    "桜日和": "星村麻衣 | Hermes 转换",   # BLEACH ED
    "残酷天使的行动纲领": "高橋洋子 | Hermes 转换",   # EVA OP
    "毛不易 - 一程山路": "毛不易 | Hermes 转换",   # 文件名
    "永恒绿洲": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "沢の河城工務店": "Foxtail-Grass Studio | Hermes 转换",   # 查证：2013 東方 arrange
    "海绵宝宝": "Patrick Pinney 等 | Hermes 转换",   # 查证：动画原声英文原唱
    "渊下宫": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "游戏人生 - There is a reason": "鈴木このみ | Hermes 转换",   # 查证：游戏人生 ZERO 片尾曲 演唱
    "烟Distance": "Capper & 罗言 | Hermes 转换",   # 查证：原曲《雪Distance》
    "狂妄之人": "Toby Fox | Hermes 转换",   # Undertale Megalovania
    "璃月": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "璃月云海": "HOYO-MiX（陈致逸） | Hermes 转换",   # 原神 BGM
    "甘城光辉游乐园OST - ソリテュード": "光宗信吉 | Hermes 转换",   # 甘城 OST 作曲
    "病名为爱": "Neru & z'5 | Hermes 转换",   # 病名は愛だった
    "白色相簿2 - After All 缀る想い": "上原れな | Hermes 转换",   # WA2 歌曲
    "白鹭归庭": "HOYO-MiX（陈致逸） | Hermes 转换",   # 查证：原神 神里绫华 PV 曲
    "童年": "罗大佑 | Hermes 转换",   # 同名曲
    "童祭": "ZUN（上海アリス幻樂団） | Hermes 转换",   # 東方 童祭
    "紫罗兰永恒花园 - Sincerely": "TRUE | Hermes 转换",   # 紫罗兰 OP
    "红莲华": "LiSA | Hermes 转换",   # 鬼灭之刃 OP
    "缘之空OST - Old Memory": "三轮学 | Hermes 转换",   # 缘之空 OST
    "缘之空OST - ツナグキズナ": "三轮学 | Hermes 转换",   # 缘之空 OST
    "群青": "YOASOBI | Hermes 转换",   # 同名曲
    "翼をください": "赤い鳥 | Hermes 转换",   # 1971 原唱
    "胡桃摇": "唐宁 | Hermes 转换",   # 查证：原曲《我和你》
    "致爱丽丝": "贝多芬 | Hermes 转换",   # Für Elise
    "菊次郎的春天": "久石让 | Hermes 转换",   # 《菊次郎の夏》Summer
    "菊花台C调弹唱": "周杰伦 | Hermes 转换",   # 同名曲
    "错位时空": "艾辰 | Hermes 转换",   # 同名曲
    "霜雪千年": "COP | Hermes 转换",   # 查证：2015 VOCALOID 原创
    "青鸟": "いきものがかり | Hermes 转换",   # 火影 ブルーバード
    "风居住的街道": "磯村由紀子 | Hermes 转换",   # 同名曲
    "高洁的法皇": "菅野祐悟 | Hermes 转换",   # 查证：JoJo 星尘斗士 插曲
    "魔法少女小圆 - コネクト": "ClariS | Hermes 转换",   # 小圆 OP
    "（原神演奏）彼女は旅に出る 她踏上了旅途——锁那": "鎖那 | Hermes 转换",   # 文件名自带
}


def author_for(name):
    """我方产物 author：有原作者排前面，没有就只写 Hermes 转换。"""
    return ARTISTS.get(name) or (AUTHOR_TAG + " 转换")


def strip_tag(s):
    """幂等剥离我方标签（含 Hermes·精简 这类变体标签），避免叠加两个；顺带规整空白。"""
    return __import__("re").sub(r"\s{2,}", " ", _HERMES_RE.sub("", s)).strip()


def hermes_tag(s):
    """源名自带变体标签（如 Hermes·精简）就沿用，否则用默认标签。"""
    m = _HERMES_RE.search(s)
    return m.group(0) if m else TAG


def tag_author(detail):
    return f"{AUTHOR_TAG} | {detail}"
DIR_MAP = {
    "1_BetterGI官方_原琴JSON": "01_原琴JSON",
    "6_balance_BVC": "01_原琴JSON",
    "7_键谱转换_MidiJson": "02_键谱转换JSON",
    "2_WindSong_MIDI": "03_MIDI原版",
    "4_acgmusic_MIDI": "03_MIDI原版",
}
ADAPT_DIR = "04_MIDI-21键适配JSON"
PLAIN = "—（键级谱，无音高映射问题）"


def pick(*paths):
    for p in paths:
        if os.path.isdir(p):
            return p
    return None


def source_index():
    """文件名 -> 原始来源目录名（scores/ 下的子目录）"""
    idx = collections.defaultdict(list)
    if not os.path.isdir(SCORES):
        return idx
    for d in sorted(os.listdir(SCORES)):
        p = os.path.join(SCORES, d)
        if not os.path.isdir(p):
            continue
        for f in os.listdir(p):
            if os.path.isfile(os.path.join(p, f)):
                idx[f].append(d)
    return idx


def midi_report():
    """曲名 -> 该曲在 midi转换报告.csv 里的整行（含 原可演奏率/八度折叠数/半音吸附…）"""
    out = {}
    if not os.path.exists(REPORT):
        return out
    with open(REPORT, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            key = (row.get("曲名") or "").strip()
            if not key:
                continue
            out[key] = {k: (v or "").strip() for k, v in row.items() if k}
    return out


def norm(s):
    """原仓库有乱码文件名（Piano\ufffd知我），去掉替换字符后做匹配"""
    return (s or "").replace("\ufffd", "").strip()


def loss_note(row, rate):
    """报告里的『可演奏数』是转换后映射数（snap 模式下≡原音符数），直接用会误导，
    所以这里只报原可演奏率 + 按该比例算出的丢失音符数。"""
    try:
        total = int(row.get("原音符数", "") or 0)
    except ValueError:
        total = 0
    if not total:
        return f"原可演奏 {rate:.1f}%"
    return f"原可演奏 {rate:.1f}%（丢约 {round(total * (1 - rate / 100))} 音 / 共 {total} 音）"


def rate_of(row):
    try:
        return float(row.get("原可演奏率", "0").rstrip("%"))
    except (ValueError, AttributeError):
        return 0.0


CODE_RE = __import__("re").compile(r"\s*[-_ ]\s*[A-Za-z0-9]{8}\s*$")
PLACEHOLDER = {"示例曲谱", "示例", "sample", ""}


def fix_display_name(path, stem):
    """官方个别文件 name 残留模板值（如『示例曲谱』），会让列表出现假重名 —— 用真实曲名替换。
    只改显示名 name 字段，notes/RelativePath 一概不动。"""
    try:
        with open(path, encoding="utf-8-sig") as fh:
            j = json.load(fh)
    except Exception:
        return None
    cur = (j.get("name") or "").strip()
    if cur not in PLACEHOLDER:
        return None
    real = CODE_RE.sub("", stem).strip() or stem
    j["name"] = real
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(j, fh, ensure_ascii=False, indent=1)
    return f"{cur or '<空>'} → {real}"


def safe_write_manifest(path, rows):
    """清单常被 Excel 占着（PermissionError），退化为写 .new 而不是整个脚本崩掉。"""
    def dump(p):
        with open(p, "w", encoding="utf-8-sig", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["曲名", "文件名", "所在目录", "类型", "来源", "可演奏率", "备注"])
            w.writerows(rows)
    try:
        dump(path)
        return path
    except PermissionError:
        alt = path[:-4] + "_new.csv"
        dump(alt)
        print(f"[!] {os.path.basename(path)} 被其他程序占用（Excel？），已改写为 {os.path.basename(alt)}")
        return alt


def load_json_ok(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            j = json.load(fh)
        return isinstance(j, dict) and "notes" in j
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-broken-midi", action="store_true",
                    help="把已丢音的 .mid 原件也放进 03_MIDI原版/（会与适配版重复成两条）")
    ap.add_argument("--adapt-all", action="store_true",
                    help="80 首 MIDI 全部加 21 键适配版，不止丢音的 48 首")
    ap.add_argument("--json-only", action="store_true",
                    help="曲库里不放任何 .mid（等价于 --adapt-all + 丢弃全部 .mid 原件）")
    args = ap.parse_args()
    if args.json_only:
        args.adapt_all = True

    old_lib = pick(OLD_LIB, OLD_LIB_ALT)
    adapt = pick(ADAPT, ADAPT_ALT)
    if not old_lib:
        sys.exit(f"[x] 找不到旧曲库目录：{OLD_LIB}")
    if not adapt:
        sys.exit(f"[x] 找不到 MIDI 适配产物目录：{ADAPT}")

    idx = source_index()
    rep = midi_report()
    # 只重建「脚本管理的」3 个子目录；用户自己加的目录（如 05_我的新增/）必须原样保留
    MANAGED = ("01_原琴JSON", "02_键谱转换JSON", "03_MIDI原版", ADAPT_DIR)
    os.makedirs(DEST, exist_ok=True)
    for d in MANAGED:
        sub = os.path.join(DEST, d)
        if os.path.isdir(sub):
            shutil.rmtree(sub)
    for d in ("01_原琴JSON", "02_键谱转换JSON", ADAPT_DIR):
        os.makedirs(os.path.join(DEST, d), exist_ok=True)
    if not args.json_only:
        os.makedirs(os.path.join(DEST, "03_MIDI原版"), exist_ok=True)

    rows, stats = [], collections.Counter()
    kept_mid, replaced_mid = [], []

    # ── 1. 旧曲库 257 份 ───────────────────────────────────────────────
    for f in sorted(os.listdir(old_lib)):
        src_path = os.path.join(old_lib, f)
        if not os.path.isfile(src_path):
            continue
        ext = os.path.splitext(f)[1].lower()
        origins = idx.get(f) or ["<未知来源>"]
        origin = origins[0]

        if ext == ".json":
            sub = DIR_MAP.get(origin, "01_原琴JSON")
            stem0 = os.path.splitext(f)[0]
            if sub == "02_键谱转换JSON":
                # 我方产物：统一打标签（改显示名 + 文件名，notes 不动）
                with open(src_path, encoding="utf-8-sig") as fh:
                    j = json.load(fh)
                base = strip_tag(stem0)
                j["name"] = base + TAG
                j["author"] = author_for(base)
                out_name = base + TAG + ".json"
                with open(os.path.join(DEST, sub, out_name), "w", encoding="utf-8") as fh:
                    json.dump(j, fh, ensure_ascii=False, indent=1)
                rows.append([base + TAG, out_name, sub, "MIDI JSON(键谱转换)", origin, PLAIN,
                             f"{author_for(base)}（原谱：{origin}）"])
            else:
                # 官方曲库：原样拷贝，只修个别残留的模板显示名
                shutil.copy2(src_path, os.path.join(DEST, sub, f))
                fixed = fix_display_name(os.path.join(DEST, sub, f), stem0)
                rows.append([stem0, f, sub, "原琴 JSON", origin, PLAIN,
                             (f"显示名修正：{fixed}" if fixed else "")])
            stats[sub] += 1
            continue

        if ext in (".mid", ".midi"):
            stem = os.path.splitext(f)[0]
            row = rep.get(stem) or rep.get(norm(stem)) or {}
            rate = rate_of(row) if row else 100.0
            note = loss_note(row, rate)
            if rate < 99.9 and args.adapt_all and not args.keep_broken_midi:
                replaced_mid.append(stem)          # 已有适配版接手
            elif rate >= 99.9 and args.json_only:
                replaced_mid.append(stem)          # --json-only：原件也换成适配版
            elif rate >= 99.9 or args.keep_broken_midi:
                shutil.copy2(src_path, os.path.join(DEST, "03_MIDI原版", f))
                rows.append([stem, f, "03_MIDI原版", "MIDI", origin, f"{rate:.1f}%",
                             note + ("｜原件保留" if rate < 99.9 else "")])
                stats["03_MIDI原版"] += 1
            else:
                replaced_mid.append(stem)
            continue
        stats["<跳过非谱文件>"] += 1

    # ── 2. MIDI 21 键适配版 ───────────────────────────────────────────
    adapt_names = sorted(os.listdir(adapt))
    for f in adapt_names:
        if not f.lower().endswith(".json"):
            continue
        stem = os.path.splitext(f)[0]
        row = rep.get(stem) or rep.get(norm(stem)) or {}
        rate = rate_of(row) if row else 0.0
        if not args.adapt_all and rate >= 99.9:
            continue                                   # 本来就好的、且不要求全 JSON，不必重复收
        with open(os.path.join(adapt, f), encoding="utf-8-sig") as fh:
            j = json.load(fh)
        base = strip_tag(stem)
        tg = hermes_tag(stem)
        j["name"] = base + tg
        j["author"] = author_for(base)          # 第一作者在前；查不到的只写 Hermes 转换
        out_name = base + tg + ".json"
        with open(os.path.join(DEST, ADAPT_DIR, out_name), "w", encoding="utf-8") as fh:
            json.dump(j, fh, ensure_ascii=False, indent=1)
        args_txt = (f"八度折叠 {row.get('八度折叠数', '?')}｜"
                    f"半音吸附 ↑{row.get('半音吸附↑', '?')}/↓{row.get('半音吸附↓', '?')}｜"
                    f"同键合并 {row.get('同键合并', '?')}｜最大同时按键 {row.get('最大同时按键', '?')}")
        rows.append([stem, out_name, ADAPT_DIR, "MIDI JSON(21键适配)", "MIDI 转换",
                     "100.0%",
                     f"{loss_note(row, rate)}；已折叠/吸附 — {args_txt}"])
        stats[ADAPT_DIR] += 1

    # ── 3. 清单 + 校验 ───────────────────────────────────────────────
    # 保留「非脚本管理目录」里用户自己加的曲目行，重跑不能被刷掉
    if os.path.exists(MANIFEST):
        try:
            seen = {(r[1], r[2]) for r in rows}          # (文件名, 目录) 去重，防重跑累积重复行
            for old in csv.reader(open(MANIFEST, encoding="utf-8-sig")):
                if len(old) >= 7 and old[2] not in MANAGED and old[2] not in ("所在目录",) \
                        and (old[1], old[2]) not in seen:
                    seen.add((old[1], old[2]))
                    rows.append(old)
        except Exception:
            pass
    rows.sort(key=lambda r: (r[2], r[0].lower()))
    man_path = safe_write_manifest(MANIFEST, rows)

    bad = []
    for r in rows:
        p = os.path.join(DEST, r[2], r[1])
        if not os.path.isfile(p):
            bad.append(("缺失", r[1]))
        elif r[1].lower().endswith(".json") and not load_json_ok(p):
            bad.append(("JSON 不可解析", r[1]))
        elif r[1].lower().endswith((".mid", ".midi")):
            with open(p, "rb") as fh:
                if fh.read(4) != b"MThd":
                    bad.append(("非合法 MIDI", r[1]))

    print("=" * 62)
    print("曲库目录  ", DEST)
    folders = ["01_原琴JSON", "02_键谱转换JSON"] + ([] if args.json_only else ["03_MIDI原版"]) + [ADAPT_DIR]
    for k in folders:
        print(f"  {k:24s} {stats[k]:4d} 首")
    print(f"  {'合计':24s} {sum(stats[k] for k in folders):4d} 首")
    print("-" * 62)
    print(f"曲库中不留 .mid 的原件：{len(replaced_mid)} 个（原件仍在 scores/ 与 327 首 zip 里）")
    if replaced_mid:
        print("  " + "、".join(replaced_mid[:6]) + ("…" if len(replaced_mid) > 6 else ""))
    print(f"清单：{man_path}（{len(rows)} 行）")
    print("校验：" + ("全部通过 ✅" if not bad else f"发现 {len(bad)} 个问题 ❌ {bad[:5]}"))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
