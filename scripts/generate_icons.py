#!/usr/bin/env python3
"""Generate the PWA icons for Sound Garden.

Writes plain RGBA PNGs with no third-party dependencies, so the icons can be
regenerated on any machine with a stock Python 3. Everything is drawn at 4x and
box-downsampled, which is enough anti-aliasing for a flat mark like this one.

Usage: python3 scripts/generate_icons.py public/icons
"""

from __future__ import annotations

import os
import struct
import sys
import zlib

SS = 4  # supersampling factor

BG = (0x0B, 0x0D, 0x0C)
STAFF = (0x3F, 0xA3, 0x4D)
NOTE = (0x6B, 0xD9, 0x7A)


def write_png(path: str, width: int, height: int, pixels: bytearray) -> None:
    """pixels is RGBA, row-major, len == width*height*4."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw += pixels[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


class Canvas:
    def __init__(self, size: int):
        self.size = size
        self.buf = bytearray(size * size * 4)

    def fill(self, colour: tuple[int, int, int]) -> None:
        r, g, b = colour
        for i in range(0, len(self.buf), 4):
            self.buf[i] = r
            self.buf[i + 1] = g
            self.buf[i + 2] = b
            self.buf[i + 3] = 255

    def px(self, x: int, y: int, colour: tuple[int, int, int]) -> None:
        if 0 <= x < self.size and 0 <= y < self.size:
            i = (y * self.size + x) * 4
            self.buf[i] = colour[0]
            self.buf[i + 1] = colour[1]
            self.buf[i + 2] = colour[2]
            self.buf[i + 3] = 255

    def rect(self, x0: float, y0: float, x1: float, y1: float, colour) -> None:
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                self.px(x, y, colour)

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, colour, rot: float = 0.0) -> None:
        import math

        cos_r, sin_r = math.cos(rot), math.sin(rot)
        for y in range(int(cy - ry - rx), int(cy + ry + rx) + 1):
            for x in range(int(cx - rx - ry), int(cx + rx + ry) + 1):
                dx, dy = x - cx, y - cy
                # Rotate the sample point into the ellipse's own frame.
                u = dx * cos_r + dy * sin_r
                v = -dx * sin_r + dy * cos_r
                if rx > 0 and ry > 0 and (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1.0:
                    self.px(x, y, colour)

    def downsample(self, factor: int) -> tuple[int, bytearray]:
        out_size = self.size // factor
        out = bytearray(out_size * out_size * 4)
        n = factor * factor
        for y in range(out_size):
            for x in range(out_size):
                r = g = b = 0
                for sy in range(factor):
                    for sx in range(factor):
                        i = ((y * factor + sy) * self.size + (x * factor + sx)) * 4
                        r += self.buf[i]
                        g += self.buf[i + 1]
                        b += self.buf[i + 2]
                o = (y * out_size + x) * 4
                out[o] = r // n
                out[o + 1] = g // n
                out[o + 2] = b // n
                out[o + 3] = 255
        return out_size, out


def draw_icon(size: int) -> tuple[int, bytearray]:
    """A staff with a notehead sitting on it — legible down to 32px."""
    c = Canvas(size * SS)
    c.fill(BG)
    s = size * SS

    # Five staff lines across the middle 62% of the icon. Maskable icons get
    # cropped to a circle, so keep the mark well inside the safe area.
    staff_left = s * 0.19
    staff_right = s * 0.81
    line_gap = s * 0.093
    first_line = s * 0.5 - line_gap * 2
    thickness = max(1.0, s * 0.016)

    for i in range(5):
        y = first_line + i * line_gap
        c.rect(staff_left, y - thickness / 2, staff_right, y + thickness / 2, STAFF)

    # Notehead on the middle line, with a stem going up on its right.
    head_cx = s * 0.415
    head_cy = first_line + line_gap * 2
    head_rx = line_gap * 0.86
    head_ry = line_gap * 0.60
    stem_w = max(1.0, s * 0.022)
    stem_x = head_cx + head_rx * 0.80
    c.rect(stem_x, head_cy - line_gap * 3.5, stem_x + stem_w, head_cy, NOTE)
    c.ellipse(head_cx, head_cy, head_rx, head_ry, NOTE, rot=-0.34)

    return c.downsample(SS)


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "public/icons"
    os.makedirs(out_dir, exist_ok=True)
    for size in (192, 512):
        px_size, pixels = draw_icon(size)
        path = os.path.join(out_dir, f"icon-{size}.png")
        write_png(path, px_size, px_size, pixels)
        print(f"wrote {path} ({px_size}x{px_size})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
