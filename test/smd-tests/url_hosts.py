"""Host classification for optional SMD regression assertions, not access control."""
from __future__ import annotations

import re
from urllib.parse import urlsplit


_DNS_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z", re.ASCII)


def _valid_dns_host(host: str) -> bool:
    return 0 < len(host) <= 253 and all(
        _DNS_LABEL.fullmatch(label) for label in host.split(".")
    )


def url_has_host(url: str, *expected_domains: str) -> bool:
    """Match HTTP(S) DNS hosts exactly or below an expected domain boundary.

    DNS host/label limits bound subdomains. Credentials, ambiguous backslashes,
    raw ASCII whitespace/control characters and malformed ports fail classification.
    Paths and query strings do not participate in the host comparison.
    """
    if not isinstance(url, str) or not url or "\\" in url:
        return False
    if any(ord(char) <= 32 or ord(char) == 127 for char in url):
        return False
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        if parsed.netloc.endswith(":"):
            return False
        parsed.port  # Validate an explicitly supplied port without changing it.
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if not _valid_dns_host(host):
        return False
    for expected in expected_domains:
        if not isinstance(expected, str):
            continue
        domain = expected.lower()
        if _valid_dns_host(domain) and (host == domain or host.endswith("." + domain)):
            return True
    return False
