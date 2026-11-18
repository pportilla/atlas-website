import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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


@unittest.skipUnless((ATLAS / "docs/site/build.py").is_file(), "Set ATLAS_CHECKOUT to run the manual integration test")
class BuildTests(unittest.TestCase):
    def test_build_and_rebuild_same_output(self):
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ATLAS, text=True).strip()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sources = root / "static"
            sources.mkdir()
            (sources / "index.html").write_text('@ATLAS_REVISION@ @ATLAS_SHORT@ '
                                                '<a href="@TERMINAL_URL@">Terminal</a> '
                                                '<a href="@RESOLUTION_URL@">Suite</a>')
            out = root / "public"
            with patch.object(build_site, "ROOT", root):
                build_site.build(ATLAS, out)
                kernel = out / "docs/source/native/groebner.cpp.html"
                self.assertIn('<a href="../../../index.html">Atlas website</a>', kernel.read_text())
                self.assertTrue((kernel.parent / "../../../index.html").is_file())
                self.assertIn(build_site.TERMINAL_DEFAULT, (out / "index.html").read_text())
                build_site.build(ATLAS, out, terminal_url="https://example.com/app?a=1&b=2",
                                 resolution_url="./suite/")
            self.assertEqual((out / "index.html").read_text(),
                             f'{sha} {sha[:7]} <a href="https://example.com/app?a=1&amp;b=2">Terminal</a> '
                             '<a href="./suite/">Suite</a>')
            self.assertTrue((out / "assets/atlas-mark.svg").is_file())
            self.assertTrue((out / "assets/fonts/source-code-pro.woff2").is_file())
            self.assertTrue((out / "docs/_static/search-index.js").is_file())
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
