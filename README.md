# Atlas website

[Open the Atlas website](https://pportilla.github.io/atlas-website/) for the [full searchable manual](https://pportilla.github.io/atlas-website/docs/), [interactive terminal](https://pportilla.github.io/atlas-website/terminal/), and [resolution suite](https://pportilla.github.io/atlas-website/resolution/). The three site addresses stay the same across Atlas updates.

GitHub Pages serves the website and manual. Opening either live tool starts a personal Linux session on Binder. The terminal runs the Atlas executable in a real terminal. The resolution suite runs the original Atlas web app and search workers. Sessions are temporary and a cold start can take several minutes. Use **Download JSON** in the suite to keep a resolution record.

## Automatic publication

The **Publish Atlas** GitHub Actions workflow runs on website pushes, checks the main branch of [Atlas](https://github.com/pportilla/atlas) hourly, and can be started from the Actions tab. It builds the manual and native CPU runtime from the same Git commit. The site footer shows the Atlas revision, and [version.json](https://pportilla.github.io/atlas-website/version.json) records both repository revisions and the launch tag.

The workflow builds and tests the native runtime when Atlas or its runtime packaging changes. It publishes the executable bundle as a GitHub Release. A separate, immutable launch tag contains Binder's Dockerfile and the verified download's SHA-256 checksum. The website links directly to the two tools on that tag. Failed builds leave the last deployed website available.

GitHub Pages must use **GitHub Actions** as its publishing source. While the Atlas repository is private, the website's Actions secret `ATLAS_DEPLOY_KEY` supplies a read-only deploy key scoped to that repository. Public website output includes the full manual with linked implementation and test listings. The runtime archive contains the Python engine, web assets, and compiled native binaries. It contains no Git checkout. When Atlas becomes public, remove the deploy key from both repositories and delete the `ssh-key` setting in the workflow to switch to an anonymous source checkout.

The homepage uses the manual’s page template, typography, search index, theme controls, and ASCII artwork from the same Atlas revision. Edit the homepage article in `static/index.html`.

## Build the site locally

Keep the two repositories in sibling directories. From the website checkout, run:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r ../atlas/requirements-docs.txt
python3 -m unittest discover -s tests
python3 scripts/build_site.py --atlas ../atlas --out dist
python3 -m http.server --bind 127.0.0.1 --directory dist 8000
```

Open [the local website](http://127.0.0.1:8000/). The build uses the committed Atlas revision and writes generated pages into `dist/`. By default the tool links point to a local runtime on port 8888. Use `--terminal-url` and `--resolution-url` to target another runtime.

## Run the tools locally

With Docker and Buildx installed on an x86-64 Linux host, build from a clean export of the same Atlas commit:

```sh
atlas_source=$(mktemp -d)
atlas_revision=$(git -C ../atlas rev-parse HEAD)
git -C ../atlas archive "$atlas_revision" | tar xf - -C "$atlas_source"
docker buildx build --load -t atlas-runtime --build-context "atlas=$atlas_source" \
  --build-arg "ATLAS_REVISION=$atlas_revision" -f runtime/Dockerfile .
docker run --rm -p 127.0.0.1:8888:8888 atlas-runtime
```

Open the login URL printed by Jupyter, then choose [Atlas terminal](http://127.0.0.1:8888/atlas-terminal/) or [Resolution suite](http://127.0.0.1:8888/atlas-resolution/). The smoke test starts its own local container, resolves the cusp through the web API, and computes its Milnor number through the terminal WebSocket:

```sh
. .venv/bin/activate
pip install websocket-client
scripts/test_runtime.sh atlas-runtime
```
