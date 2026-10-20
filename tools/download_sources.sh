#!/usr/bin/env bash
# 原神自动演奏曲谱一键下载 —— BetterGI / 原琴 (AutoYuanQin) 体系
# 用法:  bash download.sh  [目标目录]        默认 ./scores
# 说明:  用 git sparse-checkout 只拉曲谱子目录，不拖整个仓库
set -u
SELF="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$SELF/publicsource/sources}"
WORK="${TMPDIR:-/tmp}/score_dl_$$"
mkdir -p "$OUT" "$WORK"
echo "目标目录: $OUT"
echo

fetch() {  # $1=repo  $2=子目录  $3=本地目标名
  local repo="$1" sub="$2" dest="$3"
  local name
  name="$(echo "$repo" | tr '/' '_')"
  rm -rf "$name"
  if ! git clone --depth 1 --filter=blob:none --sparse -q "https://github.com/$repo.git" "$name" 2>/dev/null; then
    echo "  [FAIL] clone 失败: $repo"; return 1
  fi
  if ! ( cd "$name" && git sparse-checkout set "$sub" ) 2>/dev/null; then
    echo "  [FAIL] sparse-checkout 失败: $sub"; return 1
  fi
  mkdir -p "$OUT/$dest"
  if [ ! -d "$name/$sub" ]; then echo "  [FAIL] 目录不存在: $sub"; return 1; fi
  find "$name/$sub" -type f \
    \( -name '*.json' -o -name '*.mid' -o -name '*.midi' -o -name '*.txt' \) \
    -exec cp -f {} "$OUT/$dest/" \;
  echo "  [OK] $dest : $(ls -1 "$OUT/$dest" | wc -l) 个  <- $repo/$sub"
}

cd "$WORK" || exit 1

echo "== 1) BetterGI 官方曲库 AutoYuanQin（127）=="
fetch babalae/bettergi-scripts-list "repo/js/AutoYuanQin/assets/score_file" "1_BetterGI官方_原琴JSON"
echo "== 2) WindSong-Lyre MIDI（89）=="
fetch luern0313/WindSong-Lyre-Genshin-Impact "midi" "2_WindSong_MIDI"
echo "== 3) GenshinAutoPlayLyre 键谱txt（74）=="
fetch MRevenger/GenshinAutoPlayLyre "music" "3_AutoPlayLyre_键谱txt"
echo "== 4) acgmusic MIDI（15）=="
fetch acgmusic/GenshinAutoHarpPlayer-master "genshin_auto_harp_player" "4_acgmusic_MIDI"
echo "== 5) crazoter 覆盖层谱面（15）=="
fetch crazoter/Genshin-Lyre-Overlay "src/music" "5_lyre_overlay"
echo "== 6) balance-BVC 个人曲库（4）=="
fetch balance-BVC/balance_BVC-autoyuanqin-scores "repo/js/AutoYuanQin-balance/assets/score_file" "6_balance_BVC"

cd "$SELF" || true
rm -rf "$WORK"
echo
echo "完成："
for d in "$OUT"/*/; do [ -d "$d" ] && printf '  %4s  %s\n' "$(ls -1 "$d" | wc -l)" "$(basename "$d")"; done
echo "  总计 $(find "$OUT" -type f | wc -l) 个曲谱文件"
