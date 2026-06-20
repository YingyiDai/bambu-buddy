#!/usr/bin/env python3
"""清理 rembg 输出的 alpha：保证主体实心、去背景投影、消除帧间闪烁。

背景：rembg 是逐帧独立的 ML 分割，对「白身体/白插座 + 白背景」歧义区域置信度
逐帧抖动 → 元素忽隐忽现、阴影忽闪。但 rembg 不会把熊猫白脸误删（它知道那是主体），
所以以 rembg 为主体来源是安全的——关键是再做稳定与补实：

序列级处理（一次性读入整段）：
  1) 时间中值滤波（temporal median，窗口 tmedian）——核心抗闪烁：
     对每个像素在相邻帧上取 alpha 中值，单帧的伪掉落/伪出现被邻帧"投票"覆盖，
     插座、阴影、边缘的逐帧抖动都被抚平；主体本身 alpha≈255 不受影响。
逐帧处理：
  2) 阈值二值化（thr）——低于阈值的软阴影被一致地去掉（去投影）。
  3) fill_holes —— 填掉白肚子等被主体包围的内部空洞（保证主体实心）。
  4) 去掉孤立小斑点（min_speck）。
  5) 羽化（feather）—— 边缘抗锯齿、稳定。

用法：clean_alpha.py <in_dir> <out_dir> [--thr 140] [--tmedian 5]
                     [--min-speck 200] [--feather 1.0]
"""
import argparse
import glob
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("in_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--thr", type=int, default=140, help="alpha 二值化阈值（越高越能去掉软阴影）")
    ap.add_argument("--tmedian", type=int, default=5, help="时间中值滤波窗口（奇数，1=关闭）")
    ap.add_argument("--min-speck", type=int, default=200, help="小于该像素数的孤立块当噪点删除")
    ap.add_argument("--feather", type=float, default=1.0, help="边缘羽化高斯半径(px)")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.in_dir, "*.png")))
    if not files:
        print(f"clean_alpha: 无输入帧 {args.in_dir}", file=sys.stderr)
        sys.exit(1)

    imgs = [np.array(Image.open(f).convert("RGBA")) for f in files]
    alphas = np.stack([im[:, :, 3] for im in imgs]).astype(np.uint8)  # (T,H,W)

    # 1) 时间中值滤波（抗闪烁核心）
    w = args.tmedian
    if w and w > 1 and len(files) >= 3:
        w = w if w % 2 == 1 else w + 1
        alphas = ndimage.median_filter(alphas, size=(w, 1, 1), mode="nearest")

    for i, (f, im) in enumerate(zip(files, imgs)):
        a = alphas[i].astype(np.float32)
        solid = a > args.thr

        # 3) 填补被主体包围的内部空洞（白肚子等）
        solid = ndimage.binary_fill_holes(solid)

        # 4) 去掉孤立小斑点
        lbl, n = ndimage.label(solid)
        if n:
            sizes = ndimage.sum(solid, lbl, range(1, n + 1))
            solid = np.isin(lbl, np.nonzero(sizes >= args.min_speck)[0] + 1)

        # 5) 二值化 + 羽化，得到帧间稳定、抗锯齿的边缘
        mask = np.where(solid, 255.0, 0.0)
        if args.feather:
            mask = ndimage.gaussian_filter(mask, args.feather)

        out = im.copy()
        out[:, :, 3] = np.clip(mask, 0, 255).astype(np.uint8)
        Image.fromarray(out, "RGBA").save(os.path.join(args.out_dir, os.path.basename(f)))

    print(f"clean_alpha: 处理 {len(files)} 帧（tmedian={w}, thr={args.thr}）→ {args.out_dir}")


if __name__ == "__main__":
    main()
