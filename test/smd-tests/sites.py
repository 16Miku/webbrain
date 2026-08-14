"""Per-site test cases for SocialMediaDownloader regression suite.

Each register'd function takes (page, js_path, screenshot_dir) and returns
a TestResult. Add a site here, and test_smd.py auto-picks it up.
"""
from __future__ import annotations
import time
from pathlib import Path
from playwright.sync_api import Page, TimeoutError as PWTimeout

from common import TestResult, inject_smd, collect_smd

TESTS = []

def register(fn):
    TESTS.append(fn)
    return fn

def _screenshot(page: Page, sdir: Path, name: str) -> str:
    sdir.mkdir(parents=True, exist_ok=True)
    p = sdir / f"{name}.png"
    try:
        page.screenshot(path=str(p), full_page=False)
        return str(p)
    except Exception:
        return ""

def _safe_goto(page: Page, url: str, timeout_ms: int = 30000) -> None:
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    except PWTimeout:
        pass

def _click_first(page: Page, selector: str, timeout: int = 5000) -> bool:
    """Click first element matching selector. Returns True on success."""
    try:
        loc = page.locator(selector).first
        loc.scroll_into_view_if_needed(timeout=2000)
        loc.click(timeout=timeout)
        try:
            page.wait_for_load_state("domcontentloaded", timeout=8000)
        except Exception:
            pass
        time.sleep(2)
        return True
    except Exception:
        return False

def _single_mode_assertions(r, data, expected_profile, max_urls=8):
    """Common assertions for any single-content (main-mode) test."""
    urls = data.get("urls", [])
    r.profile_detected = data.get("profile")
    r.url_count = len(urls)
    r.sample_urls = [u[:90] for u in urls[:3]]
    r.assertions = [
        f"profile == '{expected_profile}' (got: {r.profile_detected})",
        f"mode == 'main' (got: {data.get('mode')})",
        f"main URL count 1..{max_urls} (got: {len(urls)})",
    ]
    if r.profile_detected != expected_profile:
        r.failures.append("wrong profile")
    if data.get("mode") != "main":
        r.failures.append("auto-mode did not switch to main on single-content URL")
    if not (1 <= len(urls) <= max_urls):
        r.failures.append(f"unexpected URL count {len(urls)}")
    r.passed = not r.failures


@register
def test_pinterest(page, js_path, sdir):
    r = TestResult(site="pinterest", url="https://www.pinterest.com/ideas/", passed=False)
    _safe_goto(page, r.url); time.sleep(2)
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "pinterest"); return r
    urls = data.get("urls", [])
    pinimg = [u for u in urls if "pinimg.com" in u]
    originals = [u for u in pinimg if "/originals/" in u]
    r.profile_detected = data.get("profile"); r.url_count = len(urls); r.sample_urls = urls[:3]
    r.assertions = [
        f"profile == 'pinterest' (got: {r.profile_detected})",
        f"pinimg.com URLs >= 10 (got: {len(pinimg)})",
        f"upgraded to /originals/ >= 1 (got: {len(originals)})",
    ]
    if r.profile_detected != "pinterest": r.failures.append("wrong profile")
    if len(pinimg) < 10:                  r.failures.append("too few pinimg URLs")
    if len(originals) < 1:                r.failures.append("originals upgrade not applied")
    r.passed = not r.failures
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "pinterest")
    return r


@register
def test_reddit(page, js_path, sdir):
    r = TestResult(site="reddit", url="https://www.reddit.com/r/space/", passed=False)
    _safe_goto(page, r.url); time.sleep(3)
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "reddit"); return r
    urls = data.get("urls", [])
    reddit_imgs = [u for u in urls if "redd.it" in u or "redditmedia.com" in u]
    r.profile_detected = data.get("profile"); r.url_count = len(urls); r.sample_urls = urls[:3]
    r.assertions = [
        f"profile == 'reddit' (got: {r.profile_detected})",
        f"redd.it URLs >= 3 (got: {len(reddit_imgs)})",
    ]
    if r.profile_detected != "reddit": r.failures.append("wrong profile")
    if len(reddit_imgs) < 3:           r.failures.append("too few redd.it URLs")
    r.passed = not r.failures
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "reddit")
    return r


@register
def test_instagram(page, js_path, sdir):
    r = TestResult(site="instagram", url="https://www.instagram.com/natgeo/", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    logged_out = page.locator('input[name="username"]').count() > 0
    inject_smd(page, js_path)
    data = collect_smd(page, "auto")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "instagram"); return r
    urls = data.get("urls", [])
    ig = [u for u in urls if "cdninstagram.com" in u or "fbcdn.net" in u]
    r.profile_detected = data.get("profile"); r.url_count = len(urls)
    r.sample_urls = [u[:90] for u in urls[:3]]; r.needs_login = logged_out
    r.assertions = [
        f"profile == 'instagram' (got: {r.profile_detected})",
        "logged in: focused cdninstagram/fbcdn URL >= 1" if not logged_out else "logged out: profile detection only",
    ]
    if r.profile_detected != "instagram": r.failures.append("wrong profile")
    if not logged_out and len(ig) < 1:   r.failures.append("no focused IG URL (logged in)")
    r.passed = not r.failures and not logged_out
    if logged_out: r.notes = "Use CDP attach or --setup for full coverage."
    if not r.passed and not logged_out: r.screenshot_path = _screenshot(page, sdir, "instagram")
    return r


@register
def test_twitter(page, js_path, sdir):
    r = TestResult(site="twitter", url="https://x.com/NASA", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    logged_out = page.locator('[data-testid="loginButton"]').count() > 0
    inject_smd(page, js_path)
    data = collect_smd(page, "auto")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "twitter"); return r
    urls = data.get("urls", [])
    twimg = [u for u in urls if "twimg.com" in u]
    has_orig = any("name=orig" in u for u in twimg)
    r.profile_detected = data.get("profile"); r.url_count = len(urls); r.sample_urls = urls[:3]
    r.needs_login = logged_out
    r.assertions = [
        f"profile == 'twitter' (got: {r.profile_detected})",
        "logged in: twimg URLs >= 1 with name=orig" if not logged_out else "logged out: profile detection only",
    ]
    if r.profile_detected != "twitter": r.failures.append("wrong profile")
    if not logged_out:
        if len(twimg) < 1: r.failures.append("no twimg URLs")
        if not has_orig:   r.failures.append("name=orig upgrade not applied")
    r.passed = not r.failures and not logged_out
    if logged_out: r.notes = "Use CDP attach or --setup for full coverage."
    if not r.passed and not logged_out: r.screenshot_path = _screenshot(page, sdir, "twitter")
    return r


@register
def test_facebook(page, js_path, sdir):
    r = TestResult(site="facebook", url="https://www.facebook.com/NASA/photos", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    logged_out = page.locator('input[name="email"]').count() > 0
    if logged_out:
        inject_smd(page, js_path)
        data = collect_smd(page, "auto")
        r.profile_detected = data.get("profile"); r.url_count = len(data.get("urls", []))
        r.needs_login = True
        r.notes = "Use CDP attach or --setup. Photo-viewer fix only verifiable when logged in."
        r.assertions = [f"profile == 'facebook' (got: {r.profile_detected})"]
        return r
    page.evaluate("""() => {
        const link = document.querySelector('a[href*="/photo/?fbid="], a[href*="/photo.php"]');
        if (link) link.click();
    }""")
    time.sleep(4)
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "facebook"); return r
    urls = data.get("urls", [])
    r.url = page.url; r.profile_detected = data.get("profile")
    r.url_count = len(urls); r.sample_urls = [u[:90] for u in urls[:3]]
    r.assertions = [
        f"profile == 'facebook' (got: {r.profile_detected})",
        f"main-mode URL count 1..5 (got: {len(urls)}) - avatar-leak guard",
        f"mode == 'main' (got: {data.get('mode')})",
    ]
    if r.profile_detected != "facebook": r.failures.append("wrong profile")
    if data.get("mode") != "main":       r.failures.append("auto-mode did not switch to main")
    if not (1 <= len(urls) <= 5):        r.failures.append(f"unexpected URL count {len(urls)}")
    r.passed = not r.failures
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "facebook")
    return r


@register
def test_facebook_gallery(page, js_path, sdir):
    """Album/gallery page — must detect gallery mode and strip avatars/logos/ads.

    Regression for the trace that returned 713 "photos" on an FB album,
    of which 700+ were page chrome (fb_icon, profile avatars in nav, ad
    creatives, suggested-content thumbnails sized 80×80 or 240×240).
    The new collect() routes /photos pages through `gallerySel` (album
    thumbnail links only) and applies `urlFilter` to drop <300×300 size
    slugs in `stp=...` plus known static assets like fb_icon/rsrc.php.
    """
    r = TestResult(site="facebook_gallery", url="https://www.facebook.com/NASA/photos", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    logged_out = page.locator('input[name="email"]').count() > 0
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "facebook_gallery"); return r

    urls = data.get("urls", [])
    r.profile_detected = data.get("profile"); r.url_count = len(urls)
    r.sample_urls = [u[:90] for u in urls[:3]]
    r.needs_login = logged_out

    # Sentinel URLs that the old whole-document sweep used to drag in.
    # Real album thumbnails on FB look like:
    #   …/v/t39.30808-6/<id>.jpg?stp=c0.135.1638.1638a_cp6_dst-jpg_s552x414_tt6&…
    # Avatars / nav icons / ads use much smaller size slugs:
    #   …/v/t39.30808-6/<id>.jpg?stp=cp0_dst-jpg_s80x80_tt6&…
    chrome_leaks = [
        u for u in urls if (
            "fb_icon" in u
            or "/rsrc.php/" in u
            or "/emoji.php/" in u
            # any size slug below ~240×240 is almost never user content
            or any(s in u for s in ("_s80x80", "_s96x96", "_s120x120",
                                     "_s144x144", "_s160x160", "_s180x180",
                                     "_s200x200", "_s240x240"))
        )
    ]

    r.assertions = [
        f"profile == 'facebook' (got: {r.profile_detected})",
        f"mode == 'gallery' (got: {data.get('mode')}) - gallery-only filter routed",
        f"chrome leaks (avatars/icons/sprites) == 0 (got: {len(chrome_leaks)})",
        ("logged in: gallery URL count 5..500"
         if not logged_out else "logged out: just profile + gallery-mode detection"),
    ]
    if r.profile_detected != "facebook":
        r.failures.append("wrong profile")
    if data.get("mode") != "gallery":
        r.failures.append("/photos page did not route through gallery selector")
    if chrome_leaks:
        r.failures.append(f"chrome leak: {len(chrome_leaks)} avatar/icon URLs slipped past urlFilter")
    if not logged_out:
        if not (5 <= len(urls) <= 500):
            r.failures.append(f"unexpected gallery URL count {len(urls)}")
    r.passed = not r.failures and not logged_out
    if logged_out:
        r.notes = "Use CDP attach or --setup. Filter coverage only verifiable when logged in."
    if not r.passed and not logged_out:
        r.screenshot_path = _screenshot(page, sdir, "facebook_gallery")
    return r


@register
def test_linkedin(page, js_path, sdir):
    r = TestResult(site="linkedin", url="https://www.linkedin.com/company/nasa/posts/", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    title = page.title()
    logged_out = ("Sign Up" in title or "Join" in title or
                  page.locator('input[name="session_key"]').count() > 0)
    inject_smd(page, js_path)
    data = collect_smd(page, "auto")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "linkedin"); return r
    urls = data.get("urls", [])
    licdn = [u for u in urls if "licdn" in u]
    r.profile_detected = data.get("profile"); r.url_count = len(urls)
    r.sample_urls = [u[:90] for u in urls[:3]]; r.needs_login = logged_out
    r.assertions = [
        f"profile == 'linkedin' (got: {r.profile_detected})",
        "logged in: licdn URLs >= 1" if not logged_out else "logged out: profile detection only",
    ]
    if r.profile_detected != "linkedin": r.failures.append("wrong profile")
    if not logged_out and len(licdn) < 1: r.failures.append("no licdn URLs - selectors stale?")
    r.passed = not r.failures and not logged_out
    if logged_out: r.notes = "Use CDP attach or --setup for full coverage."
    if not r.passed and not logged_out: r.screenshot_path = _screenshot(page, sdir, "linkedin")
    return r


# ---------------------------------------------------------------------
# Single-content (main-mode) tests — click into first item from feed,
# verify the script's single-content extraction returns just the photo.
# ---------------------------------------------------------------------

@register
def test_pinterest_single(page, js_path, sdir):
    # Use Pinterest search — always returns a dense pin grid, never
    # requires login, and pin URLs are stable. /pinterest/ profile
    # didn't expose clickable pins reliably.
    r = TestResult(site="pinterest_single", url="https://www.pinterest.com/search/pins/?q=nature", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    # Scroll a bit so the grid renders even if Pinterest defers it
    try:
        page.evaluate("window.scrollBy(0, 400)")
        time.sleep(1)
    except Exception:
        pass
    if not _click_first(page, 'a[href^="/pin/"], div[data-test-id="pin"] a, [data-test-id="pinrep-image"]'):
        r.error = "could not click into a pin"
        r.screenshot_path = _screenshot(page, sdir, "pinterest_single"); return r
    r.url = page.url
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "pinterest_single"); return r
    _single_mode_assertions(r, data, "pinterest", max_urls=8)
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "pinterest_single")
    return r


@register
def test_reddit_single(page, js_path, sdir):
    r = TestResult(site="reddit_single", url="https://www.reddit.com/r/space/", passed=False)
    _safe_goto(page, r.url); time.sleep(3)
    # Reddit post titles link to /comments/
    if not _click_first(page, 'a[href*="/comments/"]'):
        r.error = "could not click into a reddit post"
        r.screenshot_path = _screenshot(page, sdir, "reddit_single"); return r
    r.url = page.url; time.sleep(2)
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "reddit_single"); return r
    _single_mode_assertions(r, data, "reddit", max_urls=8)
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "reddit_single")
    return r


@register
def test_instagram_single(page, js_path, sdir):
    r = TestResult(site="instagram_single", url="https://www.instagram.com/natgeo/", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    if page.locator('input[name="username"]').count() > 0:
        r.needs_login = True
        r.assertions = ["needs login to click into a post"]
        r.notes = "Use CDP attach or --setup."
        return r
    # IG sometimes wraps posts in article, sometimes div. Looser selector,
    # scroll grid into view first to ensure posts are rendered.
    try:
        page.evaluate("window.scrollBy(0, 600)")
        time.sleep(2)
    except Exception:
        pass
    if not _click_first(page, 'main a[href*="/p/"], a[role="link"][href*="/p/"]'):
        r.error = "could not click into an IG post"
        r.screenshot_path = _screenshot(page, sdir, "instagram_single"); return r
    r.url = page.url
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "instagram_single"); return r
    # IG single post: 1 photo with srcset variants + meta tags = ~5-8.
    # Carousels can have up to 10 slides + variants. 12 is a safe cap;
    # if it's exceeding that, the "More posts" grid is leaking again.
    _single_mode_assertions(r, data, "instagram", max_urls=12)
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "instagram_single")
    return r


@register
def test_twitter_single(page, js_path, sdir):
    r = TestResult(site="twitter_single", url="https://x.com/NASA/media", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    if page.locator('[data-testid="loginButton"]').count() > 0:
        r.needs_login = True
        r.assertions = ["needs login to click into a photo"]
        r.notes = "Use CDP attach or --setup."
        return r
    # Click first media tile — opens at /photo/1
    if not _click_first(page, '[data-testid="tweetPhoto"], a[href*="/photo/"]'):
        r.error = "could not click into an X photo"
        r.screenshot_path = _screenshot(page, sdir, "twitter_single"); return r
    r.url = page.url
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "twitter_single"); return r
    # X multi-media tweets: up to 4 items × (photo + video poster) — easily 8+
    _single_mode_assertions(r, data, "twitter", max_urls=12)
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "twitter_single")
    return r


@register
def test_youtube(page, js_path, sdir):
    """Channel page — should expose lots of i.ytimg.com thumbnails."""
    r = TestResult(site="youtube", url="https://www.youtube.com/@NASA/videos", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "youtube"); return r
    urls = data.get("urls", [])
    ytimg = [u for u in urls if "ytimg.com" in u]
    r.profile_detected = data.get("profile"); r.url_count = len(urls)
    r.sample_urls = [u[:90] for u in urls[:3]]
    r.assertions = [
        f"profile == 'youtube' (got: {r.profile_detected})",
        f"ytimg.com thumbnails >= 10 (got: {len(ytimg)})",
    ]
    if r.profile_detected != "youtube": r.failures.append("wrong profile")
    if len(ytimg) < 10: r.failures.append("too few ytimg URLs - selectors stale?")
    r.passed = not r.failures
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "youtube")
    return r


@register
def test_youtube_single(page, js_path, sdir):
    """Single watch page — main mode should give the video poster."""
    r = TestResult(site="youtube_single",
                   # Rick Astley's famous video — has been on YouTube since 2009,
                   # extremely unlikely to be removed. Stable test target.
                   url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                   passed=False)
    _safe_goto(page, r.url); time.sleep(5)
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "youtube_single"); return r
    urls = data.get("urls", [])
    r.url = page.url; r.profile_detected = data.get("profile")
    r.url_count = len(urls); r.sample_urls = urls[:3]
    r.assertions = [
        f"profile == 'youtube' (got: {r.profile_detected})",
        f"mode == 'main' (got: {data.get('mode')})",
        f"main URL count 1..8 (got: {len(urls)}) - should be mostly the poster",
    ]
    if r.profile_detected != "youtube":   r.failures.append("wrong profile")
    if data.get("mode") != "main":        r.failures.append("auto-mode didn't switch on /watch")
    if not (1 <= len(urls) <= 8):         r.failures.append(f"unexpected URL count {len(urls)}")
    r.notes = "YT actual video streams are MSE/DRM and not downloadable - use yt-dlp."
    r.passed = not r.failures
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "youtube_single")
    return r


@register
def test_linkedin_single(page, js_path, sdir):
    r = TestResult(site="linkedin_single", url="https://www.linkedin.com/company/nasa/posts/", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    title = page.title()
    if ("Sign Up" in title or "Join" in title or
        page.locator('input[name="session_key"]').count() > 0):
        r.needs_login = True
        r.assertions = ["needs login to click into a post"]
        r.notes = "Use CDP attach or --setup."
        return r
    # LinkedIn post media links lead to /feed/update/ or /posts/
    if not _click_first(page, 'a[href*="/feed/update/"], a[href*="/posts/"]'):
        r.error = "could not click into a LinkedIn post"
        r.screenshot_path = _screenshot(page, sdir, "linkedin_single"); return r
    r.url = page.url
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "linkedin_single"); return r
    _single_mode_assertions(r, data, "linkedin", max_urls=8)
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "linkedin_single")
    return r
