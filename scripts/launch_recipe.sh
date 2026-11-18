#!/usr/bin/env bash
# Publish a small, immutable Git ref that Binder can build without reading Atlas.
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${RELEASE_TAG:?}" "${LAUNCH_TAG:?}"
asset=atlas-runtime.tar.gz
release=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$RELEASE_TAG")
digest=$(jq -er --arg name "$asset" '.assets[] | select(.name == $name) | .digest' <<<"$release")
url=$(jq -er --arg name "$asset" '.assets[] | select(.name == $name) | .browser_download_url' <<<"$release")
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$url" == "https://github.com/$GITHUB_REPOSITORY/releases/download/$RELEASE_TAG/$asset" ]]

recipe=$(mktemp -d)
trap 'rm -r -- "$recipe"' EXIT
cp runtime/Binder.Dockerfile "$recipe/Dockerfile"
cp runtime/{setup-runtime.sh,requirements.txt,jupyter_server_config.py} "$recipe/"
printf '%s %s\n' "${digest#sha256:}" "$url" > "$recipe/bundle.txt"
git -C "$recipe" init --quiet
git -C "$recipe" add .
git -C "$recipe" -c user.name=github-actions -c 'user.email=41898282+github-actions[bot]@users.noreply.github.com' commit --quiet -m "Launch $RELEASE_TAG"
remote="https://github.com/$GITHUB_REPOSITORY.git"
existing=$(git ls-remote "$remote" "refs/tags/$LAUNCH_TAG" | cut -f1)
if [[ -n "$existing" ]]; then
    git -C "$recipe" fetch --quiet "$remote" "refs/tags/$LAUNCH_TAG"
    # Detect inconsistent retries before sending visitors to an existing tag.
    git -C "$recipe" diff --quiet FETCH_HEAD HEAD
else
    gh auth setup-git
    git -C "$recipe" push "$remote" "HEAD:refs/tags/$LAUNCH_TAG"
fi
