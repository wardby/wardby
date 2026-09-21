FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /build
COPY package.json package-lock.json .
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json .
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
RUN npm run prisma:generate && npm run build

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS worker-dependencies
WORKDIR /worker
COPY src/claude-coding-worker/package.json src/claude-coding-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && npm install --global --omit=dev npm@12.0.2 \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin wardby \
    && mkdir -p /opt/wardby/empty-workspace \
    && chown -R 10001:10001 /opt/wardby
WORKDIR /opt/wardby
# Shared protocol modules resolve dependencies from /opt/wardby, while the
# worker's SDK modules resolve upward through that same reviewed runtime tree.
COPY --from=worker-dependencies /worker/node_modules ./node_modules
COPY --from=build /build/dist/claude-coding-worker ./claude-coding-worker
COPY --from=build /build/dist/coding-worker/artifact.js ./coding-worker/artifact.js
COPY --from=build /build/dist/coding-worker/errors.js ./coding-worker/errors.js
COPY --from=build /build/dist/coding-worker/keeper.js ./coding-worker/keeper.js
COPY --from=build /build/dist/coding/protocol.js ./coding/protocol.js
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make \
    && test ! -e /usr/bin/git
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby DISABLE_UPDATES=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
WORKDIR /opt/wardby/empty-workspace
ENTRYPOINT ["node", "/opt/wardby/claude-coding-worker/main.js"]
