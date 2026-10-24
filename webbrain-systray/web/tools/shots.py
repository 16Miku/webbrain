#!/usr/bin/env python3
"""Captures the panel screenshots used on the site: only the companion's own
window content (sample data from WBC_DEMO=1), never a desktop.

  WBC_HOME=/tmp/wbc-en WBC_DEMO=1 webbrain-companion --headless &   # language "en", port 8327 in companion.json
  python3 web/tools/shots.py /tmp/wbc-en web/assets/img en

Writes panel-, add- and local-<lang>-<light|dark>.webp. Needs Playwright with
Chromium and Pillow (pip install playwright pillow).
"""
import io
import json
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

home, out, lang = sys.argv[1], sys.argv[2], sys.argv[3]
s = json.load(open(home + "/companion.json"))
base = f"http://127.0.0.1:{s['port']}/companion/#k={s['panel_token']}"
W, H = 460, 760
SHOTS = {"panel": "", "add": "&view=add", "local": "&view=local"}


def settle(pg):
    pg.wait_for_selector("#h-subs", timeout=15000)
    pg.evaluate("document.fonts.ready")
    time.sleep(1.2)  # the meters fill, a sheet rises


with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ("light", "dark"):
        ctx = b.new_context(viewport={"width": W, "height": H}, device_scale_factor=2, color_scheme=scheme, locale=lang)
        for name, view in SHOTS.items():
            pg = ctx.new_page()
            pg.goto(base + view)
            settle(pg)
            png = pg.screenshot()
            Image.open(io.BytesIO(png)).save(f"{out}/{name}-{lang}-{scheme}.webp", "WEBP", quality=86, method=6)
            pg.close()
        ctx.close()
    b.close()
print("ok", lang)
