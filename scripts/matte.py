#!/usr/bin/env python3
"""确定性去背：根据背景自动选择「色度抠像(chroma)」或「颜色距离抠像」。

为什么用确定性方法而非 rembg：
  rembg 等逐帧 ML 分割是非确定性的——同一物体在某些帧会被部分/整体去掉，
  造成无法根除的闪烁。确定性方法（同样像素必得同样结果）⇒ 逐帧完全一致
  ⇒ 闪烁在原理上不可能发生。

两种背景，自动判别（看边界中值的饱和度）：
  ① 纯色高饱和背景（红/蓝幕等，推荐）→ 色度抠像 chroma：
     按背景主色通道的"主导度" key = bg主通道 - max(其余两通道)。背景任何明暗
     都被去掉（解决墙/地不同深浅的问题）；熊猫黑白灰、绿料、红三角等主导度
     方向不同，被完整保留。背景色与熊猫颜色相距极远 ⇒ 容差余量巨大 ⇒ 即便
     源视频有压缩噪声也不会有像素卡在阈值边界 ⇒ 最稳、最干净（实测 std≈1%）。
  ② 近白/灰背景 → 颜色距离抠像：到精确背景色的欧氏距离 + 紧容差。白熊猫经
     渲染有明暗色调，与纯平背景白可分辨；但余量小，边缘易随源噪声轻微抖动，
     故优先用①的纯色背景。

公共步骤：从四边边界连通域洪水填充出背景 → 取反得主体 → fill_holes 补内部洞
        （白肚子/白卷芯/白厕纸）→ 去小斑点 → erode 收残边 → 高斯羽化。

用法：matte.py <in_dir> <out_dir> [--chroma-thr 30] [--white-tol 9]
                [--erode 1] [--feather 0.8] [--min-speck 150] [--mode auto|chroma|white]
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def _border_bg(rgb):
    ring = np.concatenate([
        rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3),
        rgb[:, :8].reshape(-1, 3), rgb[:, -8:].reshape(-1, 3),
    ])
    return np.median(ring, axis=0)


def _bg_candidate(rgb, bg, mode, chroma_thr, white_tol):
    """返回布尔图：疑似背景的像素。"""
    if mode == "chroma":
        ch = int(np.argmax(bg))
        others = [i for i in range(3) if i != ch]
        key = rgb[:, :, ch] - np.maximum(rgb[:, :, others[0]], rgb[:, :, others[1]])
        return key > chroma_thr
    # white/gray：颜色距离
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    return dist < white_tol


def matte_frame(rgb, mode, chroma_thr, white_tol, erode, feather, min_speck, despill=True):
    rgb = rgb.astype(np.int32)
    bg = _border_bg(rgb)
    if mode == "auto":
        # 背景饱和度高 → chroma；否则近白/灰 → 距离
        mode = "chroma" if (bg.max() - bg.min()) > 40 else "white"

    cand = _bg_candidate(rgb, bg, mode, chroma_thr, white_tol)

    if mode == "chroma":
        # 色度抠像：背景色（蓝）在熊猫身上完全不存在，所以「所有」蓝像素都是背景，
        # 包括被主体包围的缝隙（如三角与身体间露出的蓝）。直接全部去掉，
        # 绝不能做 fill_holes —— 否则会把这些被包围的蓝缝重新填成主体 → 蓝色残留/闪烁。
        subj = ~cand
        # 仅闭合 1px 级的针孔噪点（不会填上三角缝那种大缝）
        subj = ndimage.binary_closing(subj, iterations=1)
    else:
        # 近白/灰背景：cand 含主体白色部分，需用边界连通区分「背景白」与「主体白」，
        # 再 fill_holes 补主体内部洞（白肚子等）。
        seed = np.zeros_like(cand)
        seed[0, :] = cand[0, :]; seed[-1, :] = cand[-1, :]
        seed[:, 0] = cand[:, 0]; seed[:, -1] = cand[:, -1]
        bgmask = ndimage.binary_propagation(seed, mask=cand)
        subj = ndimage.binary_fill_holes(~bgmask)

    lbl, n = ndimage.label(subj)
    if n:
        sizes = ndimage.sum(subj, lbl, range(1, n + 1))
        subj = np.isin(lbl, np.nonzero(sizes >= min_speck)[0] + 1)

    if erode:
        subj = ndimage.binary_erosion(subj, iterations=erode)

    mask = np.where(subj, 255.0, 0.0)
    if feather:
        mask = ndimage.gaussian_filter(mask, feather)

    out_rgb = rgb.astype(np.int32)
    if mode == "chroma" and despill:
        # 去溢色（despill）：把每个像素的「背景主色通道」压到不超过其余通道，
        # 消除细边缘（如绿线团缝隙）残留的蓝/青色，但不动本来就不偏蓝的像素
        # （绿线、白身体的该通道本就不占优，保持不变）。
        # 把背景主色通道压到「其余两通道的较小值」——足够强地把细边缘残留的青/蓝
        # 中和成与主体一致的颜色（绿线团边缘→绿），同时不动白/黑/绿/红等正常像素。
        ch = int(np.argmax(_border_bg(rgb)))
        others = [i for i in range(3) if i != ch]
        cap = np.minimum(out_rgb[:, :, others[0]], out_rgb[:, :, others[1]])
        out_rgb[:, :, ch] = np.minimum(out_rgb[:, :, ch], cap)

    return np.dstack([out_rgb.astype(np.uint8), np.clip(mask, 0, 255).astype(np.uint8)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("in_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--mode", choices=["auto", "chroma", "white"], default="auto")
    ap.add_argument("--chroma-thr", type=float, default=30.0, help="色度主导度阈值（越小去得越多）")
    ap.add_argument("--white-tol", type=float, default=9.0, help="近白背景颜色距离容差")
    ap.add_argument("--erode", type=int, default=1)
    ap.add_argument("--feather", type=float, default=0.8)
    ap.add_argument("--min-speck", type=int, default=150)
    ap.add_argument("--no-despill", action="store_true", help="关闭去溢色（默认开，chroma 模式生效）")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.in_dir, "*.png")))
    if not files:
        print(f"matte: 无输入帧 {args.in_dir}", file=sys.stderr)
        sys.exit(1)

    for f in files:
        rgb = np.array(Image.open(f).convert("RGB"))
        out = matte_frame(rgb, args.mode, args.chroma_thr, args.white_tol,
                          args.erode, args.feather, args.min_speck,
                          despill=not args.no_despill)
        Image.fromarray(out, "RGBA").save(os.path.join(args.out_dir, os.path.basename(f)))

    print(f"matte: 处理 {len(files)} 帧（mode={args.mode}）→ {args.out_dir}")


if __name__ == "__main__":
    main()
