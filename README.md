# Atlas website

[Open the website](https://pportilla.github.io/atlas-website/) for the [manual](https://pportilla.github.io/atlas-website/docs/), [Atlas terminal](https://pportilla.github.io/atlas-website/terminal/), [Resolution Zoo](https://pportilla.github.io/atlas-website/zoo/), and [resolution suite](https://pportilla.github.io/atlas-website/resolution/).

The Zoo loads saved JSON records on demand and searches them with the native monomial matcher compiled to WebAssembly. Browsing and searching also work in the offline edition.

The terminal and resolution suite run on the visitor’s computer. When you start the terminal or submit a polynomial, the browser downloads a precompiled Atlas runtime and boots it in a Web Worker. It needs a recent desktop browser with WebAssembly threads, JavaScript, and enough memory for a Linux guest. The manual is available immediately. Closing the tab ends the session. Use **Download JSON** to keep a resolution record.

## Run the precompiled tools offline

[Download atlas-local.zip](https://github.com/pportilla/atlas-website/releases/latest/download/atlas-local.zip), extract it, and run `python3 start.py` from the extracted directory (on Windows, `py start.py`). A browser tab opens the local site. Press Ctrl+C in the terminal to stop serving it. The terminal and resolution suite work offline. The upstream manual uses a CDN for typeset mathematics and diagrams.

## How it works

GitHub Pages serves static files. The homepage shares the manual’s template, typography, artwork, search, and theme controls. Its article is in `static/index.html`.

The TypeScript interface connects to the real Atlas prompt or the resolution HTTP server over a serial connection to a Linux guest. The website uses the upstream resolution interface and the native C++ binaries compiled from the same Atlas revision as the manual. The guest’s only network interface is its own loopback. Calculations and terminal input stay in the tab.

A project-scoped service worker supplies the isolation headers needed for WebAssembly threads on GitHub Pages. The first visit to a tool reloads it once. Self-host with HTTPS or use localhost. A snapshot of the booted guest reduces startup time. A new session starts from the same clean state on each visit. The packaged emulator, kernel, and ROM files are pinned by content digest in `runtime/browser/fetch_emulator.py`.

## Automatic publication

The **Publish Atlas** workflow runs on pushes to this website, checks [Atlas main](https://github.com/pportilla/atlas) hourly, and supports manual runs. It compiles the full manual, packages the native runtime, and runs both tools in Chromium against a static server. GitHub Pages deploys after those checks pass. [version.json](https://pportilla.github.io/atlas-website/version.json) records both repository revisions.

Set the website repository’s Pages publishing source to **GitHub Actions**. While the mother repository is private, `ATLAS_DEPLOY_KEY` is a read-only deploy key for Atlas. The full manual, its linked source views, and the executable browser runtime are public.

## Build and run locally

Use sibling clones of this repository and Atlas. Install Python 3.10 or later, Node.js 22 with npm, Emscripten (the `em++` compiler), and Docker with Buildx for Linux x86-64 builds. From the website checkout, build the website first:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r ../atlas/requirements-docs.txt
python3 -m unittest discover -s tests
python3 scripts/build_site.py --atlas ../atlas --out dist
npm ci
npm run check
npm run build
```

Package the runtime from a clean export of that commit:

```sh
atlas_source=$(mktemp -d)
atlas_revision=$(git -C ../atlas rev-parse HEAD)
git -C ../atlas archive "$atlas_revision" | tar xf - -C "$atlas_source"
docker buildx build --platform linux/amd64 --build-context "atlas=$atlas_source" \
  --build-arg "ATLAS_REVISION=$atlas_revision" -f runtime/browser/Dockerfile \
  --output type=local,dest=dist/vm .
python3 runtime/browser/fetch_emulator.py dist/vm
npx playwright install chromium
node runtime/browser/snapshot.mjs dist/vm
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Open [the local site](http://127.0.0.1:8000/). For the browser checks, run `npx playwright install chromium` followed by `npm run test:browser`. The tests start their own static server and exercise a native calculation through each tool.
