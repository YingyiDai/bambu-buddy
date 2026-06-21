#!/usr/bin/env bash
# 处理「人工去阴影」素材 → assets/anim/*.webm（确定性颜色距离抠像，无闪烁）。
#
# 这些源视频已由人工去掉阴影、背景为高度均匀近白色，故用 scripts/matte.py 的
# 确定性 color key（见该文件说明）：同样像素必得同样结果 ⇒ 逐帧一致 ⇒ 不闪烁。
# 比 rembg 更稳（rembg 逐帧 ML 会偶发去掉物体）、更快（无需模型）。
#
# 用法：
#   bash scripts/process-deshadow.sh                 # 处理文件夹内所有已存在的视频
#   bash scripts/process-deshadow.sh printing_0      # 只处理某个输出
#   TOL=9 bash scripts/process-deshadow.sh           # 调整颜色容差
#
# 文件夹里放齐对应中文名即可（缺的自动跳过）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/assets/source/人工去阴影"
OUT_DIR="$ROOT/assets/anim"
PYTHON="$ROOT/.venv/bin/python"; [ -x "$PYTHON" ] || PYTHON="python3"

FPS=30; CANVAS_W=640; CANVAS_H=640
TOL="${TOL:-9}"

# 源文件（中文名） → 输出文件（ASCII）
declare -a MAP=(
  "未连接.mp4|offline.webm"
  "成功.mp4|finished.webm"
  "失败.mp4|failed.webm"
  "打印中-换料.mp4|changing_filament.webm"
  "打印中-进度0%.mp4|printing_0.webm"
  "打印中-进度25%.mp4|printing_25.webm"
  "打印中-进度50%.mp4|printing_50.webm"
  "打印中-进度75%.mp4|printing_75.webm"
  "空闲.mp4|idle.webm"
  "准备中.mp4|prepare.webm"
  "暂停.mp4|paused.webm"
)

mkdir -p "$OUT_DIR"
FILTER="${1:-}"
TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT

for entry in "${MAP[@]}"; do
  src="${entry%%|*}"; out="${entry##*|}"
  [ -f "$SRC_DIR/$src" ] || continue
  if [ -n "$FILTER" ] && [ "$out" != "$FILTER" ] && [ "${out%.webm}" != "$FILTER" ]; then continue; fi

  echo "▶ $src → $out  [colorkey tol=$TOL]"
  w="$TMP_DIR/${out%.webm}"; mkdir -p "$w/raw" "$w/cut"
  ffmpeg -v error -y -i "$SRC_DIR/$src" -vf "fps=$FPS" "$w/raw/%04d.png"
  "$PYTHON" "$ROOT/scripts/matte.py" "$w/raw" "$w/cut" --tol "$TOL"
  ffmpeg -v error -y -framerate "$FPS" -i "$w/cut/%04d.png" \
    -vf "scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=#00000000,format=yuva420p" \
    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 28 -an "$OUT_DIR/$out"
  echo "  ✓ $out"
done
echo "完成 → $OUT_DIR"
