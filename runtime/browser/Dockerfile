# syntax=docker/dockerfile:1.7
ARG UBUNTU=ubuntu:26.10@sha256:c4ca31b6e93261c5dd773826f789738a49e414ca04fc094b1ccd0f91e07329a2
FROM ${UBUNTU} AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config python3-dev libflint-dev libgmp-dev \
    libmpfr-dev libjsoncpp-dev libnormaliz-dev
ARG BUILD_JOBS=2
COPY runtime/package-native.sh /usr/local/bin/package-native
RUN --mount=type=bind,from=atlas,target=/upstream package-native /upstream /opt/atlas

FROM ${UBUNTU} AS guest
RUN apt-get update && apt-get install -y --no-install-recommends \
    busybox-static python3 libflint24 libgmpxx4ldbl libjsoncpp26 libnormaliz3
COPY --from=build /opt/atlas /opt/atlas
ARG ATLAS_REVISION
RUN test "${#ATLAS_REVISION}" = 40 && printf '%s\n' "$ATLAS_REVISION" > /opt/atlas/REVISION
COPY runtime/guest/bridge.py runtime/browser/init runtime/browser/make_guest.py /tmp/build/
RUN mkdir /out && python3 /tmp/build/make_guest.py --init /tmp/build/init \
    --bridge /tmp/build/bridge.py --output /out/atlas.cpio.gz

FROM scratch
COPY --from=guest /out/ /
COPY --from=guest /opt/atlas/REVISION /REVISION
