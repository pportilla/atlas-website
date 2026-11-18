# syntax=docker/dockerfile:1.7
ARG UBUNTU=ubuntu:26.10@sha256:c4ca31b6e93261c5dd773826f789738a49e414ca04fc094b1ccd0f91e07329a2
FROM ${UBUNTU} AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config python3-dev libflint-dev libgmp-dev \
    libmpfr-dev libjsoncpp-dev libnormaliz-dev \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_JOBS=2
COPY runtime/package-native.sh /usr/local/bin/package-native
RUN --mount=type=bind,from=atlas,target=/upstream \
    package-native /upstream /opt/atlas

FROM ${UBUNTU}
ARG NB_USER=jovyan
ARG NB_UID=1000
ENV HOME=/home/${NB_USER} USER=${NB_USER} ATLAS_ROOT=/opt/atlas \
    PATH=/opt/jupyter/bin:/opt/atlas:${PATH}
COPY runtime/setup-runtime.sh runtime/requirements.txt /tmp/atlas-image/
RUN sh /tmp/atlas-image/setup-runtime.sh && rm -r /tmp/atlas-image
COPY runtime/jupyter_server_config.py /etc/jupyter/jupyter_server_config.py
COPY --from=build /opt/atlas /opt/atlas
ARG ATLAS_REVISION
RUN test "${#ATLAS_REVISION}" = 40 \
    && printf '%s\n' "$ATLAS_REVISION" > /opt/atlas/REVISION
USER ${NB_USER}
WORKDIR ${HOME}
# Exercise the native kernel as the visitor, using only the runtime libraries.
RUN printf '%s\n' 'x,y = coordinates("x", "y")' 'print(milnor_number(y^2-x^3).value)' \
    | atlas run - > /tmp/cusp-result && grep -Fx 2 /tmp/cusp-result && rm /tmp/cusp-result
EXPOSE 8888
CMD ["jupyter", "lab", "--ip=0.0.0.0", "--port=8888", "--no-browser"]
