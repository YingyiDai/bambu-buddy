#!/usr/bin/env bash
# mp4 → webm(VP9 alpha) 批处理（技术文档 §4）。
#
# 本项目素材：熊猫为黑白配色、坐在 #fcfcfc 均匀近白背景上。
#
# 去背方法（MATTE_METHOD，默认 rembg）：
#   - rembg（默认）：ML 抠像 + clean_alpha.py 后处理。rembg 知道熊猫白脸/白肚
#       是主体，不会把白色主体误删（这点至关重要：白熊猫 + 白背景下，纯亮度/
#       洪水填充法会把白脸当背景一起删掉）。clean_alpha 再做：时间中值滤波抗
#       闪烁（插座/阴影/边缘）+ 二值化去软阴影 + fill_holes 补实主体。
#   - floodfill（MATTE_METHOD=floodfill，matte.py）：确定性洪水填充，仅适合
#       主体本身不含大面积近背景色的素材。本项目熊猫为白色，勿用——会删白脸。
#
# 依赖：
#   - ffmpeg / ffprobe
#   - rembg + scipy/numpy/pillow（项目内 .venv：
#       python3 -m venv .venv && .venv/bin/pip install "rembg[cpu]"）
#
# 用法：
#   bash scripts/process-videos.sh            # 处理全部
#   bash scripts/process-videos.sh idle       # 只处理某一个（源名，不含扩展名/中文均可，见 MAP）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/assets/source"
OUT_DIR="$ROOT/assets/anim"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# 项目 venv 的 python（matte.py / clean_alpha.py 用）
if [ -x "$ROOT/.venv/bin/python" ]; then
  PYTHON="$ROOT/.venv/bin/python"
else
  PYTHON="python3"
fi

# 抠像方法：rembg（默认，主体安全）| floodfill（仅非白色主体素材，见头部说明）。
MATTE_METHOD="${MATTE_METHOD:-rembg}"
MODEL="${REMBG_MODEL:-u2net}"  # 仅 rembg 方法用

# rembg 可执行文件（仅 rembg 方法需要）：优先项目 venv
REMBG=""
if [ "$MATTE_METHOD" = "rembg" ]; then
  if [ -x "$ROOT/.venv/bin/rembg" ]; then REMBG="$ROOT/.venv/bin/rembg"
  elif command -v rembg >/dev/null 2>&1; then REMBG="$(command -v rembg)"
  else
    echo "✗ MATTE_METHOD=rembg 但未找到 rembg。装：.venv/bin/pip install \"rembg[cpu]\"" >&2
    exit 1
  fi
fi

# 统一输出帧率与画布（导出 2x 适配 Retina，§4 步骤 4）。
FPS=30
# 目标画布（webm 像素）。源为 828x1108 竖图；统一缩放到同一高度，
# 居中放到固定画布，保证切状态时锚点一致、不跳动。
CANVAS_W=640
CANVAS_H=640

# 源文件（中文名） → 输出文件（ASCII）映射（§4.1 / §4.2）
declare -a MAP=(
  "idle.mp4|idle.webm"
  "未连接.mp4|offline.webm"
  "准备中.mp4|prepare.webm"
  "打印中-0%.mp4|printing_0.webm"
  "打印中-25%.mp4|printing_25.webm"
  "打印中-50%.mp4|printing_50.webm"
  "打印中-75%.mp4|printing_75.webm"
  "打印中-换料.mp4|changing_filament.webm"
  "暂停.mp4|paused.webm"
  "打印完成.mp4|finished.webm"
  "失败.mp4|failed.webm"
)

mkdir -p "$OUT_DIR"

FILTER_ONLY="${1:-}"

process_one() {
  local src="$1" out="$2"
  local src_path="$SRC_DIR/$src"
  local out_path="$OUT_DIR/$out"

  if [ ! -f "$src_path" ]; then
    echo "  ⚠ 跳过（源不存在）：$src"
    return 0
  fi

  echo "▶ $src → $out  [$MATTE_METHOD]"
  local work="$TMP_DIR/${out%.webm}"
  mkdir -p "$work/raw" "$work/cut"

  # 1) 抽帧为 PNG 序列
  ffmpeg -v error -y -i "$src_path" -vf "fps=$FPS" "$work/raw/%04d.png"

  # 2) 抠像 → 带 alpha 的 PNG 序列（$work/cut）
  if [ "$MATTE_METHOD" = "rembg" ]; then
    echo "    rembg · $MODEL …"
    "$REMBG" p -m "$MODEL" "$work/raw" "$work/tmp_rembg" >/dev/null 2>&1 || "$REMBG" p -m "$MODEL" "$work/raw" "$work/tmp_rembg"
    echo "    清理 alpha（fill_holes + 羽化）…"
    "$PYTHON" "$ROOT/scripts/clean_alpha.py" "$work/tmp_rembg" "$work/cut"
  else
    # 确定性洪水填充去背：无闪烁、快（见脚本头部说明）
    echo "    洪水填充去背（确定性，抗闪烁）…"
    "$PYTHON" "$ROOT/scripts/matte.py" "$work/raw" "$work/cut"
  fi

  # 3) 合成 webm/VP9 alpha，统一缩放到画布（同一高度、居中、透明留白）
  ffmpeg -v error -y -framerate "$FPS" -i "$work/cut/%04d.png" \
    -vf "scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=#00000000,format=yuva420p" \
    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 28 -an \
    "$out_path"

  echo "    ✓ 输出 $out_path"
}

for entry in "${MAP[@]}"; do
  src="${entry%%|*}"
  out="${entry##*|}"
  if [ -n "$FILTER_ONLY" ]; then
    # 允许用源名或输出名过滤
    if [ "$src" != "$FILTER_ONLY" ] && [ "$out" != "$FILTER_ONLY" ] && [ "${out%.webm}" != "$FILTER_ONLY" ]; then
      continue
    fi
  fi
  process_one "$src" "$out"
done

echo "完成。输出目录：$OUT_DIR"
echo "提示：请人工过目边缘与接缝（§4.3）。可抽帧自检："
echo "  ffmpeg -i $OUT_DIR/idle.webm -vframes 1 /tmp/check.png"
