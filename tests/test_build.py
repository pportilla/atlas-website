from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from urllib.parse import unquote, urljoin, urlsplit

from scripts import build_site


ATLAS = Path(os.environ.get("ATLAS_CHECKOUT", Path(__file__).resolve().parents[2] / "atlas"))


class ManualLinksTests(unittest.TestCase):
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


class CatalogueExportTests(unittest.TestCase):
    def test_only_committed_json_is_published_and_index_has_every_record(self):
        with tempfile.TemporaryDirectory() as temp:
            checkout = Path(temp) / "catalogue"
            records = checkout / "records"
            records.mkdir(parents=True)
            (records / "curve.json").write_text('{"id":"curve"}')
            (records / "notes.txt").write_text("notes")
            (checkout / "index.json").write_text('{"entries":[{"id":"curve"}]}')
            (checkout / "schema.json").write_text("{}")
            (checkout / "seeds.json").write_text("[]")
            subprocess.run(["git", "init", "-q"], cwd=checkout, check=True)
            subprocess.run(["git", "add", "."], cwd=checkout, check=True)
            commit = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm"]
            subprocess.run([*commit, "Initial catalogue"], cwd=checkout, check=True)
            revision = build_site.revision_of(checkout)
            (records / "curve.json").unlink()
            (records / "draft.json").write_text("{}")
            destination = Path(temp) / "edition"
            build_site.export_catalogue(checkout, revision, destination)
            self.assertEqual({p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()},
                             {"index.json", "schema.json", "records/curve.json"})
            subprocess.run([*commit, "Missing record", "-a"], cwd=checkout, check=True)
            with self.assertRaisesRegex(ValueError, "index and record IDs disagree"):
                build_site.export_catalogue(checkout, build_site.revision_of(checkout), Path(temp) / "invalid")


class PageLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
        self.ids = set()
        self.links = set()
        self.destinations = []
        self.brand_links = []
        self.in_header = False
        self.header_link = None
        self.in_destinations = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        for name in ("href", "src"):
            if name in attrs:
                self.urls.append(attrs[name])
        if tag == "header":
            self.in_header = True
        elif tag == "nav" and attrs.get("aria-label") == "Atlas destinations":
            self.in_destinations = True
        elif tag == "a" and "href" in attrs:
            self.links.add(attrs["href"])
            if self.in_destinations:
                self.destinations.append(attrs["href"])
            if self.in_header:
                self.header_link = attrs["href"]
        elif self.header_link is not None:
            ascii_logo = tag == "pre" and "ascii-art" in attrs.get("class", "").split()
            image_logo = tag == "img" and Path(urlsplit(attrs.get("src", "")).path).name == "atlas-mark.svg"
            if ascii_logo or image_logo:
                self.brand_links.append(self.header_link)

    def handle_endtag(self, tag):
        if tag == "a":
            self.header_link = None
        elif tag == "header":
            self.in_header = False
        elif tag == "nav":
            self.in_destinations = False


@unittest.skipUnless((ATLAS / "docs/site/build.py").is_file(), "Set ATLAS_CHECKOUT to run the manual integration test")
class BuildTests(unittest.TestCase):
    def test_build_and_rebuild_same_output(self):
        sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ATLAS, text=True).strip()
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "public"
            build_site.build(ATLAS, out)
            kernel = out / "docs/source/native/groebner.cpp.html"
            self.assertIn('<a href="../../../index.html">Atlas website</a>', kernel.read_text())
            self.assertIn('href="../../../zoo/" aria-label="Resolution Zoo"', kernel.read_text())
            self.assertTrue((kernel.parent / "../../../index.html").is_file())
            build_site.build(ATLAS, out)
            terminal = (out / "terminal/index.html").read_text()
            self.assertIn('src="../assets/terminal.js"', terminal)
            self.assertIn('id="start-terminal"', terminal)
            self.assertIn('<span class="t-brand">', terminal)
            self.assertNotIn("http-equiv=", terminal)
            resolution = (out / "resolution/index.html").read_text()
            self.assertIn('id="resolve-form"', resolution)
            self.assertIn('id="runtime-status"', resolution)
            self.assertIn('<span class="t-paper">', resolution)
            self.assertNotIn("<!--atlas:", resolution)
            self.assertIn('href="../" aria-label="Atlas home"', resolution)
            hook = resolution.index('src="../assets/resolution.js"')
            self.assertLess(hook, resolution.index('src="exact-json.js"'))
            self.assertLess(hook, resolution.index('src="app.js"'))
            for asset in ("app.js", "exact-json.js", "identity.css", "style.css", "fonts/source-code-pro.woff2"):
                with self.subTest(asset=asset):
                    original = subprocess.check_output(["git", "show", f"{sha}:web/{asset}"], cwd=ATLAS)
                    self.assertEqual((out / "resolution" / asset).read_bytes(), original)

            zoo = (out / "zoo/index.html").read_text()
            self.assertIn('href="../resolution/"', zoo)
            self.assertIn('href="../zoo/"', resolution)
            self.assertIn('src="./search.js"', zoo)
            self.assertIn('src="./zoo.js"', zoo)
            self.assertNotIn("<!--atlas:", zoo)
            self.assertFalse((out / "resolution/zoo-data").exists())
            catalogue = Path(os.environ.get("ATLAS_ZOO_DIR", ATLAS.parent / "resolution-zoo"))
            zoo_sha = build_site.revision_of(catalogue)
            self.assertIn(f'href="{build_site.ZOO_URL}/tree/{zoo_sha}"', zoo)
            self.assertEqual(json.loads((out / "version.json").read_bytes()),
                             {"website": build_site.revision_of(build_site.ROOT), "atlas": sha, "zoo": zoo_sha})
            data = out / "zoo/zoo-data"
            self.assertEqual({p.name for p in data.iterdir()}, {"index.json", "schema.json", "records"})
            for fixture in ("index.json", "schema.json", "records/mixed-quartic.json"):
                committed = subprocess.check_output(["git", "show", f"{zoo_sha}:{fixture}"], cwd=catalogue)
                self.assertEqual((data / fixture).read_bytes(), committed)
            index = json.loads((data / "index.json").read_bytes())
            self.assertGreaterEqual(len(index["entries"]), 50)
            for entry in index["entries"]:
                self.assertTrue((out / "zoo/zoo-data/records" / (entry["id"] + ".json")).is_file())
            self.assertEqual((out / "zoo/zoo-kernel.wasm").read_bytes()[:4], b"\0asm")
            home = (out / "index.html").read_text()
            self.assertEqual(home.lower().count("<!doctype html>"), 1)
            self.assertFalse((out / "assets/fonts").exists())
            self.assertFalse((out / "assets/atlas-mark.svg").exists())
            self.assertNotRegex(home, r"@[A-Z_]+@|\{\{\w+\}\}")
            artwork = re.compile(r'<pre\b[^>]*\bascii-art\b[^>]*>(.*?)</pre>', re.DOTALL)
            terminal_wordmarks = artwork.findall(terminal)
            self.assertEqual(len(terminal_wordmarks), 1)
            self.assertEqual(artwork.findall(home), terminal_wordmarks)
            self.assertIn(terminal_wordmarks[0], home.partition("</header>")[0])
            upstream_map = re.search(r'<pre\b[^>]*\bwelcome-map\b[^>]*>(.*?)</pre>', resolution, re.DOTALL)
            self.assertIsNotNone(upstream_map)
            self.assertNotIn(upstream_map[1], home)
            headings = re.findall(r'<h1\b([^>]*)>(.*?)</h1>', home, re.DOTALL)
            self.assertEqual(len(headings), 1)
            attributes, content = headings[0]
            label = re.search(r'\baria-label="([^"]*)"', attributes)
            self.assertEqual(label[1] if label else re.sub(r"<[^>]+>", "", content).strip(), "Atlas")
            copy = " ".join(re.sub(r"<[^>]+>", " ", home).split())
            for phrase in ("Computer Algebra System with a focus on resolution of singularities", "by p portilla",
                           "ChatGPT", "Claude", "Universidad Politécnica de Madrid"):
                with self.subTest(phrase=phrase):
                    self.assertIn(phrase, copy)
            links = PageLinks()
            links.feed(home)
            self.assertNotIn("sidebar", links.ids)
            site = "https://example.github.io/atlas-website/"
            self.assertCountEqual(
                [urljoin(site, href) for href in links.destinations],
                [site + route for route in ("docs/", "terminal/", "resolution/", "zoo/")] + [build_site.ATLAS_URL],
            )
            self.assertIn("mailto:p.portilla@upm.es", links.links)
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
            for page in out.rglob("*.html"):
                with self.subTest(brand=page.relative_to(out)):
                    header = PageLinks()
                    header.feed(page.read_text(encoding="utf-8").partition("</header>")[0])
                    self.assertEqual(len(header.brand_links), 1, "Expected a linked Atlas logo in the masthead")
                    page_url = site + page.relative_to(out).as_posix()
                    self.assertIn(urljoin(page_url, header.brand_links[0]), (site, site + "index.html"))
            guide = (out / "docs/developer/lean-verification-roadmap.html").read_text()
            self.assertIn('<a href="../../index.html">Atlas website</a>', guide)
            self.assertIn('<a href="../index.html">Atlas website</a>', (out / "docs/index.html").read_text())
            self.assertIn('href="../source/native/groebner.cpp.html"', guide)
            self.assertIn(f'{build_site.ATLAS_URL}/blob/{sha}/docs/developer/lean-verification-roadmap.md"', guide)
            reference = (out / "docs/reference/germ-invariants.html").read_text()
            self.assertRegex(reference, r"\.\./source/native/ae_codimension\.cpp\.html#L[0-9]+")
            self.assertIn('href="../tutorial/local-algebra.html#', reference)


if __name__ == "__main__":
    unittest.main()
