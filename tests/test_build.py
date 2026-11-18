from html.parser import HTMLParser
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from urllib.parse import unquote, urlsplit

from scripts import build_site


ATLAS = Path(os.environ.get("ATLAS_CHECKOUT", Path(__file__).resolve().parents[2] / "atlas"))


class ManualLinksTests(unittest.TestCase):
    def test_runtime_urls_accept_web_and_loopback_for_local_runs(self):
        for value in ("https://mybinder.org/v2/gh/org/site/sha?urlpath=tool%2F", "../terminal/",
                      "http://localhost:8888/tool", "http://[::1]:8888/tool"):
            self.assertEqual(build_site.runtime_url(value), value)
        for value in ("javascript:alert(1)", "//example.org/app", "http://example.org/app", "https:///app",
                      "https://user:password@example.org/app", "bad\nlink", "/\\example.org/app"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build_site.runtime_url(value)

    def test_pin_git_links_preserves_local_line_links(self):
        sha = "a" * 40
        for kind in ("tree", "blob"):
            url = f"{build_site.ATLAS_URL}/{kind}/main/example"
            link = f'<a class="source" href="{url}#L12">example</a>'
            self.assertEqual(build_site.pin_source_links(link, sha), link.replace("/main/", f"/{sha}/"))
        for url in ("../source/native/example.cpp.html#L12", "https://example.org/blob/main/example"):
            link = f'<a href="{url}">example</a>'
            self.assertEqual(build_site.pin_source_links(link, sha), link)

    def test_search_checks_guide_anchors(self):
        with tempfile.TemporaryDirectory() as temp:
            docs = Path(temp)
            (docs / "_static").mkdir()
            (docs / "index.html").write_text('<h2 id="alg">Algebra</h2>')
            guide = {"url": "index.html#alg", "text": "Algebra"}
            index = docs / "_static/search-index.js"
            index.write_text(build_site.SEARCH_ASSIGNMENT + json.dumps([guide]) + ";")
            build_site.audit_search(docs)
            (docs / "index.html").write_text('<h2 id="new-heading">Algebra</h2>')
            with self.assertRaisesRegex(ValueError, "Missing Atlas search anchors"):
                build_site.audit_search(docs)


class PageLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
        self.ids = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        for name in ("href", "src"):
            if name in attrs:
                self.urls.append(attrs[name])


@unittest.skipUnless((ATLAS / "docs/site/build.py").is_file(), "Set ATLAS_CHECKOUT to run the manual integration test")
class BuildTests(unittest.TestCase):
    def test_build_and_rebuild_same_output(self):
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ATLAS, text=True).strip()
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "public"
            build_site.build(ATLAS, out)
            kernel = out / "docs/source/native/groebner.cpp.html"
            self.assertIn('<a href="../../../index.html">Atlas website</a>', kernel.read_text())
            self.assertTrue((kernel.parent / "../../../index.html").is_file())
            self.assertIn(build_site.TERMINAL_DEFAULT, (out / "terminal/index.html").read_text())
            build_site.build(ATLAS, out, terminal_url="https://example.com/app?a=1&b=2", resolution_url="./suite/")
            self.assertIn('href="https://example.com/app?a=1&amp;b=2"', (out / "terminal/index.html").read_text())
            self.assertIn('href="./suite/"', (out / "resolution/index.html").read_text())

            home = (out / "index.html").read_text()
            self.assertEqual(home.lower().count("<!doctype html>"), 1)
            self.assertEqual(home.count('<article class="prose">'), 1)
            self.assertIn('<body data-root="docs/">', home)
            self.assertIn('href="./" aria-label="Atlas home"', home)
            self.assertIn('<span class="brand-label">home</span>', home)
            self.assertIn(f'title="Version">{sha[:7]}</span>', home)
            self.assertIn('class="theme-toggle"', home)
            self.assertIn('localStorage.getItem("atlas-theme")', home)
            for name in ("atlas-mark.svg", "identity.css", "docs.css", "docs.js", "search-index.js"):
                self.assertIn(f'"docs/_static/{name}"', home)
            self.assertFalse((out / "assets/fonts").exists())
            self.assertFalse((out / "assets/atlas-mark.svg").exists())
            self.assertNotRegex(home, r"@[A-Z_]+@|\{\{\w+\}\}")
            self.assertIn('<span class="t-paper">', home)
            self.assertIn('<span class="t-brand">', home)
            links = PageLinks()
            links.feed(home)
            self.assertTrue({"search", "search-results", "sidebar", "plane-cusp", "work-with-atlas"} <= links.ids)
            for url in links.urls:
                parsed = urlsplit(url)
                if parsed.netloc or parsed.scheme:
                    continue
                target = out / unquote(parsed.path)
                if target.is_dir():
                    target = target / "index.html"
                with self.subTest(url=url):
                    self.assertTrue(target.is_file())
                    if parsed.fragment:
                        anchors = PageLinks()
                        anchors.feed(target.read_text())
                        self.assertIn(unquote(parsed.fragment), anchors.ids)
            guide = (out / "docs/docs/lean-verification-roadmap.html").read_text()
            self.assertIn('<a href="../../index.html">Atlas website</a>', guide)
            self.assertIn('<a href="../index.html">Atlas website</a>', (out / "docs/index.html").read_text())
            self.assertIn('href="../source/native/groebner.cpp.html"', guide)
            self.assertIn(f'{build_site.ATLAS_URL}/blob/{sha}/docs/lean-verification-roadmap.md"', guide)
            reference = (out / "docs/reference/functions.html").read_text()
            self.assertRegex(reference, r"\.\./source/native/ae_codimension\.cpp\.html#L[0-9]+")
            self.assertIn('href="../docs/sessions.html#', reference)


if __name__ == "__main__":
    unittest.main()
