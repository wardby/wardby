FROM ghcr.io/chfields/reevo-run/reevo-coding-worker-driver@sha256:2ee47cc9220e2d5209ce00a0911fffaec789d1d6c6968b2540f819557ed8fb23 AS runtime
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make
USER 10001:10001
ENV NODE_ENV=production HOME=/home/reevo
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/reevo/coding-worker/main.js"]
