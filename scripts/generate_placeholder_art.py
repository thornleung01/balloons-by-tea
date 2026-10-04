"""
Dev-only utility — NOT needed to run or deploy the site.

Generates soft, editorial "bokeh" placeholder photography (blurred balloon-like
forms, grain, vignette) in the site's gold/charcoal palette, so the homepage
has real image files to work with until real product photography is ready.

Usage:  python scripts/generate_placeholder_art.py
Output: ../images/hero-bg.jpg, ../images/card-birthday.jpg,
        ../images/card-anniversary.jpg, ../images/card-other-occasions.jpg
Requires: pip install pillow
"""

import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "images")

CREAM = (243, 238, 230)
WARM_WHITE = (250, 249, 249)
GOLD_LIGHT = (212, 169, 74)
GOLD_DEEP = (161, 98, 7)
CHARCOAL = (28, 25, 23)
STONE = (87, 83, 78)
SAGE = (140, 158, 120)
BLUSH = (214, 173, 164)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def radial_gradient(size, center_color, edge_color, center=(0.5, 0.5)):
    w, h = size
    cx, cy = center[0] * w, center[1] * h
    max_dist = math.hypot(max(cx, w - cx), max(cy, h - cy))
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot(xx - cx, yy - cy) / max_dist
    d = np.clip(d, 0, 1)[..., None]
    c0 = np.array(center_color, dtype=np.float32)
    c1 = np.array(edge_color, dtype=np.float32)
    arr = (c0 + (c1 - c0) * d).astype(np.uint8)
    return Image.fromarray(arr, "RGB")


def add_bokeh(img, circles, blur_radius=6):
    """circles: list of (x_frac, y_frac, r_frac, color, alpha). Each circle gets
    a light blur proportional to its own size, so small ones stay crisp-ish
    and large ones go soft — like real shallow-depth-of-field bokeh, and a
    small highlight so it reads as a glossy sphere rather than a flat dot."""
    w, h = img.size
    composite = img.convert("RGBA")
    for x_frac, y_frac, r_frac, color, alpha in circles:
        cx, cy, r = x_frac * w, y_frac * h, r_frac * w
        pad = int(r * 2.4) + 4
        tile = Image.new("RGBA", (pad * 2, pad * 2), (0, 0, 0, 0))
        d = ImageDraw.Draw(tile)
        d.ellipse([pad - r, pad - r, pad + r, pad + r], fill=color + (alpha,))
        hl_r = r * 0.32
        hl_cx, hl_cy = pad - r * 0.32, pad - r * 0.38
        hl_color = tuple(min(255, c + 70) for c in color)
        d.ellipse(
            [hl_cx - hl_r, hl_cy - hl_r, hl_cx + hl_r, hl_cy + hl_r],
            fill=hl_color + (min(255, alpha + 30),),
        )
        this_blur = max(1.5, blur_radius * (r / (w * 0.08)))
        tile = tile.filter(ImageFilter.GaussianBlur(this_blur))
        composite.alpha_composite(tile, (int(cx - pad), int(cy - pad)))
    return composite.convert("RGB")


def add_grain(img, amount=10):
    w, h = img.size
    noise = Image.effect_noise((w, h), amount).convert("L")
    noise_rgb = Image.merge("RGB", (noise, noise, noise))
    return Image.blend(img, noise_rgb, 0.035)


def add_vignette(img, strength=0.35):
    w, h = img.size
    vign = radial_gradient((w, h), (255, 255, 255), (0, 0, 0), center=(0.5, 0.5))
    vign = vign.convert("L")
    img_arr = img.convert("RGB")
    dark = Image.new("RGB", (w, h), (0, 0, 0))
    mask = vign.point(lambda p: int(255 * (1 - strength) + strength * p))
    return Image.composite(img_arr, dark, mask)


def random_circles(n, colors, seed, x_range=(0, 1), size_range=(0.015, 0.07)):
    rnd = random.Random(seed)
    circles = []
    for _ in range(n):
        x = rnd.uniform(*x_range)
        y = rnd.uniform(0.02, 0.98)
        # bias toward smaller circles with an occasional larger one, like real bokeh
        r = size_range[0] + (size_range[1] - size_range[0]) * (rnd.random() ** 2.2)
        color = rnd.choice(colors)
        alpha = rnd.randint(150, 235)
        circles.append((x, y, r, color, alpha))
    # sort by size so larger (further/softer) ones draw first, smaller crisp ones on top
    circles.sort(key=lambda c: -c[2])
    return circles


def make_hero(path):
    size = (1920, 1080)
    img = radial_gradient(size, WARM_WHITE, CREAM, center=(0.22, 0.4))
    circles = random_circles(
        70,
        [GOLD_LIGHT, GOLD_DEEP, CHARCOAL, CREAM, WARM_WHITE, STONE],
        seed=11,
        x_range=(0.3, 1.08),
        size_range=(0.012, 0.075),
    )
    img = add_bokeh(img, circles, blur_radius=7)
    img = add_grain(img, amount=10)
    img = add_vignette(img, strength=0.18)
    img.save(path, quality=92)


def make_card(path, colors, seed):
    size = (1000, 1100)
    img = radial_gradient(size, WARM_WHITE, CREAM, center=(0.5, 0.3))
    circles = random_circles(
        34, colors, seed=seed, x_range=(0.0, 1.0), size_range=(0.025, 0.12)
    )
    img = add_bokeh(img, circles, blur_radius=7)
    img = add_grain(img, amount=9)
    img = add_vignette(img, strength=0.26)
    img.save(path, quality=92)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    make_hero(os.path.join(OUT_DIR, "hero-bg.jpg"))
    make_card(os.path.join(OUT_DIR, "card-anniversary.jpg"), [CREAM, WARM_WHITE, GOLD_LIGHT, WHITE], seed=2)
    make_card(os.path.join(OUT_DIR, "card-birthday.jpg"), [GOLD_LIGHT, GOLD_DEEP, CHARCOAL, CREAM], seed=1)
    make_card(os.path.join(OUT_DIR, "card-kids.jpg"), [GOLD_LIGHT, BLUSH, CREAM, SAGE], seed=6)
    make_card(os.path.join(OUT_DIR, "card-other-occasions.jpg"), [SAGE, BLUSH, GOLD_LIGHT, CHARCOAL, STONE], seed=5)

    print("Generated placeholder imagery in", OUT_DIR)
