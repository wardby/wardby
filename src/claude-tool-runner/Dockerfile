FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS dependencies
WORKDIR /runner
COPY src/claude-tool-runner/package.json src/claude-tool-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
RUN npm install --global --omit=dev npm@12.0.2 \
    && npm cache clean --force \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin wardby
WORKDIR /opt/wardby/claude-tool-runner
COPY --from=dependencies /runner/node_modules ./node_modules
COPY src/claude-tool-runner/main.mjs ./main.mjs
COPY src/claude-tool-runner/command.mjs ./command.mjs
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make \
    && test ! -e /usr/bin/git
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby
ENTRYPOINT ["node", "/opt/wardby/claude-tool-runner/main.mjs"]
