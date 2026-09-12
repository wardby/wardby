FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS dependencies
WORKDIR /runner
COPY src/claude-tool-runner/package.json src/claude-tool-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin reevo
WORKDIR /opt/reevo/claude-tool-runner
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
ENV NODE_ENV=production HOME=/home/reevo
ENTRYPOINT ["node", "/opt/reevo/claude-tool-runner/main.mjs"]
