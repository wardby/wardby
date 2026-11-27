# Built on the builder's own platform: only plain JavaScript leaves this stage, so an arm64 machine
# compiles natively. The dependency and runtime stages stay on the target platform (the SDK ships
# platform-specific pieces).
FROM --platform=$BUILDPLATFORM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /build
COPY package.json package-lock.json .
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json prisma.config.ts NOTICE ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY help ./help
COPY src ./src
RUN npm run build

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS worker-dependencies
WORKDIR /worker
COPY src/claude-coding-worker/package.json src/claude-coding-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# wardby-cmd (src/command-agent): the toolchain command agent, one static musl binary. Built for
# the target platform: it is native code. Toolchain runs copy it into the team's image.
FROM rust:1.99-alpine@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383 AS command-agent
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY src/command-agent/Cargo.toml src/command-agent/Cargo.lock src/command-agent/rust-toolchain.toml ./
COPY src/command-agent/src ./src
RUN cargo build --release --locked && install -m 0555 target/release/wardby-cmd /wardby-cmd

# The docker CLI and compose plugin (the same digest-pinned release as the tool runner and driver
# images): storage-init copies them into a toolchain run that also has a `docker` coding service, so
# the team's image needs no Docker CLI. Not on this image's PATH: the agent never runs commands.
FROM docker:29.10.0-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS runtime
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
# The wardby_mcp server settings shared with the Codex worker (remote MCP servers); imports nothing.
COPY --from=build /build/dist/coding-worker/mcp-config.js ./coding-worker/mcp-config.js
# The shared security-instructions builder (imports mcp-config.js only).
COPY --from=build /build/dist/coding-worker/security-instructions.js ./coding-worker/security-instructions.js
COPY --from=build /build/dist/coding-worker/plan-output.js ./coding-worker/plan-output.js
COPY --from=build /build/dist/coding/protocol.js ./coding/protocol.js
# The per-run settings main.js reads from its environment (WARDBY_SUB_AGENTS); imports nothing.
COPY --from=build /build/dist/coding/run-settings.js ./coding/run-settings.js
# The driver imports the conventional-commit subject builder, which imports protocol.js.
COPY --from=build /build/dist/coding/commit-subject.js ./coding/commit-subject.js
# Session-resume transcript capture (claude-coding-worker/transcript.js); neither imports anything.
COPY --from=build /build/dist/coding/transcript/claude-code.js ./coding/transcript/claude-code.js
COPY --from=build /build/dist/coding/transcript/format.js ./coding/transcript/format.js
# The shared secret redactor (debug-trace.js -> coding/redact.js), which imports
# core/secret-spans.js and coding/protocol.js.
COPY --from=build /build/dist/coding/redact.js ./coding/redact.js
COPY --from=build /build/dist/core/secret-spans.js ./core/secret-spans.js
COPY --from=build /build/dist/coding/registry/token.js ./coding/registry/token.js
# debug-trace.js redacts the tunnel token too (coding/tunnel-token.js imports only node:crypto).
COPY --from=build /build/dist/coding/tunnel-token.js ./coding/tunnel-token.js
# tool-socket.js derives its wait for the tool runner's dependency cache from the module's own
# timeouts (DEFAULT_TIMEOUTS); only its constants are read here, the tool runner runs it.
COPY src/coding-worker/dependency-cache.mjs ./coding-worker/dependency-cache.mjs
RUN node --input-type=module -e 'const m = await import("/opt/wardby/claude-coding-worker/tool-socket.js"); if (!(m.PREPARE_DEPENDENCIES_TIMEOUT_MS > 0)) process.exit(1)'
# Fail the build, not every run, when a module the worker imports is missing (a missing COPY
# otherwise exits every run at startup with ERR_MODULE_NOT_FOUND). main.js runs on import, so this
# loads everything it imports rather than main.js itself.
RUN node --input-type=module -e 'await Promise.all(["claude-coding-worker/driver", "claude-coding-worker/sdk", "claude-coding-worker/transcript", "claude-coding-worker/plan-files", "coding-worker/debug-trace", "coding-worker/artifact", "coding-worker/errors", "coding-worker/mcp-config", "coding-worker/plan-output", "coding/run-settings"].map((name) => import(`/opt/wardby/${name}.js`)))'
# wardby-cmd (the command-agent stage above): the launchers copy it into a toolchain container.
COPY --from=command-agent /wardby-cmd /opt/wardby/bin/wardby-cmd
RUN /opt/wardby/bin/wardby-cmd --version | grep -q "protocol 1"
# The docker CLI (the docker-cli stage above): copied into a toolchain container beside wardby-cmd.
COPY --from=docker-cli /usr/local/bin/docker /opt/wardby/docker/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /opt/wardby/docker/cli-plugins/docker-compose
RUN /opt/wardby/docker/docker --version \
    && DOCKER_CONFIG=/opt/wardby/docker /opt/wardby/docker/docker compose version \
    && ! command -v docker
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
