#!/bin/sh
# Shared by the native image build and its Binder launcher.
set -eu
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git python3 \
    python3-venv ttyd libflint24 libgmpxx4ldbl libjsoncpp26 libnormaliz3
rm -rf /var/lib/apt/lists/*
python3 -m venv /opt/jupyter
/opt/jupyter/bin/pip install --no-cache-dir -r /tmp/atlas-image/requirements.txt
# Official Ubuntu images can contain an ubuntu account at UID 1000.
if id ubuntu >/dev/null 2>&1; then
    userdel -r ubuntu
fi
useradd --create-home --uid "$NB_UID" --shell /bin/bash "$NB_USER"
