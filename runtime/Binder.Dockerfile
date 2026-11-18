# Install the already-built native runtime for the revision in bundle.txt.
FROM ubuntu:26.10@sha256:c4ca31b6e93261c5dd773826f789738a49e414ca04fc094b1ccd0f91e07329a2
ARG NB_USER=jovyan
ARG NB_UID=1000
ENV HOME=/home/${NB_USER} USER=${NB_USER} ATLAS_ROOT=/opt/atlas \
    PATH=/opt/jupyter/bin:/opt/atlas:${PATH}
COPY setup-runtime.sh requirements.txt /tmp/atlas-image/
RUN sh /tmp/atlas-image/setup-runtime.sh && rm -r /tmp/atlas-image
COPY jupyter_server_config.py /etc/jupyter/jupyter_server_config.py
COPY bundle.txt /tmp/atlas-bundle.txt
RUN read -r digest url < /tmp/atlas-bundle.txt \
    && curl --fail --location --retry 3 --proto '=https' "$url" -o /tmp/atlas.tar.gz \
    && printf '%s  %s\n' "$digest" /tmp/atlas.tar.gz | sha256sum --check --strict \
    && tar --no-same-owner -C /opt -xzf /tmp/atlas.tar.gz \
    && test -x /opt/atlas/atlas && test -s /opt/atlas/REVISION \
    && rm /tmp/atlas.tar.gz /tmp/atlas-bundle.txt
USER ${NB_USER}
WORKDIR ${HOME}
EXPOSE 8888
CMD ["jupyter", "lab", "--ip=0.0.0.0", "--port=8888", "--no-browser"]
