#!/usr/bin/env python3
"""Generate a rounded-corner Windows app icon from the square source.

macOS masks app icons into a rounded "squircle" automatically, but classic
Win32 apps (this Electron app is packaged with NSIS) render the .ico exactly
as provided — a full-bleed square shows up square. To match the macOS look on
Windows we bake the rounded corners (with transparent corners) into the icon.

Outputs:
  assets/icon/AppIcon.win.png  – 1024px rounded source (for future regen)
  assets/icon/AppIcon.ico      – multi-size icon consumed by electron-builder
"""
import os
import struct
from io import BytesIO

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "..", "assets", "icon")
SRC = os.path.join(ICON_DIR, "AppIcon.png")
OUT_PNG = os.path.join(ICON_DIR, "AppIcon.win.png")
OUT_ICO = os.path.join(ICON_DIR, "AppIcon.ico")

# Corner radius as a fraction of the icon side. ~22.37% mimics Apple's
# rounded-rectangle icon grid so the Windows icon reads like the macOS one.
RADIUS_RATIO = 0.2237
# ICO entries. Windows Vista+ reads PNG-encoded entries at every size.
ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]
# Supersampling factor for a smooth, anti-aliased corner mask.
SS = 4


def rounded(im: Image.Image, size: int) -> Image.Image:
    """Return a `size`x`size` RGBA image of `im` with rounded, transparent corners."""
    art = im.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)

    # Build the mask at SSx resolution then downsample for clean edges.
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1),
        radius=int(round(big * RADIUS_RATIO)),
        fill=255,
    )
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(art, (0, 0), mask)
    return out


def write_ico(images, path):
    """Pack a list of square RGBA images into a PNG-based .ico file."""
    entries = []
    for img in images:
        buf = BytesIO()
        img.save(buf, format="PNG")
        entries.append((img.width, buf.getvalue()))

    offset = 6 + 16 * len(entries)
    header = struct.pack("<HHH", 0, 1, len(entries))
    dir_entries = b""
    data = b""
    for side, png in entries:
        b = 0 if side >= 256 else side  # 0 means 256 in ICO
        dir_entries += struct.pack(
            "<BBBBHHII", b, b, 0, 0, 1, 32, len(png), offset
        )
        data += png
        offset += len(png)

    with open(path, "wb") as f:
        f.write(header + dir_entries + data)


def main():
    src = Image.open(SRC)

    # Full-size rounded source for reference / future regeneration.
    rounded(src, 1024).save(OUT_PNG)

    # Render each ICO size individually so small sizes stay crisp.
    images = [rounded(src, s) for s in ICO_SIZES]
    write_ico(images, OUT_ICO)

    print("Wrote", OUT_PNG)
    print("Wrote", OUT_ICO, "sizes:", ICO_SIZES)


if __name__ == "__main__":
    main()
