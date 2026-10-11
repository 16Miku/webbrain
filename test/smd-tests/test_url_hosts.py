"""Offline adversarial coverage for optional SMD URL host assertions."""
import unittest

from url_hosts import url_has_host


DOMAINS = (
    "pinimg.com", "redd.it", "redditmedia.com", "cdninstagram.com",
    "fbcdn.net", "twimg.com", "ytimg.com", "googlevideo.com",
)


class URLHostTests(unittest.TestCase):
    def test_exact_expected_domains(self):
        for domain in DOMAINS:
            with self.subTest(domain=domain):
                self.assertTrue(url_has_host("https://" + domain + "/media", domain))

    def test_case_and_bounded_subdomains(self):
        for domain in DOMAINS:
            with self.subTest(domain=domain):
                self.assertTrue(url_has_host("HTTPS://A.B." + domain.upper() + "/media", domain))

    def test_intended_media_paths_and_queries_are_preserved(self):
        cases = (
            ("https://i.pinimg.com/originals/ab/image.jpg", "pinimg.com"),
            ("https://video.twimg.com/ext_tw_video/clip.mp4?name=orig", "twimg.com"),
            ("https://v1.pinimg.com/videos/clip.m3u8?token=a%2Fb", "pinimg.com"),
            ("https://i.ytimg.com/vi/id/hqdefault.jpg", "ytimg.com"),
            ("https://r1.googlevideo.com/videoplayback?signature=a%2Bb", "googlevideo.com"),
            ("https://ytimg.com:443/path/\u2603?name=orig", "ytimg.com"),
        )
        for url, domain in cases:
            with self.subTest(url=url):
                self.assertTrue(url_has_host(url, domain))

    def test_domain_tokens_in_path_query_or_fragment_do_not_match(self):
        for domain in DOMAINS:
            for suffix in ("/" + domain + "/originals/image.jpg", "?next=https://" + domain, "#" + domain):
                with self.subTest(domain=domain, suffix=suffix):
                    self.assertFalse(url_has_host("https://attacker.invalid" + suffix, domain))

    def test_lookalike_hostnames_do_not_match(self):
        for host in ("evilytimg.com", "ytimg.com.attacker.invalid", "ytimg-com.invalid", "ytimg.comevil"):
            with self.subTest(host=host):
                self.assertFalse(url_has_host("https://" + host + "/media", "ytimg.com"))

    def test_userinfo_never_participates_in_host_classification(self):
        for url in (
            "https://ytimg.com@attacker.invalid/media",
            "https://user@ytimg.com/media",
            "https://user:password@ytimg.com/media",
            "https://@ytimg.com/media",
        ):
            with self.subTest(url=url):
                self.assertFalse(url_has_host(url, "ytimg.com"))

    def test_malformed_and_ambiguous_urls_fail_without_throwing(self):
        for url in (
            "", "ytimg.com/media", "//ytimg.com/media", "ftp://ytimg.com/media",
            "https:///ytimg.com/media", "https://[ytimg.com/media",
            "https://ytimg.com:bad/media", "https://ytimg.com:65536/media", "https://ytimg.com:/media",
            "https://ytimg.com\\@attacker.invalid/media", "https://ytimg.com/\\media",
            " https://ytimg.com/media", "https://ytimg.com/\nmedia", "https://ytimg.com/\x00media",
            "https://ytimg.com\x7f/media", "https://a..ytimg.com/media",
            "https://-a.ytimg.com/media", "https://a-.ytimg.com/media",
        ):
            with self.subTest(url=url):
                self.assertFalse(url_has_host(url, "ytimg.com"))

    def test_host_and_label_bounds(self):
        self.assertTrue(url_has_host("https://" + "a" * 63 + ".ytimg.com/media", "ytimg.com"))
        self.assertFalse(url_has_host("https://" + "a" * 64 + ".ytimg.com/media", "ytimg.com"))
        host = ("a" * 63 + ".") * 3 + "b" * 51 + ".ytimg.com"
        self.assertEqual(len(host), 253)
        self.assertTrue(url_has_host("https://" + host + "/media", "ytimg.com"))
        too_long_host = ("a" * 63 + ".") * 3 + "b" * 52 + ".ytimg.com"
        self.assertEqual(len(too_long_host), 254)
        self.assertFalse(url_has_host("https://" + too_long_host + "/media", "ytimg.com"))

    def test_encoded_or_non_dns_authority_is_not_a_domain_match(self):
        for host in ("%79timg.com", "ytimg.com%2eattacker.invalid", "ytimg.com%00", "\u0443timg.com", "a_b.ytimg.com"):
            with self.subTest(host=host):
                self.assertFalse(url_has_host("https://" + host + "/media", "ytimg.com"))

    def test_multiple_expected_domains_and_invalid_values(self):
        self.assertTrue(url_has_host("https://video.redditmedia.com/media", "redd.it", "redditmedia.com"))
        self.assertFalse(url_has_host("https://attacker.invalid/media", *DOMAINS))
        self.assertFalse(url_has_host("https://ytimg.com/media", "", ".ytimg.com", "ytimg.com/", None))
        self.assertFalse(url_has_host(None, "ytimg.com"))
        self.assertFalse(url_has_host(42, "ytimg.com"))


if __name__ == "__main__":
    unittest.main()
