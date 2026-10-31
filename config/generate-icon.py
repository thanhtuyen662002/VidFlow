"""Renders the VidFlow brand mark into build/icon.png and build/icon.ico.

The geometry mirrors renderer/public/favicon.svg (viewBox 512): a gradient rounded square,
a white play triangle and three motion lines. Run with Python 3 and Pillow:
    python config/generate-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
SCALE = 4  # Draw large, then downscale for smooth edges.
OUT = Path(__file__).resolve().parent.parent / 'build'

GRADIENT = [(0.0, (255, 138, 61)), (0.5, (236, 72, 120)), (1.0, (124, 58, 237))]
WHITE = (255, 255, 255, 255)
LINE = (255, 255, 255, 215)
RADIUS = 116
TRIANGLE = [(226, 154), (226, 358), (396, 256)]
TRIANGLE_ROUND = 26  # Corner rounding: thick edges plus round vertices around the triangle.
LINES = [(128, 178, 208), (100, 186, 256), (128, 178, 304)]  # (x start, x end, y); a gap before the triangle
LINE_WIDTH = 30


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_color(t):
    for (t0, c0), (t1, c1) in zip(GRADIENT, GRADIENT[1:]):
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return GRADIENT[-1][1]


def render():
    big = SIZE * SCALE
    s = lambda v: v * SCALE
    # Diagonal gradient from top-left to bottom-right.
    gradient = Image.new('RGBA', (big, big))
    pixels = gradient.load()
    for y in range(big):
        for x in range(big):
            pixels[x, y] = gradient_color((x + y) / (2 * (big - 1))) + (255,)
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=s(RADIUS), fill=255)
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)

    overlay = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x0, x1, y in LINES:
        draw.line((s(x0), s(y), s(x1), s(y)), fill=LINE, width=s(LINE_WIDTH))
        for x in (x0, x1):
            r = s(LINE_WIDTH) / 2
            draw.ellipse((s(x) - r, s(y) - r, s(x) + r, s(y) + r), fill=LINE)
    triangle = [(s(x), s(y)) for x, y in TRIANGLE]
    draw.polygon(triangle, fill=WHITE)
    r = s(TRIANGLE_ROUND) / 2
    for a, b in zip(triangle, triangle[1:] + triangle[:1]):
        draw.line((a, b), fill=WHITE, width=s(TRIANGLE_ROUND))
    for x, y in triangle:
        draw.ellipse((x - r, y - r, x + r, y + r), fill=WHITE)
    image = Image.alpha_composite(image, overlay)
    return image.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    icon = render()
    icon.save(OUT / 'icon.png')
    icon.save(OUT / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f'Wrote {OUT / "icon.png"} and {OUT / "icon.ico"}')


if __name__ == '__main__':
    main()
