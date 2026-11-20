FROM ghcr.io/wardby/wardby/wardby-coding-worker-driver@sha256:b1ca4f3db5957eb6b2f740dcb3b9c4493d63ed5638bc0b3507ba4b94a2f7c71b AS runtime
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/wardby/coding-worker/main.js"]
