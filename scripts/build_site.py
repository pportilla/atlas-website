#!/usr/bin/env python3
"""Build the Atlas website from committed Atlas and Resolution Zoo sources.

The project homepage is a standalone page in static/index.html. In static/ HTML
files, @ATLAS_REVISION@ and @ATLAS_SHORT@ expand to the full and abbreviated
Atlas commit SHA. @ATLAS_WORDMARK@ expands to the terminal wordmark from that
commit. Install the Atlas checkout's
requirements-docs.txt in this Python environment before running the build.

    python3 scripts/build_site.py --atlas ../atlas --zoo ../resolution-zoo --out dist
"""
import argparse
from collections import defaultdict
from html import escape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory, TemporaryFile
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
ATLAS_URL = "https://github.com/pportilla/atlas"
ZOO_URL = "https://github.com/pportilla/resolution-zoo"
# The Resolution Zoo page belongs to the website; the Atlas server serves only
# the resolution suite. The page reads its records from the Zoo repository.
ZOO_PAGE = ROOT / "zoo-page"
SEARCH_ASSIGNMENT = "window.ATLAS_SEARCH = "
BUILD_MARKER = ".atlas-website-output"
UPSTREAM_LINK = re.compile(r"""(<a\b[^>]*?\shref=["']""" + re.escape(ATLAS_URL) + r"/(?:blob|tree)/)main/")


def revision_of(checkout):
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError(f"Expected a GitHub commit SHA, got {sha!r}")
    return sha


def pin_source_links(html, revision):
    """Point GitHub links at the same commit as the manual's local source views."""
    return UPSTREAM_LINK.sub(rf"\g<1>{revision}/", html)


class Anchors(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name == "id":
                self.ids.add(value)


def audit_search(docs):
    """Keep the search index in sync with the pages and anchors being published."""
    index = docs / "_static/search-index.js"
    script = index.read_text(encoding="utf-8").strip()
    if not script.startswith(SEARCH_ASSIGNMENT) or not script.endswith(";"):
        raise ValueError("Unrecognized Atlas search index format")
    records = json.loads(script[len(SEARCH_ASSIGNMENT):-1])
    fragments = defaultdict(set)
    for record in records:
        url = urlsplit(record["url"])
        path = posixpath.normpath(unquote(url.path))
        if url.scheme or url.netloc or path.startswith("/") or path == ".." or path.startswith("../"):
            raise ValueError(f"Unexpected Atlas search target: {record['url']}")
        if not (docs / path).is_file() or not path.endswith(".html"):
            raise ValueError(f"Missing Atlas search target: {record['url']}")
        if url.fragment:
            fragments[path].add(unquote(url.fragment))
    for path, ids in fragments.items():
        parser = Anchors()
        parser.feed((docs / path).read_text(encoding="utf-8"))
        parser.close()
        if missing := ids - parser.ids:
            raise ValueError(f"Missing Atlas search anchors in {path}: {sorted(missing)}")


class ManualWordmark(HTMLParser):
    """Locate the header wordmark independently of attribute order and page depth."""
    def __init__(self, home):
        super().__init__()
        self.home = home
        self.tag = None
        self.project_tag = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag != "a" or "brand" not in (attrs.get("class") or "").split():
            return
        if self.tag:
            raise ValueError("Multiple Atlas wordmarks in the documentation header")
        self.tag = self.get_starttag_text()
        attrs.update({"href": self.home, "aria-label": "Atlas home"})
        attributes = " ".join(name if value is None else f'{name}="{escape(value)}"' for name, value in attrs.items())
        self.project_tag = f"<a {attributes}>"


def zoo_link(href):
    return (f'<a class="zoo-shortcut" href="{href}" aria-label="Resolution Zoo">'
            f'<img src="{href}zoo-mark.svg" width="22" height="22" alt=""> <span>Resolution Zoo</span></a>')


def prepare_manual(atlas, docs, revision, zoo_revision):
    subprocess.run([sys.executable, "docs/site/build.py", "--out", str(docs)], cwd=atlas, check=True)
    for file in docs.rglob("*.html"):
        page = file.relative_to(docs).as_posix()

        revised = pin_source_links(file.read_text(encoding="utf-8"), revision)
        for kind in ("blob", "tree"):
            revised = revised.replace(f'href="{ZOO_URL}/{kind}/main/', f'href="{ZOO_URL}/{kind}/{zoo_revision}/')
        footer_end = "</footer>"
        if revised.count(footer_end) != 1:
            raise ValueError(f"Cannot locate the Atlas documentation footer in {page}")
        home = posixpath.relpath("index.html", posixpath.dirname(f"docs/{page}"))
        site_root = home.removesuffix("index.html")
        header, separator, rest = revised.partition("</header>")
        wordmark = ManualWordmark(site_root)
        wordmark.feed(header)
        if not separator or not wordmark.tag:
            raise ValueError(f"Cannot locate the Atlas documentation wordmark in {page}")
        revised = header.replace(wordmark.tag, wordmark.project_tag, 1) + separator + rest
        revised = re.sub(r'(<nav class="topnav"[^>]*>.*?)(</nav>)',
                         lambda match: match[1] + zoo_link(site_root + "zoo/") + match[2], revised, count=1)
        revised = revised.replace("</head>", f'<link rel="stylesheet" href="{site_root}tools.css">\n</head>', 1)
        backlink = f' · <a href="{home}">Atlas website</a>'
        file.write_text(revised.replace(footer_end, backlink + footer_end), encoding="utf-8")
    audit_search(docs)


def render_brand(atlas):
    """Fill the resolution page and the website's Zoo page with the pinned checkout's artwork."""
    command = (
        "import json, sys; from pathlib import Path; "
        "from engine.web_brand import wordmark_html, fill_brand; "
        "zoo = sys.stdin.read(); "
        "print(json.dumps([wordmark_html(), fill_brand(Path('web', 'index.html').read_text()), fill_brand(zoo)]))"
    )
    zoo = (ZOO_PAGE / "zoo.html").read_text(encoding="utf-8")
    return json.loads(subprocess.check_output([sys.executable, "-c", command], cwd=atlas, text=True, input=zoo))


def prepare_resolution(atlas, site, upstream):
    """Stage the upstream application and load the browser HTTP adapter before app.js."""
    target = site / "resolution"
    panel = (target / "index.html").read_text(encoding="utf-8")
    shutil.copytree(atlas / "web", target, dirs_exist_ok=True, ignore=shutil.ignore_patterns("zoo*"))

    def local_url(match):
        relative = match["path"] or "../"
        if relative in ("zoo.css", "zoo-mark.svg"):
            relative = "../zoo/" + relative
        elif relative == "zoo/":
            relative = "../zoo/"
        return f'{match["attr"]}="{relative}"'

    page = re.sub(r'(?P<attr>href|src)="/(?P<path>[^"/][^"]*|)"', local_url, upstream)
    # The Atlas server has no Zoo page, so the website links its own.
    if 'class="zoo-nav-link"' not in page:
        title = '<h1 class="workspace-name">Resolution</h1>'
        if page.count(title) != 1:
            raise ValueError("Cannot locate the resolution title for the Zoo link")
        page = page.replace(title, title + '\n      <a class="zoo-nav-link" href="../zoo/"><img src="../zoo/zoo-mark.svg" '
                            'width="25" height="25" alt="">Resolution Zoo</a>', 1)
    if 'href="../zoo/zoo.css"' not in page:
        page = page.replace("</head>", '<link rel="stylesheet" href="../zoo/zoo.css">\n</head>', 1)
    hook = '<script src="../assets/resolution.js"></script>'
    page = page.replace("</head>", '<link rel="stylesheet" href="../tools.css">\n</head>')
    page = page.replace("<script ", hook + "\n  <script ", 1)
    page = page.replace("</header>", "</header>\n" + panel, 1)
    (target / "index.html").write_text(page, encoding="utf-8")


def export_catalogue(checkout, revision, destination):
    """Stage the committed index, schema and indexed JSON records for offline use."""
    (destination / "records").mkdir(parents=True)
    with TemporaryFile() as snapshot:
        subprocess.run(["git", "archive", "--format=tar", revision, "--", "index.json", "schema.json", "records"],
                       cwd=checkout, stdout=snapshot, check=True)
        snapshot.seek(0)
        with tarfile.open(fileobj=snapshot, mode="r|") as archive:
            for member in archive:
                if member.name not in {"index.json", "schema.json"} and not re.fullmatch(
                        r"records/[a-z0-9]+(?:-[a-z0-9]+)*\.json", member.name):
                    continue
                if not member.isfile():
                    raise ValueError(f"Expected a JSON file in Resolution Zoo: {member.name}")
                with (destination / member.name).open("wb") as target:
                    shutil.copyfileobj(archive.extractfile(member), target)
    entries = json.loads((destination / "index.json").read_bytes())["entries"]
    ids = {entry["id"] for entry in entries}
    if len(ids) != len(entries) or ids != {path.stem for path in (destination / "records").iterdir()}:
        raise ValueError("Resolution Zoo index and record IDs disagree")


def prepare_zoo(atlas, site, upstream, catalogue, zoo_revision):
    """Stage the recorded results and compile the native matcher used at the Atlas prompt."""
    target = site / "zoo"
    for asset in ("zoo.css", "zoo.js", "zoo-mark.svg"):
        shutil.copy2(ZOO_PAGE / asset, target / asset)
    export_catalogue(catalogue, zoo_revision, target / "zoo-data")
    upstream = upstream.replace(f'href="{ZOO_URL}"', f'href="{ZOO_URL}/tree/{zoo_revision}"')
    shared = ("atlas-mark.svg", "identity.css", "style.css", "resolution.css", "complex.css",
              "exact-json.js", "typeset.js", "dual-graph.js")
    for asset in shared:
        upstream = upstream.replace(f'"./{asset}"', f'"../resolution/{asset}"')
    upstream = upstream.replace('class="zoo-suite-link" href="../"', 'class="zoo-suite-link" href="../resolution/"')
    upstream = upstream.replace('<script src="./zoo.js"', '<script src="./search.js" defer></script>\n  <script src="./zoo.js"')
    (target / "index.html").write_text(upstream, encoding="utf-8")
    subprocess.run(["em++", str(atlas / "native/zoo_search.cpp"), "-std=c++17", "-Oz", "-fexceptions",
                    "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=worker", "-sALLOW_MEMORY_GROWTH=1",
                    "-sEXPORTED_FUNCTIONS=_malloc,_free,_atlas_zoo_create,_atlas_zoo_search,_atlas_zoo_error",
                    "-sEXPORTED_RUNTIME_METHODS=UTF8ToString", "-o", str(target / "zoo-kernel.mjs")], check=True)


def build(atlas, out, catalogue=None):
    atlas = atlas.resolve(strict=True)
    catalogue = Path(catalogue or os.environ.get("ATLAS_ZOO_DIR", atlas.parent / "resolution-zoo")).resolve(strict=True)
    if out.is_symlink():
        raise ValueError(f"Choose an output directory instead of a symlink: {out}")
    out = out.resolve()
    if any(out == source or out in source.parents for source in (ROOT, atlas, catalogue)) or out.is_relative_to(catalogue):
        raise ValueError("Choose a build output separate from the repository roots.")
    if out.is_relative_to(ROOT / "static"):
        raise ValueError("Choose a build output outside the static source directory.")
    if out.exists() and (not out.is_dir() or (any(out.iterdir()) and not (out / BUILD_MARKER).is_file())):
        raise ValueError(f"Choose an empty output directory: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    revision = revision_of(atlas)
    zoo_revision = revision_of(catalogue)
    with TemporaryDirectory(dir=out.parent) as temp:
        # The manual includes version and source-line links. Read only committed files,
        # even when another process is currently editing the input working tree.
        source = Path(temp) / "atlas"
        subprocess.run(["git", "clone", "--quiet", "--no-checkout", "--", str(atlas), str(source)], check=True)
        subprocess.run(["git", "checkout", "--quiet", "--detach", revision], cwd=source, check=True)
        site = Path(temp) / "site"
        shutil.copytree(ROOT / "static", site)
        wordmark, resolution, zoo = render_brand(source)
        substitutions = {"@ATLAS_REVISION@": revision, "@ATLAS_SHORT@": revision[:7],
                         "@ATLAS_WORDMARK@": wordmark}
        for page in site.rglob("*.html"):
            html = page.read_text(encoding="utf-8")
            for token, value in substitutions.items():
                html = html.replace(token, value)
            page.write_text(html, encoding="utf-8")
        prepare_manual(source, site / "docs", revision, zoo_revision)
        prepare_resolution(source, site, resolution)
        prepare_zoo(source, site, zoo, catalogue, zoo_revision)
        versions = {"atlas": revision, "website": revision_of(ROOT), "zoo": zoo_revision}
        (site / "version.json").write_text(json.dumps(versions) + "\n", encoding="utf-8")
        (site / ".nojekyll").touch()
        (site / BUILD_MARKER).touch()
        # Stage in the destination filesystem so a failed compile preserves the previous site.
        previous = Path(temp) / "previous"
        if out.exists():
            out.rename(previous)
        try:
            site.rename(out)
        except OSError:
            if previous.exists():
                previous.rename(out)
            raise
    return revision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atlas", type=Path, required=True, help="Atlas source checkout")
    parser.add_argument("--zoo", type=Path, help="Resolution Zoo checkout (default: ATLAS_ZOO_DIR or sibling resolution-zoo)")
    parser.add_argument("--out", type=Path, required=True, help="generated website directory")
    args = parser.parse_args()
    revision = build(args.atlas, args.out, args.zoo)
    print(f"Built {args.out} from Atlas {revision}")


if __name__ == "__main__":
    main()
