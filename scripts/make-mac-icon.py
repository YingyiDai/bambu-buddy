#!/usr/bin/env python3
"""Generate a macOS-grid app icon (rounded squircle + transparent margin).

Contrary to a common belief, macOS does NOT reliably round app icons for you.
Only macOS 26 (Tahoe) auto-clips legacy square icons into the system squircle;
on macOS 15 (Sequoia) and earlier the Dock renders the icon file exactly as
provided — a full-bleed square shows up square. To look right on EVERY macOS
version we bake the rounded corners AND the transparent safe-area margin into
the icon ourselves, matching Apple's macOS icon grid.

Apple's macOS icon grid on a 1024 canvas:
  - icon body: 824x824, centered → 100px transparent margin on each side
  - corner radius: ~185.4px (≈0.225 of the body side)

Input:
  assets/icon/AppIcon.png       – 1024px full-bleed square master (shared source)
Output:
  assets/icon/AppIcon.mac.png   – 1024px rounded+inset PNG consumed by
                                  electron-builder (mac.icon) and app.dock.setIcon
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "..", "assets", "icon")
SRC = os.path.join(ICON_DIR, "AppIcon.png")
OUT_PNG = os.path.join(ICON_DIR, "AppIcon.mac.png")

# Full canvas size and Apple's macOS icon grid within it.
CANVAS = 1024
BODY = 824          # icon body side → 100px transparent margin all around
MARGIN = (CANVAS - BODY) // 2
RADIUS = 185        # corner radius on the 824 body (~0.225 of body side)
# Supersampling factor for a smooth, anti-aliased corner mask.
SS = 4


def rounded_body(im: Image.Image) -> Image.Image:
    """Return a BODYxBODY RGBA of `im` with rounded, transparent corners."""
    art = im.convert("RGBA").resize((BODY, BODY), Image.Resampling.LANCZOS)

    # Build the mask at SSx resolution then downsample for clean edges.
    big = BODY * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1),
        radius=RADIUS * SS,
        fill=255,
    )
    mask = mask.resize((BODY, BODY), Image.Resampling.LANCZOS)

    out = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0))
    out.paste(art, (0, 0), mask)
    return out


def main():
    src = Image.open(SRC)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(rounded_body(src), (MARGIN, MARGIN), rounded_body(src))
    canvas.save(OUT_PNG)
    print("Wrote", OUT_PNG, f"({CANVAS}px, body {BODY}px, margin {MARGIN}px, radius {RADIUS}px)")


if __name__ == "__main__":
    main()
