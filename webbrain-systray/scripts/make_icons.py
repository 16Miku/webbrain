"""Builds every icon the companion ships from WebBrain's logo mark.

  python3 scripts/make_icons.py

Outputs
  internal/icons/tray_template.png  macOS menu-bar template (36 px @144 dpi = 18 pt)
  internal/icons/tray.png           Linux status icon (colour, 64 px)
  internal/icons/tray.ico           Windows notification-area icon
  assets/icons/app.ico              Windows executable icon
  assets/icons/app.icns             macOS bundle icon
  assets/icons/app-{128,256,512}.png
"""
import struct, zlib, io, os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "icons", "webbrain-logo-mark.png")

logo = Image.open(SRC).convert("RGBA")
a = np.array(logo)
ys, xs = np.where(a[..., 3] > 10)
pad = 24
box = (xs.min() - pad, ys.min() - pad, xs.max() + pad, ys.max() + pad)
w, h = box[2] - box[0], box[3] - box[1]
side = max(w, h)
cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
square = logo.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))

def colour(size):
    return square.resize((size, size), Image.LANCZOS)

def template(size, detailed=False):
    """Menu-bar glyph: the brain silhouette with the "W" cut out.

    The full logo's folds turn to noise at 18 pt, so small sizes use a solid
    silhouette and a bold W; detailed=True keeps the folds for large previews.
    """
    from PIL import ImageDraw
    arr = np.array(square).astype(np.float32)
    rgb, alpha = arr[..., :3], arr[..., 3] / 255.0
    if detailed:
        lum = rgb.mean(axis=2) / 255.0
        ink = np.clip((lum - 0.22) / 0.25, 0, 1) * alpha
        mask = Image.fromarray((ink * 255).astype(np.uint8))
    else:
        sil = Image.fromarray(((alpha > 0.5) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))
        sil = sil.point(lambda v: 255 if v > 127 else 0)
        n = sil.size[0]
        d = ImageDraw.Draw(sil)
        # W geometry, relative to the square crop of the logo.
        pts = [(0.255, 0.38), (0.385, 0.66), (0.5, 0.47), (0.615, 0.66), (0.745, 0.38)]
        pts = [(x * n, y * n) for x, y in pts]
        d.line(pts, fill=0, width=int(n * 0.095), joint="curve")
        for x, y in (pts[0], pts[-1]):
            r = n * 0.0475
            d.ellipse((x - r, y - r, x + r, y + r), fill=0)
        mask = sil
    mask = mask.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.putalpha(mask)
    return out

def png_with_dpi(img, dpi):
    buf = io.BytesIO()
    img.save(buf, "PNG", dpi=(dpi, dpi))
    return buf.getvalue()

icons = os.path.join(ROOT, "internal", "icons")
os.makedirs(icons, exist_ok=True)
with open(os.path.join(icons, "tray_template.png"), "wb") as f:
    f.write(png_with_dpi(template(36), 144))
colour(64).save(os.path.join(icons, "tray.png"))
tray_sizes = [16, 20, 24, 32, 40, 48, 64]
colour(256).save(os.path.join(icons, "tray.ico"), sizes=[(s, s) for s in tray_sizes], bitmap_format="bmp")

assets = os.path.join(ROOT, "assets", "icons")
app = colour(1024)
app.save(os.path.join(assets, "app.ico"), sizes=[(s, s) for s in [16, 20, 24, 32, 40, 48, 64, 128, 256]])
app.save(os.path.join(assets, "app.icns"))
for s in (128, 256, 512):
    colour(s).save(os.path.join(assets, f"app-{s}.png"))
template(256).save(os.path.join(assets, "template-preview-256.png"))
template(256, detailed=True).save(os.path.join(assets, "template-detailed-256.png"))
print("icons written")
