#!/usr/bin/env bash
set -euo pipefail
image=${1:?Pass the image to test}
name="atlas-smoke-${RANDOM}-$$"
token=$(openssl rand -hex 32)
docker run -d --name "$name" -e "JUPYTER_TOKEN=$token" -p 127.0.0.1::8888 "$image" \
    jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --ServerApp.base_url=/user/qa/ >/dev/null
trap 'docker rm -f "$name" >/dev/null' EXIT
port=$(docker port "$name" 8888/tcp | cut -d: -f2)
base="http://127.0.0.1:$port/user/qa/"
for attempt in {1..60}; do
    if curl --silent --fail -H "Authorization: token $token" "${base}api/status" --output /dev/null; then break; fi
    sleep 1
done
JUPYTER_TOKEN="$token" python3 runtime/smoke.py "$base"
