"""Renders assets/img/og.png (1200x630) from the hero of a locally served site:

  python3 -m http.server 8765 --directory web &
  python3 web/tools/og.py http://127.0.0.1:8765/ web/assets/img/og.png
"""
import sys, time
from playwright.sync_api import sync_playwright
url, out = sys.argv[1], sys.argv[2]
css = """
.site-head, .lede, .cta, .os-switch, main > section:not(.hero), footer { display: none !important; }
.hero { padding: 64px 64px 0 !important; max-width: none !important; gap: 40px !important; grid-template-columns: 1fr 1.05fr !important; align-items: start !important; }
.hero h1 { font-size: 60px !important; margin-top: 18px; }
.desk { height: 420px !important; }
.og-brand { display: flex; align-items: center; gap: 12px; font: 700 24px var(--font); letter-spacing: -.01em; }
.og-brand img { width: 44px; height: 44px; }
.og-url { margin-top: 26px; font: 500 20px var(--font); color: var(--muted); }
"""
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1, color_scheme="light",
                    user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                    reduced_motion="reduce")
    pg.goto(url, wait_until="networkidle")
    pg.add_style_tag(content=css)
    pg.evaluate("""() => {
      const h = document.querySelector('.hero > div');
      const brand = document.createElement('div');
      brand.className = 'og-brand';
      brand.innerHTML = '<img src="assets/img/logo-128.png" alt="">WebBrain Companion';
      h.prepend(brand);
      const u = document.createElement('p');
      u.className = 'og-url';
      u.textContent = 'Claude, ChatGPT, Google, Grok and Kimi on 127.0.0.1:8327, with usage in your tray.';
      h.append(u);
    }""")
    pg.evaluate("document.fonts.ready")
    time.sleep(1.2)
    pg.screenshot(path=out)
    b.close()
