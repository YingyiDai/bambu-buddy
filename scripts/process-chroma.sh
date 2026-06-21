#!/usr/bin/env bash
# 蓝幕（色度抠像）批处理：assets/source/替换背景色/*.mp4 → assets/anim/*.webm
#
# 最终定案的去背方案（见 matte.py）：
#   纯色背景（推荐蓝幕）→ 确定性色度抠像，逐帧完全一致 ⇒ 0 闪烁；
#   去掉「所有」背景色像素（含被主体包围的缝隙，绝不 fill_holes）⇒ 无缝隙残留；
#   despill 去溢色 ⇒ 细边缘（绿线团等）无青/蓝边。
#   背景主色通道由 matte.py 自动识别（蓝幕走蓝，红幕走红），故红/蓝幕都能处理。
#
# 源文件命名：中文状态名，可带 -蓝色背景 / -红色背景 后缀（会自动去除）。
#   同一状态若红蓝都存在 → 优先用蓝幕版。
#
# 用法：
#   bash scripts/process-chroma.sh              # 处理文件夹内全部
#   bash scripts/process-chroma.sh failed       # 只处理某个输出名

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 源文件夹：默认最新的「替换背景色+微调大小」，可用 CHROMA_SRC 覆盖。
SRC_DIR="${CHROMA_SRC:-$ROOT/assets/source/替换背景色+微调大小}"
OUT_DIR="$ROOT/assets/anim"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PYTHON="$ROOT/.venv/bin/python"; [ -x "$PYTHON" ] || PYTHON="python3"

FPS=30
CANVAS_W=640
CANVAS_H=640
CHROMA_THR="${CHROMA_THR:-15}"   # 色度主导度阈值（实测 15 最佳）

# 中文状态名（去掉背景色后缀后）→ 输出 webm 名。含常见别名。
map_output() {
  case "$1" in
    未连接|离线) echo "offline.webm" ;;
    空闲|待机) echo "idle.webm" ;;
    准备中|准备) echo "prepare.webm" ;;
    打印中-进度0%|打印中-进度0|打印中-0%|打印中0%) echo "printing_0.webm" ;;
    打印中-进度25%|打印中-进度25|打印中-25%|打印中25%) echo "printing_25.webm" ;;
    打印中-进度50%|打印中-进度50|打印中-50%|打印中50%) echo "printing_50.webm" ;;
    打印中-进度75%|打印中-进度75|打印中-75%|打印中75%) echo "printing_75.webm" ;;
    打印中-换料|换料|换料中) echo "changing_filament.webm" ;;
    暂停|已暂停) echo "paused.webm" ;;
    成功|打印完成|完成) echo "finished.webm" ;;
    失败|打印失败) echo "failed.webm" ;;
    *) echo "" ;;
  esac
}

# 去掉文件名里的背景色后缀，返回纯状态名
strip_bg_suffix() {
  local n="$1"
  n="${n%-蓝色背景}"; n="${n%-红色背景}"
  n="${n%-蓝色}"; n="${n%-红色}"; n="${n%-蓝}"; n="${n%-红}"
  echo "$n"
}

FILTER_ONLY="${1:-}"

process_one() {
  local src_path="$1" out="$2"
  local out_path="$OUT_DIR/$out"
  echo "▶ $(basename "$src_path") → $out  [chroma thr=$CHROMA_THR]"
  local work="$TMP_DIR/${out%.webm}"
  mkdir -p "$work/raw" "$work/cut"

  # 个别状态主体本身含背景色元素，需保留封闭背景色：
  #   换料动画 头上有蓝色汗珠 → --preserve-enclosed（只去边界连通的蓝，保留汗珠）
  local extra=""
  case "$out" in
    changing_filament.webm) extra="--preserve-enclosed" ;;
  esac

  # -nostdin：避免 ffmpeg 吞掉 while-read 循环的管道输入（否则下一轮 read 错乱）
  ffmpeg -nostdin -v error -y -i "$src_path" -vf "fps=$FPS" "$work/raw/%04d.png"
  "$PYTHON" "$ROOT/scripts/matte.py" "$work/raw" "$work/cut" \
    --mode chroma --chroma-thr "$CHROMA_THR" $extra
  ffmpeg -nostdin -v error -y -framerate "$FPS" -i "$work/cut/%04d.png" \
    -vf "scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=#00000000,format=yuva420p" \
    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 28 -an \
    "$out_path"
  echo "    ✓ 输出 $out_path"
}

[ -d "$SRC_DIR" ] || { echo "✗ 找不到文件夹：$SRC_DIR" >&2; exit 1; }
mkdir -p "$OUT_DIR"

# 收集候选到临时清单：out <TAB> 蓝幕优先级(1蓝/0其它) <TAB> 源路径
# （兼容 macOS bash 3.2，不用关联数组；用 sort 让同一 out 的蓝幕版排在前）
LIST="$TMP_DIR/list.tsv"; : > "$LIST"
shopt -s nullglob
for src_path in "$SRC_DIR"/*.mp4; do
  base="$(basename "$src_path" .mp4)"
  state="$(strip_bg_suffix "$base")"
  out="$(map_output "$state")"
  if [ -z "$out" ]; then
    echo "  ⚠ 跳过（未识别状态名）：$base" >&2
    continue
  fi
  prio=0; case "$base" in *蓝色*) prio=1 ;; esac
  printf '%s\t%s\t%s\n' "$out" "$prio" "$src_path" >> "$LIST"
done

# 按 out 升序、蓝幕优先级降序排序，每个 out 取第一行（即蓝幕版优先）
count=0
while IFS=$'\t' read -r out prio src_path; do
  if [ -n "$FILTER_ONLY" ] && [ "$out" != "$FILTER_ONLY" ] && [ "${out%.webm}" != "$FILTER_ONLY" ]; then
    continue
  fi
  process_one "$src_path" "$out"
  count=$((count+1))
done < <(sort -t$'\t' -k1,1 -k2,2nr "$LIST" | awk -F'\t' '!seen[$1]++')

echo "完成：处理 $count 个状态 → $OUT_DIR"
