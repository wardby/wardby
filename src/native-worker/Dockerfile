# The native sandbox worker (docs/native-sandbox.md): runs one sandbox-mode native run's engine and
# user tools, reaching only the native gateway. No credentials, no database client, no shell use.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY help ./help
COPY src ./src
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS worker-dependencies
WORKDIR /worker
COPY src/native-worker/package.json src/native-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
LABEL org.opencontainers.image.source="https://github.com/wardby/wardby"
# perl-base: the pinned base image ships an older build; take Debian's security fixes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade perl-base \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin wardby
WORKDIR /opt/wardby
COPY --from=worker-dependencies /worker/node_modules ./node_modules
# Only the worker's runtime import graph (src/native-worker/worker-imports.test.ts keeps it free of
# database, provider-credential, and configuration modules), at the same relative paths as dist/.
COPY --from=build /build/dist/native-worker ./native-worker
COPY --from=build /build/dist/sandbox ./sandbox
COPY --from=build /build/dist/core/engine-native.js /build/dist/core/budget.js /build/dist/core/logger.js /build/dist/core/untrusted-content.js ./core/
COPY --from=build /build/dist/coding/protocol.js ./coding/protocol.js
COPY --from=build /build/dist/providers/engine/types.js ./providers/engine/types.js
COPY --from=build /build/dist/providers/llm/pricing-core.js /build/dist/providers/llm/types.js ./providers/llm/
# Fail the build, not every run, when a module the worker imports is missing. main.js runs on
# import, so this loads what it imports rather than main.js itself.
RUN node --input-type=module -e 'await Promise.all(["worker", "stdio", "http-transport", "protocol"].map((name) => import(`/opt/wardby/native-worker/${name}.js`)))' \
    && test -f /opt/wardby/sandbox/generated/zod.bundle.js
# No general-purpose network or build tooling for a tool escape to use.
RUN for executable in curl wget ssh sudo gcc make docker nc; do test ! -e "/usr/bin/$executable"; done
USER 10001:10001
ENTRYPOINT ["node", "/opt/wardby/native-worker/main.js"]
