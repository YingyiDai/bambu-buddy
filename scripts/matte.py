#!/usr/bin/env python3
"""确定性去背：基于「均匀近白背景」的洪水填充抠像（替代 rembg）。

为什么不用 rembg：rembg 是逐帧独立的 ML 分割，对「白身体/白插座 + 白背景」
这类歧义区域，置信度逐帧抖动 → 同一元素时有时无、阴影忽隐忽现 → 闪烁。
本项目源视频背景是均匀近白(#fcfcfc)，可用确定性方法：

  1) 亮度候选：min(R,G,B) > bright 的像素视为「可能是背景」。
  2) 从四边边界对候选做连通域洪水填充 → 真正的背景（与边界相连的白）。
     熊猫白肚子/白插座虽是白色，但被深色描边/边缘与背景隔开，不与边界连通，
     因此不会被误删。
  3) subject = 非背景，再 fill_holes 补内部洞。
  4) 去掉小斑点；轻微 erode 收掉边缘亮边 halo；高斯羽化得到抗锯齿边。

确定性（同样的像素必得同样的结果）⇒ 逐帧一致 ⇒ 无闪烁。无 ML、无需下载模型、快。

用法：matte.py <in_dir> <out_dir> [--bright 228] [--erode 2] [--feather 1.0] [--min-speck 200]
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def matte_frame(rgb, bright, erode, feather, min_speck):
    cand = rgb.min(axis=2) > bright  # 接近背景白
    seed = np.zeros_like(cand)
    seed[0, :] = cand[0, :]; seed[-1, :] = cand[-1, :]
    seed[:, 0] = cand[:, 0]; seed[:, -1] = cand[:, -1]
    bg = ndimage.binary_propagation(seed, mask=cand)  # 与边界连通的背景
    subj = ndimage.binary_fill_holes(~bg)

    # 去掉孤立小斑点
    lbl, n = ndimage.label(subj)
    if n:
        sizes = ndimage.sum(subj, lbl, range(1, n + 1))
        subj = np.isin(lbl, np.nonzero(sizes >= min_speck)[0] + 1)

    # 收掉边缘亮边 halo
    if erode:
        subj = ndimage.binary_erosion(subj, iterations=erode)

    mask = np.where(subj, 255.0, 0.0)
    if feather:
        mask = ndimage.gaussian_filter(mask, feather)

    out = np.dstack([rgb, np.clip(mask, 0, 255).astype(np.uint8)])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("in_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--bright", type=int, default=228, help="判为背景的亮度阈值（min(RGB)）")
    ap.add_argument("--erode", type=int, default=2, help="边缘内缩像素，去亮边 halo")
    ap.add_argument("--feather", type=float, default=1.0, help="边缘羽化高斯半径(px)")
    ap.add_argument("--min-speck", type=int, default=200, help="小于该像素数的孤立块当噪点删除")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.in_dir, "*.png")))
    if not files:
        print(f"matte: 无输入帧 {args.in_dir}", file=sys.stderr)
        sys.exit(1)

    for f in files:
        rgb = np.array(Image.open(f).convert("RGB"))
        out = matte_frame(rgb, args.bright, args.erode, args.feather, args.min_speck)
        Image.fromarray(out, "RGBA").save(os.path.join(args.out_dir, os.path.basename(f)))

    print(f"matte: 处理 {len(files)} 帧 → {args.out_dir}")


if __name__ == "__main__":
    main()
