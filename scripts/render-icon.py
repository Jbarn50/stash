#!/usr/bin/env python3
"""Build Stash's icon files from build/icon.png.

The 1024 master is the desktop, Start Menu, and installer art. Sizes 24px and
below are a simpler drawer-and-gauge drawn here, because the full picture
turns to mud at taskbar size. Run from the repo root:

    python3 scripts/render-icon.py
"""

from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = ROOT / "build" / "icon.png"

# Sizes Windows actually asks the exe icon for, including a few DPI steps.
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
# Below this, ship the drawn mark instead of a scaled photograph.
SIMPLE_MAX = 24

# OSTypes macOS reads as PNG. ic13/ic14 repeat 256 and 512 at a higher scale.
ICNS_CHUNKS = (
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
    (b"ic11", 32),
    (b"ic12", 64),
    (b"ic13", 256),
    (b"ic14", 512),
)

TEAL = (16, 67, 70, 255)
CREAM = (246, 230, 206, 255)
WELL = (232, 214, 186, 255)
GOLD = (196, 140, 48, 255)
MINT = (90, 214, 158, 255)
HANDLE = (173, 128, 57, 255)


def simple_mark(size: int) -> Image.Image:
    """A drawer, a two-tone space ring, and a handle. Drawn large, then scaled."""
    scale = 8
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    margin = int(canvas * 0.045)
    draw.rounded_rectangle(
        [margin, margin, canvas - margin - 1, canvas - margin - 1],
        radius=int(canvas * 0.22),
        fill=TEAL,
    )
    draw.rounded_rectangle(
        [int(canvas * 0.16), int(canvas * 0.20), int(canvas * 0.84), int(canvas * 0.82)],
        radius=int(canvas * 0.09),
        fill=CREAM,
    )
    draw.rounded_rectangle(
        [int(canvas * 0.24), int(canvas * 0.28), int(canvas * 0.76), int(canvas * 0.60)],
        radius=int(canvas * 0.05),
        fill=WELL,
    )
    center_x = canvas // 2
    center_y = int(canvas * 0.445)
    outer = int(canvas * 0.145)
    inner = int(canvas * 0.082)
    ring = [center_x - outer, center_y - outer, center_x + outer, center_y + outer]
    draw.ellipse(ring, fill=GOLD)
    # Pillow measures pies from 3 o'clock, clockwise. 200–330 is the left side.
    draw.pieslice(ring, start=200, end=330, fill=MINT)
    draw.ellipse(
        [center_x - inner, center_y - inner, center_x + inner, center_y + inner],
        fill=WELL,
    )
    handle_top = int(canvas * 0.665)
    handle_bottom = int(canvas * 0.745)
    draw.rounded_rectangle(
        [int(canvas * 0.34), handle_top, int(canvas * 0.66), handle_bottom],
        radius=(handle_bottom - handle_top) // 2,
        fill=HANDLE,
    )
    return image.resize((size, size), Image.Resampling.LANCZOS)


def frame(master: Image.Image, size: int) -> Image.Image:
    if size <= SIMPLE_MAX:
        return simple_mark(size)
    return master.resize((size, size), Image.Resampling.LANCZOS)


def write_ico(path: Path, frames: list[Image.Image]) -> None:
    # Pillow drops every size larger than the first image, so the largest goes first.
    largest = max(frames, key=lambda image: image.width)
    others = [image for image in frames if image is not largest]
    largest.save(
        path,
        format="ICO",
        append_images=others,
        sizes=[(image.width, image.height) for image in frames],
    )


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def write_icns(path: Path, master: Image.Image) -> None:
    parts: list[bytes] = []
    for os_type, size in ICNS_CHUNKS:
        data = png_bytes(master.resize((size, size), Image.Resampling.LANCZOS))
        parts.append(os_type + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(parts)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> None:
    master = Image.open(MASTER_PATH).convert("RGBA")
    if master.size != (1024, 1024):
        raise SystemExit(f"{MASTER_PATH} must be 1024x1024, got {master.size}")

    frames = [frame(master, size) for size in ICO_SIZES]
    write_ico(ROOT / "build" / "icon.ico", frames)
    write_icns(ROOT / "build" / "icon.icns", master)
    master.resize((512, 512), Image.Resampling.LANCZOS).save(ROOT / "resources" / "icon.png")
    mark = ROOT / "src" / "renderer" / "src" / "assets" / "stash-mark.png"
    master.resize((256, 256), Image.Resampling.LANCZOS).save(mark)
    print(f"ico sizes: {ICO_SIZES}")
    print("wrote build/icon.ico, build/icon.icns, resources/icon.png, stash-mark.png")


if __name__ == "__main__":
    main()
