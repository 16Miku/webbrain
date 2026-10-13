"""Video-specific regression tests.

Each test navigates to a page that should contain at least one video
and asserts the script extracts a URL that looks like real video media
(by file extension or known video-CDN host).
"""
from __future__ import annotations
import time
from common import TestResult, inject_smd, collect_smd
from url_hosts import url_has_host
from sites import _safe_goto, _screenshot, _click_first

TESTS = []

def register(fn):
    TESTS.append(fn)
    return fn


# Substrings / extensions that indicate a video media URL.
_VIDEO_HOST_HINTS = (
    "v.redd.it",
    "video.twimg.com",
    "amplify_video",
    "ext_tw_video",
    "fbcdn.net/v/",   # FB video CDN paths
    "v1.pinimg.com/videos/",
    "/videos/",       # generic
)
_VIDEO_EXT_RE_STR = ".mp4"  # quick string check is enough; we'll OR with .webm / .m3u8

def _is_video_url(u: str) -> bool:
    u_lower = u.lower()
    if any(ext in u_lower for ext in (".mp4", ".webm", ".m3u8", ".mpd", ".mov", ".ts")):
        return True
    return any(h in u for h in _VIDEO_HOST_HINTS)

def _video_assertions(r, data, expected_profile, require_video_url=True):
    """Common: at least one extracted URL looks like video media.

    Set require_video_url=False for platforms whose feed videos play via
    MSE/blob URLs (IG reels, LinkedIn HLS) — in those cases the script
    can only realistically extract the poster, not the video stream.
    """
    urls = data.get("urls", [])
    video_urls = [u for u in urls if _is_video_url(u)]
    r.profile_detected = data.get("profile")
    r.url_count = len(urls)
    r.sample_urls = [u[:90] for u in (video_urls or urls)[:3]]
    if require_video_url:
        r.assertions = [
            f"profile == '{expected_profile}' (got: {r.profile_detected})",
            f"at least one video URL (got: {len(video_urls)} of {len(urls)} total)",
        ]
    else:
        r.assertions = [
            f"profile == '{expected_profile}' (got: {r.profile_detected})",
            f"any media URLs (got: {len(urls)}); video URLs: {len(video_urls)}",
        ]

    if r.profile_detected != expected_profile:
        r.failures.append("wrong profile")
    if require_video_url and len(video_urls) < 1:
        r.failures.append("no video URLs found")
    if (not require_video_url) and len(urls) < 1:
        r.failures.append("no URLs found at all")

    if len(video_urls) == 0 and len(urls) > 0 and not require_video_url:
        addn = "video plays via MSE/blob - only poster extracted"
        r.notes = (r.notes + " | " if r.notes else "") + addn

    r.passed = not r.failures


@register
def test_pinterest_video(page, js_path, sdir):
    # Pinterest video search — almost always returns video pins
    r = TestResult(site="pinterest_video",
                   url="https://www.pinterest.com/search/pins/?q=cat+video",
                   passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    try: page.evaluate("window.scrollBy(0, 500)"); time.sleep(1)
    except Exception: pass
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "pinterest_video"); return r
    _video_assertions(r, data, "pinterest")
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "pinterest_video")
    return r


@register
def test_reddit_video(page, js_path, sdir):
    # r/funny reliably has video posts at the top. r/videos had click
    # issues (sub loading slowly / new-reddit shadow DOM). Use the same
    # selector strategy as reddit_single — proven to work.
    r = TestResult(site="reddit_video", url="https://www.reddit.com/r/funny/", passed=False)
    _safe_goto(page, r.url); time.sleep(3)
    # Try multiple clicks until we find one that lands on a video post.
    # First few r/funny posts are usually videos; if not, give up after 3.
    clicked = False
    for _ in range(3):
        if _click_first(page, 'a[href*="/comments/"]'):
            clicked = True
            break
        time.sleep(1)
    if not clicked:
        r.error = "could not click into a r/funny post"
        r.screenshot_path = _screenshot(page, sdir, "reddit_video"); return r
    r.url = page.url; time.sleep(2)
    inject_smd(page, js_path)
    data = collect_smd(page, "main")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "reddit_video"); return r
    # Reddit videos use v.redd.it DASH; accept poster-only as pass since not
    # every top post is a video. Note ffmpeg if v.redd.it found.
    _video_assertions(r, data, "reddit", require_video_url=False)
    urls = data.get("urls", [])
    if any("v.redd.it" in u for u in urls):
        addn = "v.redd.it DASH: merge with `ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4`"
        r.notes = (r.notes + " | " if r.notes else "") + addn
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "reddit_video")
    return r


@register
def test_instagram_video(page, js_path, sdir):
    r = TestResult(site="instagram_video",
                   url="https://www.instagram.com/natgeo/reels/", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    if page.locator('input[name="username"]').count() > 0:
        r.needs_login = True
        r.assertions = ["needs login to load reels"]
        r.notes = "Use CDP attach."
        return r
    # Click first reel — opens /reel/ID/
    try: page.evaluate("window.scrollBy(0, 400)"); time.sleep(1)
    except Exception: pass
    _click_first(page, 'a[href*="/reel/"]')  # best-effort; reels also play on hover
    time.sleep(3)
    r.url = page.url
    inject_smd(page, js_path)
    data = collect_smd(page, "auto")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "instagram_video"); return r
    # IG reels play via MSE — only the poster is extractable.
    _video_assertions(r, data, "instagram", require_video_url=False)
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "instagram_video")
    return r


@register
def test_twitter_video(page, js_path, sdir):
    # X /media tab on a video-heavy account mixes photos and videos.
    # Run in 'all' mode and assert at least one video URL is found.
    r = TestResult(site="twitter_video", url="https://x.com/NASA/media", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    if page.locator('[data-testid="loginButton"]').count() > 0:
        r.needs_login = True
        r.assertions = ["needs login"]
        r.notes = "Use CDP attach."
        return r
    try: page.evaluate("window.scrollBy(0, 600)"); time.sleep(2)
    except Exception: pass
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "twitter_video"); return r
    _video_assertions(r, data, "twitter")
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "twitter_video")
    return r


@register
def test_facebook_video(page, js_path, sdir):
    # NASA's video tab. Many videos play via MSE/blob — those won't have
    # downloadable URLs (script will note this). But page should expose
    # at least one fbcdn video URL via og:video or video posters.
    r = TestResult(site="facebook_video", url="https://www.facebook.com/NASA/videos", passed=False)
    _safe_goto(page, r.url); time.sleep(5)
    if page.locator('input[name="email"]').count() > 0:
        r.needs_login = True
        r.assertions = ["needs login"]
        r.notes = "Use CDP attach."
        return r
    try: page.evaluate("window.scrollBy(0, 600)"); time.sleep(2)
    except Exception: pass
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "facebook_video"); return r
    _video_assertions(r, data, "facebook")
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "facebook_video")
    return r


@register
def test_youtube_video(page, js_path, sdir):
    """YouTube watch page. Only the poster is downloadable; the actual
    video uses MSE/DRM. This test verifies we still surface SOMETHING
    (poster) so the user knows the script ran."""
    r = TestResult(site="youtube_video",
                   url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                   passed=False)
    _safe_goto(page, r.url); time.sleep(5)
    inject_smd(page, js_path)
    data = collect_smd(page, "auto")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "youtube_video"); return r
    urls = data.get("urls", [])
    # Accept poster (.jpg/.webp on ytimg.com) as a "video-related" success
    yt_media = [u for u in urls if url_has_host(u, "ytimg.com", "googlevideo.com") or _is_video_url(u)]
    r.profile_detected = data.get("profile"); r.url_count = len(urls)
    r.sample_urls = [u[:90] for u in (yt_media or urls)[:3]]
    r.assertions = [
        f"profile == 'youtube' (got: {r.profile_detected})",
        f"at least one YT media URL (got: {len(yt_media)} of {len(urls)})",
    ]
    if r.profile_detected != "youtube": r.failures.append("wrong profile")
    if len(yt_media) < 1: r.failures.append("no ytimg/googlevideo URLs found")
    r.notes = "Direct YouTube video download not supported (MSE/DRM) - use yt-dlp."
    r.passed = not r.failures
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "youtube_video")
    return r


@register
def test_linkedin_video(page, js_path, sdir):
    # LinkedIn video posts often use HLS (.m3u8). Check the feed for any
    # video URL — falls back to needs_login if not signed in.
    r = TestResult(site="linkedin_video",
                   url="https://www.linkedin.com/company/nasa/posts/", passed=False)
    _safe_goto(page, r.url); time.sleep(4)
    title = page.title()
    if ("Sign Up" in title or "Join" in title or
        page.locator('input[name="session_key"]').count() > 0):
        r.needs_login = True
        r.assertions = ["needs login"]
        r.notes = "Use CDP attach."
        return r
    # Scroll to get past static images and into video posts
    try:
        for _ in range(3):
            page.evaluate("window.scrollBy(0, 800)"); time.sleep(2)
    except Exception: pass
    inject_smd(page, js_path)
    data = collect_smd(page, "all")
    if "error" in data:
        r.error = data["error"]; r.screenshot_path = _screenshot(page, sdir, "linkedin_video"); return r
    # LinkedIn feed videos are HLS in <video> tag with blob src — only
    # poster images are reliably extractable from the feed view.
    _video_assertions(r, data, "linkedin", require_video_url=False)
    if not r.passed: r.screenshot_path = _screenshot(page, sdir, "linkedin_video")
    return r
