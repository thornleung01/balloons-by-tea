"""
Generates the optimized .webp versions of the site's artwork in images/.

The original PNG/JPG files are deliberately left in place: saved admin
settings (site_settings.hero_image_url / logo_url, collections.card_image_url)
and layout overrides in Supabase can still point at the original paths, and
js/site-content.js maps those known defaults to the WebP versions at runtime
(see OPTIMIZED_IMAGES there).

Target sizes come from measuring the largest rendered CSS box of every image
in Playwright, on every public page, at desktop 1440px (DPR 1) and at
390px (DPR 3), with lazy images scrolled into view and the cart drawer open:

  image                 desktop CSS px      phone CSS px (x3 DPR)   notes
  hero-mascot           1440x540 (cover)    390x260 cover -> ~607 wide   needs native 1916
  card-*                298x298             348x348                 srcset 600w / 1044w
  logo                  216x200 (footer)    58x54                   432w
  no-picture            406x508 (cover)     348x435 cover           square, phone needs ~1305 -> native
  sanrio-bouquet        406x508 (cover)     348x435                 native 1122
  pattern-balloons      300x300 tile        300x300 tile            900 (3x tile)
  custom-order-bg       1440 wide (::before) 390 wide               native 1774 + 1170 phone
  review-frame          804x402 (max 880)   246x123                 native 1774 (~2x of 880)
  word-widget           620x106             320x55                  1240 (2x of 620)
  error-404             480x270             350x197                 1050 (3x of 350)
  cart-empty-icon       51x48               51x48                   154 (3x of 51)

Output width = min(native, max(desktop * 2, phone * 3)). Quality is chosen
per image: each output is encoded at increasing quality until its PSNR
against the resized lossless reference (composited on the page background
for transparent images, with the alpha channel checked separately) reaches
the target below; flat cartoon artwork shows ringing early, so the targets
are fairly strict. Run from the repo root:

    python scripts/optimize_images.py
"""

import math
import os
import sys

from PIL import Image, ImageChops, ImageStat

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
IMAGES = os.path.join(ROOT, "images")
PAGE_BG = (255, 253, 249)  # --color-bg; transparent art is judged on it

# (source, output name, output width or None for native, target PSNR dB)
JOBS = [
    ("hero-mascot.png", "hero-mascot.webp", None, 40),
    ("card-anniversary.png", "card-anniversary-600w.webp", 600, 39),
    ("card-anniversary.png", "card-anniversary-1044w.webp", 1044, 39),
    ("card-birthday.png", "card-birthday-600w.webp", 600, 39),
    ("card-birthday.png", "card-birthday-1044w.webp", 1044, 39),
    ("card-kids.png", "card-kids-600w.webp", 600, 39),
    ("card-kids.png", "card-kids-1044w.webp", 1044, 39),
    ("card-other-occasions.png", "card-other-occasions-600w.webp", 600, 39),
    ("card-other-occasions.png", "card-other-occasions-1044w.webp", 1044, 39),
    ("logo.png", "logo.webp", 432, 40),
    ("no-picture.png", "no-picture.webp", None, 39),
    ("sanrio-bouquet.png", "sanrio-bouquet.webp", None, 38),
    ("pattern-balloons.png", "pattern-balloons.webp", 900, 37),
    ("custom-order-bg.png", "custom-order-bg.webp", None, 39),
    ("custom-order-bg.png", "custom-order-bg-1170w.webp", 1170, 39),
    ("review-frame.png", "review-frame.webp", None, 40),
    ("word-widget.png", "word-widget.webp", 1240, 40),
    ("error-404.png", "error-404.webp", 1050, 39),
    ("cart-empty-icon.png", "cart-empty-icon.webp", 154, 40),
]

QUALITIES = [60, 65, 70, 75, 80, 85, 88, 90, 92, 95]


def psnr(a, b):
    diff = ImageChops.difference(a, b)
    mse = sum(v * v for v in ImageStat.Stat(diff).rms) / len(diff.getbands())
    return 99.0 if mse == 0 else 20 * math.log10(255 / math.sqrt(mse))


def flatten(img):
    if img.mode != "RGBA":
        return img.convert("RGB")
    bg = Image.new("RGBA", img.size, PAGE_BG + (255,))
    return Image.alpha_composite(bg, img).convert("RGB")


def has_transparency(img):
    return img.mode == "RGBA" and img.getchannel("A").getextrema()[0] < 255


def encode(ref, out_path, target):
    alpha = has_transparency(ref)
    ref_flat = flatten(ref)
    chosen = None
    for q in QUALITIES:
        ref.save(out_path, "WEBP", quality=q, method=6, alpha_quality=100 if alpha else 0)
        with Image.open(out_path) as enc:
            enc.load()
            enc = enc.convert("RGBA" if alpha else "RGB")
            score = psnr(ref_flat, flatten(enc))
            a_score = psnr(ref.getchannel("A"), enc.getchannel("A")) if alpha else 99.0
        chosen = (q, score, a_score)
        if score >= target and a_score >= 45:
            break
    return chosen, alpha


def main():
    total_in = total_out = 0
    for src, dst, width, target in JOBS:
        src_path = os.path.join(IMAGES, src)
        out_path = os.path.join(IMAGES, dst)
        with Image.open(src_path) as im:
            im.load()
            im = im.convert("RGBA") if "A" in im.getbands() or "transparency" in im.info else im.convert("RGB")
            if width and width < im.width:
                height = round(im.height * width / im.width)
                im = im.resize((width, height), Image.LANCZOS)
            if im.mode == "RGBA" and not has_transparency(im):
                im = im.convert("RGB")
            (q, score, a_score), alpha = encode(im, out_path, target)
        in_size, out_size = os.path.getsize(src_path), os.path.getsize(out_path)
        total_in += in_size
        total_out += out_size
        print(f"{dst:34} {im.width:>5}x{im.height:<5} q={q:<3} PSNR {score:5.1f}dB"
              f"{f' alpha {a_score:5.1f}dB' if alpha else '':17} {in_size / 1024:7.0f}K -> {out_size / 1024:6.0f}K")

    # Small favicon so browsers stop fetching the 250K logo.png for the tab icon.
    with Image.open(os.path.join(IMAGES, "logo.png")) as im:
        im.convert("RGBA").resize((64, 59), Image.LANCZOS).save(os.path.join(IMAGES, "favicon-64.png"), optimize=True)
    print(f"{'favicon-64.png':34} {os.path.getsize(os.path.join(IMAGES, 'favicon-64.png')) / 1024:.1f}K")
    print(f"\nSources {total_in / 1e6:.2f}MB -> WebP {total_out / 1e6:.2f}MB")


if __name__ == "__main__":
    sys.exit(main())
