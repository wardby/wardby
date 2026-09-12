FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build
WORKDIR /build
COPY package.json package-lock.json .
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json .
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
RUN npm run prisma:generate && npm run build

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS worker-dependencies
WORKDIR /worker
COPY src/claude-coding-worker/package.json src/claude-coding-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin reevo \
    && mkdir -p /opt/reevo/empty-workspace \
    && chown -R 10001:10001 /opt/reevo
WORKDIR /opt/reevo
COPY --from=worker-dependencies /worker/node_modules ./claude-coding-worker/node_modules
COPY --from=build /build/dist/claude-coding-worker ./claude-coding-worker
COPY --from=build /build/dist/coding-worker/artifact.js ./coding-worker/artifact.js
COPY --from=build /build/dist/coding-worker/errors.js ./coding-worker/errors.js
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
ENV NODE_ENV=production HOME=/home/reevo DISABLE_UPDATES=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
WORKDIR /opt/reevo/empty-workspace
ENTRYPOINT ["node", "/opt/reevo/claude-coding-worker/main.js"]
