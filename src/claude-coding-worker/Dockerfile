# Built on the builder's own platform: only plain JavaScript leaves this stage, so an arm64 machine
# compiles natively. The dependency and runtime stages stay on the target platform (the SDK ships
# platform-specific pieces).
FROM --platform=$BUILDPLATFORM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /build
COPY package.json package-lock.json .
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json prisma.config.ts .
COPY prisma ./prisma
COPY scripts ./scripts
COPY help ./help
COPY src ./src
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS worker-dependencies
WORKDIR /worker
COPY src/claude-coding-worker/package.json src/claude-coding-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
# perl-base: the pinned base image ships an older build; take Debian's security fixes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates perl-base \
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
COPY --from=build /build/dist/coding-worker/debug-trace.js ./coding-worker/debug-trace.js
COPY --from=build /build/dist/coding-worker/keeper.js ./coding-worker/keeper.js
COPY --from=build /build/dist/coding-worker/task-note.js ./coding-worker/task-note.js
COPY --from=build /build/dist/coding/protocol.js ./coding/protocol.js
# The shared secret redactor (debug-trace.js); it imports nothing.
COPY --from=build /build/dist/core/secret-spans.js ./core/secret-spans.js
COPY --from=build /build/dist/coding/registry/token.js ./coding/registry/token.js
# tool-socket.js derives its wait for the tool runner's dependency cache from the module's own
# timeouts (DEFAULT_TIMEOUTS); only its constants are read here, the tool runner runs it.
COPY src/coding-worker/dependency-cache.mjs ./coding-worker/dependency-cache.mjs
RUN node --input-type=module -e 'const m = await import("/opt/wardby/claude-coding-worker/tool-socket.js"); if (!(m.PREPARE_DEPENDENCIES_TIMEOUT_MS > 0)) process.exit(1)'
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
