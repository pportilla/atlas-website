#!/usr/bin/env python3
"""Build the Atlas website from a website template and an Atlas git checkout.

In static/ HTML files, @ATLAS_REVISION@ expands to the full checkout SHA,
@ATLAS_SHORT@ to its first seven characters, and @TERMINAL_URL@ and
@RESOLUTION_URL@ to the HTML-escaped runtime links. Install the Atlas checkout's
requirements-docs.txt in this Python environment before running the build.

    python3 scripts/build_site.py --atlas ../atlas --out dist
"""
import argparse
from collections import defaultdict
from html import escape
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
TERMINAL_DEFAULT = "http://127.0.0.1:8888/atlas-terminal/"
RESOLUTION_DEFAULT = "http://127.0.0.1:8888/atlas-resolution/"


def revision_of(atlas):
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=atlas, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError(f"Expected a GitHub commit SHA, got {sha!r}")
    return sha


def runtime_url(value):
    """Accept HTTPS and local development links for the runtime launch buttons."""
    if not value or re.search(r"[\x00-\x20\x7f\\]", value) or value.startswith("//"):
        raise ValueError(f"Invalid runtime URL: {value!r}")
    parts = urlsplit(value)
    if not parts.scheme and not parts.netloc:
        return value
    if parts.hostname and parts.username is None and parts.password is None:
        if parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"}):
            return value
    raise ValueError("Choose an HTTPS, loopback HTTP, or relative runtime URL.")


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


def build(atlas, out, terminal_url=TERMINAL_DEFAULT, resolution_url=RESOLUTION_DEFAULT):
    atlas = atlas.resolve(strict=True)
    terminal_url = runtime_url(terminal_url)
    resolution_url = runtime_url(resolution_url)
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
        substitutions = {"@ATLAS_REVISION@": revision, "@ATLAS_SHORT@": revision[:7],
                         "@TERMINAL_URL@": escape(terminal_url), "@RESOLUTION_URL@": escape(resolution_url)}
        for page in site.rglob("*.html"):
            html = page.read_text(encoding="utf-8")
            for token, value in substitutions.items():
                html = html.replace(token, value)
            page.write_text(html, encoding="utf-8")
        assets = site / "assets"
        shutil.copytree(source / "web/fonts", assets / "fonts")
        shutil.copy2(source / "web/atlas-mark.svg", assets / "atlas-mark.svg")
        prepare_manual(source, site / "docs", revision)
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
    parser.add_argument("--terminal-url", type=runtime_url, default=TERMINAL_DEFAULT,
                        help="URL that launches the Atlas terminal")
    parser.add_argument("--resolution-url", type=runtime_url, default=RESOLUTION_DEFAULT,
                        help="URL that launches the resolution suite")
    args = parser.parse_args()
    revision = build(args.atlas, args.out, args.terminal_url, args.resolution_url)
    print(f"Built {args.out} from Atlas {revision}")


if __name__ == "__main__":
    main()
