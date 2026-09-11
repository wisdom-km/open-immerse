#!/usr/bin/env python3
"""Generate Dual Line mark PNGs (two equal horizontal bars)."""

import struct
import zlib
from pathlib import Path

ACCENT = (0x4D, 0x7C, 0xFF, 255)
BG = (0x11, 0x13, 0x18, 255)

SIZES = {
    16: {"radius": 3.5, "bar_w": 8, "bar_h": 2, "gap": 2},
    48: {"radius": 10, "bar_w": 24, "bar_h": 5, "gap": 6},
    128: {"radius": 28, "bar_w": 64, "bar_h": 12, "gap": 16},
}


def rounded_mask(size, radius):
    mask = [[0.0] * size for _ in range(size)]
    r = float(radius)
    for y in range(size):
        for x in range(size):
            cx = min(x + 0.5, size - x - 0.5)
            cy = min(y + 0.5, size - y - 0.5)
            if cx >= r or cy >= r:
                mask[y][x] = 1.0
                continue
            dx = r - cx
            dy = r - cy
            dist = (dx * dx + dy * dy) ** 0.5
            cover = r - dist + 0.5
            mask[y][x] = 0.0 if cover <= 0 else 1.0 if cover >= 1 else cover
    return mask


def draw(size, spec):
    pixels = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]
    mask = rounded_mask(size, spec["radius"])
    bar_w = spec["bar_w"]
    bar_h = spec["bar_h"]
    gap = spec["gap"]
    total_h = bar_h * 2 + gap
    top = (size - total_h) / 2
    left = (size - bar_w) / 2
    bars = [(top, top + bar_h), (top + bar_h + gap, top + total_h)]
    for y in range(size):
        for x in range(size):
            a = mask[y][x]
            if a <= 0:
                continue
            color = BG
            for y0, y1 in bars:
                if left <= x + 0.5 <= left + bar_w and y0 <= y + 0.5 <= y1:
                    color = ACCENT
                    break
            pixels[y][x] = (color[0], color[1], color[2], int(round(255 * a)))
    return pixels


def png_chunk(tag, data):
    raw = tag + data
    return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw) & 0xFFFFFFFF)


def write_png(path, pixels):
    size = len(pixels)
    raw = b"".join(b"\x00" + b"".join(bytes(px) for px in row) for row in pixels)
    payload = b"\x89PNG\r\n\x1a\n"
    payload += png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    payload += png_chunk(b"IDAT", zlib.compress(raw, 9))
    payload += png_chunk(b"IEND", b"")
    path.write_bytes(payload)


def main():
    out = Path(__file__).resolve().parents[1] / "icons"
    out.mkdir(exist_ok=True)
    for size, spec in SIZES.items():
        write_png(out / f"icon{size}.png", draw(size, spec))
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
