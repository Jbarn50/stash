#!/usr/bin/env python3
"""Draw Stash's icon and write the files electron-builder ships.

The mark is a bone disk on an indigo tile. A mint slice is lifted out of the
upper right — space set aside, not thrown away — and a copper bolt latches
what stays. It is not a drawer and not a chart in a box. Every size is this
drawing. At 24px and below the slice stays seated, because a one-pixel gap
vanishes. Run from the repo root:

    python3 scripts/render-icon.py
"""

from __future__ import annotations

import io
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]

# Sizes Windows asks an exe icon for, including a few DPI steps.
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
# The floating gap is smaller than a pixel here, so the slice sits in the bite.
SEATED_MAX = 24

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

INDIGO = (28, 18, 72, 255)
INDIGO_DEEP = (18, 10, 48, 255)
BONE = (244, 232, 214, 255)
BONE_RIM = (214, 190, 160, 255)
MINT = (45, 214, 168, 255)
MINT_DEEP = (16, 150, 118, 255)
COPPER = (224, 138, 58, 255)
COPPER_DEEP = (168, 88, 28, 255)

# Pillow pies run clockwise from 3 o'clock. 268° is just past 12, 18° is just
# under 3: a wide bite out of the upper right, not a thin chart sliver.
WEDGE_START = 268
WEDGE_END = 18


def _along(angle: float, distance: float) -> tuple[float, float]:
    radians = math.radians(angle)
    return math.cos(radians) * distance, math.sin(radians) * distance


def _wedge_mid() -> float:
    sweep = (WEDGE_END - WEDGE_START) % 360
    return (WEDGE_START + sweep / 2) % 360


def draw_mark(size: int) -> Image.Image:
    """One Stash mark at `size` pixels. Drawn several times larger, then scaled."""
    scale = 8
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def px(fraction: float) -> int:
        return int(round(fraction * canvas))

    margin = px(0.05)
    radius = px(0.23)
    draw.rounded_rectangle(
        [margin, margin, canvas - margin - 1, canvas - margin - 1],
        radius=radius,
        fill=INDIGO,
    )

    center = (px(0.47), px(0.49))
    disk_r = px(0.275)
    # How far the slice travels along its bisector. Zero keeps it in the bite.
    lift = 0.0 if size <= SEATED_MAX else 0.085 if size >= 48 else 0.055
    offset = _along(_wedge_mid(), px(lift))
    shard_center = (center[0] + offset[0], center[1] + offset[1])

    shadow = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shade = (8, 4, 24, 90)
    disk_box = [center[0] - disk_r, center[1] - disk_r, center[0] + disk_r, center[1] + disk_r]
    shadow_draw.ellipse([v + px(0.012) for v in disk_box], fill=shade)
    if lift > 0:
        shard_box_shadow = [
            shard_center[0] - disk_r,
            shard_center[1] - disk_r,
            shard_center[0] + disk_r,
            shard_center[1] + disk_r,
        ]
        shadow_draw.pieslice(
            [v + px(0.01) for v in shard_box_shadow],
            start=WEDGE_START,
            end=WEDGE_END,
            fill=shade,
        )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(1, px(0.018))))
    image.alpha_composite(shadow)
    draw = ImageDraw.Draw(image)

    rim = max(1, px(0.012)) if size >= 32 else 0
    if rim:
        draw.ellipse(
            [disk_box[0] - rim, disk_box[1] - rim, disk_box[2] + rim, disk_box[3] + rim],
            fill=BONE_RIM,
        )
    draw.ellipse(disk_box, fill=BONE)
    # The bite. Plate color, so the disk reads as missing a piece.
    draw.pieslice(disk_box, start=WEDGE_START, end=WEDGE_END, fill=INDIGO)

    shard_box = [
        shard_center[0] - disk_r,
        shard_center[1] - disk_r,
        shard_center[0] + disk_r,
        shard_center[1] + disk_r,
    ]
    draw.pieslice(shard_box, start=WEDGE_START, end=WEDGE_END, fill=MINT)
    # The cut face of the slice, a darker band so the piece has an edge.
    if size >= 32:
        face = px(0.045)
        draw.pieslice(
            [
                shard_center[0] - face,
                shard_center[1] - face,
                shard_center[0] + face,
                shard_center[1] + face,
            ],
            start=WEDGE_START,
            end=WEDGE_END,
            fill=MINT_DEEP,
        )

    # Spindle. Skipped when it would be a single muddy pixel.
    if size >= 24:
        hole = px(0.048)
        draw.ellipse(
            [center[0] - hole, center[1] - hole, center[0] + hole, center[1] + hole],
            fill=INDIGO_DEEP,
        )
        if size >= 48:
            pip = max(1, px(0.016))
            draw.ellipse(
                [center[0] - pip, center[1] - pip, center[0] + pip, center[1] + pip],
                fill=COPPER,
            )

    # Copper bolt across the lower disk, knob past the rim. This is the latch.
    bar_top = px(0.60)
    bar_bottom = px(0.685)
    bar_left = px(0.24)
    bar_right = px(0.73)
    knob_r = px(0.058)
    knob = (px(0.73), (bar_top + bar_bottom) // 2)
    draw.rounded_rectangle(
        [bar_left, bar_top, bar_right, bar_bottom],
        radius=(bar_bottom - bar_top) // 2,
        fill=COPPER_DEEP,
    )
    inset = max(1, (bar_bottom - bar_top) // 7)
    draw.rounded_rectangle(
        [bar_left, bar_top, bar_right - knob_r // 2, bar_top + inset * 3],
        radius=inset,
        fill=COPPER,
    )
    draw.ellipse(
        [knob[0] - knob_r, knob[1] - knob_r, knob[0] + knob_r, knob[1] + knob_r],
        fill=COPPER_DEEP,
    )
    inner = max(1, knob_r - px(0.016))
    draw.ellipse(
        [knob[0] - inner, knob[1] - inner, knob[0] + inner, knob[1] + inner],
        fill=COPPER,
    )

    return image.resize((size, size), Image.Resampling.LANCZOS)


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
    master = draw_mark(1024)
    master.save(ROOT / "build" / "icon.png")
    frames = [draw_mark(size) for size in ICO_SIZES]
    write_ico(ROOT / "build" / "icon.ico", frames)
    write_icns(ROOT / "build" / "icon.icns", master)
    draw_mark(512).save(ROOT / "resources" / "icon.png")
    draw_mark(256).save(ROOT / "src" / "renderer" / "src" / "assets" / "stash-mark.png")
    print(f"ico sizes: {ICO_SIZES}")
    print("wrote build/icon.png, build/icon.ico, build/icon.icns, resources/icon.png, stash-mark.png")


if __name__ == "__main__":
    main()
