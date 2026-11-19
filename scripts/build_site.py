#!/usr/bin/env python3
"""Build the Atlas website from a website template and an Atlas git checkout.

The article in static/index.html uses the upstream manual template and
@ATLAS_MAP@ displays the same Atlas artwork as the manual. In static/ HTML
files, @ATLAS_REVISION@ expands to the full checkout SHA,
@ATLAS_SHORT@ to its first seven characters, and @ATLAS_WORDMARK@ to the terminal wordmark. Install the Atlas checkout's
requirements-docs.txt in this Python environment before running the build.

    python3 scripts/build_site.py --atlas ../atlas --out dist
"""
import argparse
from collections import defaultdict
from html.parser import HTMLParser
import json
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
ATLAS_URL = "https://github.com/pportilla/atlas"
SEARCH_ASSIGNMENT = "window.ATLAS_SEARCH = "
BUILD_MARKER = ".atlas-website-output"
UPSTREAM_LINK = re.compile(r"""(<a\b[^>]*?\shref=["']""" + re.escape(ATLAS_URL) + r"/(?:blob|tree)/)main/")


def revision_of(atlas):
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=atlas, text=True).strip()
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


def prepare_manual(atlas, docs, revision):
    subprocess.run([sys.executable, "docs/site/build.py", "--out", str(docs)], cwd=atlas, check=True)
    for file in docs.rglob("*.html"):
        page = file.relative_to(docs).as_posix()

        revised = pin_source_links(file.read_text(encoding="utf-8"), revision)
        footer_end = "</footer>"
        if revised.count(footer_end) != 1:
            raise ValueError(f"Cannot locate the Atlas documentation footer in {page}")
        home = posixpath.relpath("index.html", posixpath.dirname(f"docs/{page}"))
        backlink = f' · <a href="{home}">Atlas website</a>'
        file.write_text(revised.replace(footer_end, backlink + footer_end), encoding="utf-8")
    audit_search(docs)


def render_brand(atlas):
    """Read the actual terminal and resolution artwork from the pinned checkout."""
    command = (
        "import json; from pathlib import Path; "
        "from engine.web_brand import wordmark_html, lettered_map_html, fill_brand; "
        "print(json.dumps([wordmark_html(), lettered_map_html(), fill_brand(Path('web/index.html').read_text())]))"
    )
    return json.loads(subprocess.check_output([sys.executable, "-c", command], cwd=atlas, text=True))


def prepare_resolution(atlas, site, upstream):
    """Stage the upstream application and load the browser HTTP adapter before app.js."""
    target = site / "resolution"
    panel = (target / "index.html").read_text(encoding="utf-8")
    shutil.copytree(atlas / "web", target, dirs_exist_ok=True)

    def local_url(match):
        relative = match["path"] or "../"
        return f'{match["attr"]}="{relative}"'

    page = re.sub(r'(?P<attr>href|src)="/(?P<path>[^"/][^"]*|)"', local_url, upstream)
    hook = '<script src="../assets/resolution.js"></script>'
    page = page.replace("</head>", '<link rel="stylesheet" href="../tools.css">\n</head>')
    page = page.replace("<script ", hook + "\n  <script ", 1)
    page = page.replace("</header>", "</header>\n" + panel, 1)
    (target / "index.html").write_text(page, encoding="utf-8")


def prepare_home(atlas, site, revision, wordmark, lettered_map):
    """Render the website overview with the pinned manual's template and artwork."""
    template = (atlas / "docs/site/template.html").read_text(encoding="utf-8")
    template = template.replace('href="{{root}}index.html" aria-label="Atlas documentation home"',
                                'href="./" aria-label="Atlas home"')
    template = template.replace('<span class="brand-label">docs</span>', '<span class="brand-label">home</span>')
    home_page = site / "index.html"
    article = home_page.read_text(encoding="utf-8").replace("@ATLAS_MAP@", lettered_map)

    manual = ("Manual", "docs/")
    tools = (("Terminal", "terminal/"), ("Resolution suite", "resolution/"))
    groups = {
        "Workspace": (("Overview", "./"), *tools),
        # The manual's front page lists the same documents.
        "Documentation": (manual, ("A tour of Atlas", "docs/tour.html"), ("Tutorial", "docs/tutorial/index.html"),
                          ("Constructions", "docs/constructions.html"),
                          ("Reference manual", "docs/reference/index.html"),
                          ("Function index", "docs/reference/genindex.html")),
        "Worked examples": (("Resolving a plane cusp", "docs/tutorial/resolving-a-cusp.html"),
                            ("Quotient rings", "docs/tutorial/quotient-rings.html"),
                            ("Geometry at a rational point", "docs/tutorial/local-geometry.html")),
    }
    sidebar = []
    for title, links in groups.items():
        items = []
        for label, href in links:
            current = ' aria-current="page"' if href == "./" else ""
            items.append(f'<li><a href="{href}"{current}>{label}</a></li>')
        sidebar.append(f'<div class="nav-group"><h2>{title}</h2><ul>{"".join(items)}</ul></div>')
    toc = ('<h2>On this page</h2><ul>'
           '<li><a class="level-2" href="#work-with-atlas">Work with Atlas</a></li>'
           '<li><a class="level-2" href="#plane-cusp">Resolve a plane cusp</a></li></ul>')
    values = {
        "title": "Atlas · Algebra and resolution of singularities",
        "head": '<meta name="description" content="The Atlas manual, interactive terminal and resolution suite.">',
        "root": "docs/", "wordmark": wordmark, "version": revision[:7],
        "topnav": "".join(f'<a href="{href}">{label}</a>' for label, href in (manual, *tools)),
        "sidebar": "".join(sidebar), "toc": toc, "pager": "",
        "content": f'<details class="toc-inline"><summary>On this page</summary>{toc}</details>\n{article}',
        "footer": f'<a href="{ATLAS_URL}/tree/{revision}">Atlas source</a> · '
                  '<a href="https://github.com/pportilla/atlas-website">Website repository</a>',
    }
    home_page.write_text(re.sub(r"\{\{(\w+)\}\}", lambda match: values[match[1]], template), encoding="utf-8")


def build(atlas, out):
    atlas = atlas.resolve(strict=True)
    if out.is_symlink():
        raise ValueError(f"Choose an output directory instead of a symlink: {out}")
    out = out.resolve()
    if out == ROOT or out in ROOT.parents or out == atlas or out in atlas.parents:
        raise ValueError("Choose a build output separate from the repository roots.")
    if out.is_relative_to(ROOT / "static"):
        raise ValueError("Choose a build output outside the static source directory.")
    if out.exists() and (not out.is_dir() or (any(out.iterdir()) and not (out / BUILD_MARKER).is_file())):
        raise ValueError(f"Choose an empty output directory: {out}")
    out.parent.mkdir(parents=True, exist_ok=True)
    revision = revision_of(atlas)
    with TemporaryDirectory(dir=out.parent) as temp:
        # The manual includes version and source-line links. Read only committed files,
        # even when another process is currently editing the input working tree.
        source = Path(temp) / "atlas"
        subprocess.run(["git", "clone", "--quiet", "--no-checkout", "--", str(atlas), str(source)], check=True)
        subprocess.run(["git", "checkout", "--quiet", "--detach", revision], cwd=source, check=True)
        site = Path(temp) / "site"
        shutil.copytree(ROOT / "static", site)
        wordmark, lettered_map, resolution = render_brand(source)
        substitutions = {"@ATLAS_REVISION@": revision, "@ATLAS_SHORT@": revision[:7], "@ATLAS_WORDMARK@": wordmark}
        for page in site.rglob("*.html"):
            html = page.read_text(encoding="utf-8")
            for token, value in substitutions.items():
                html = html.replace(token, value)
            page.write_text(html, encoding="utf-8")
        prepare_manual(source, site / "docs", revision)
        prepare_home(source, site, revision, wordmark, lettered_map)
        prepare_resolution(source, site, resolution)
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
    parser.add_argument("--out", type=Path, required=True, help="generated website directory")
    args = parser.parse_args()
    revision = build(args.atlas, args.out)
    print(f"Built {args.out} from Atlas {revision}")


if __name__ == "__main__":
    main()
