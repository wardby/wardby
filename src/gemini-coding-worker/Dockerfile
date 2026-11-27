# The Gemini CLI coding worker (src/gemini-coding-worker): the Codex worker's shape (the agent and its
# shell commands share one container) running the pinned Gemini CLI. Built from source: the Codex
# images are layers on the published Codex driver image, which cannot hold this driver. Tooling and
# pins match the Codex driver and node-python images (image-policy.test.ts).
FROM --platform=$BUILDPLATFORM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json prisma.config.ts NOTICE ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY help ./help
COPY src ./src
RUN npm run build

# The CLI and the shared modules' third-party imports, from the lockfile (cli.test.ts pins both).
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS worker-dependencies
WORKDIR /worker
COPY src/gemini-coding-worker/package.json src/gemini-coding-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# wardby-cmd (src/command-agent), as in the Codex driver image: the launchers copy it into a toolchain container.
FROM rust:1.99-alpine@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383 AS command-agent
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY src/command-agent/Cargo.toml src/command-agent/Cargo.lock src/command-agent/rust-toolchain.toml ./
COPY src/command-agent/src ./src
RUN cargo build --release --locked && install -m 0555 target/release/wardby-cmd /wardby-cmd

# The docker CLI and compose plugin, as in the Codex driver image (docs/coding-services.md).
FROM docker:29.10.0-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS base
LABEL org.opencontainers.image.source="https://github.com/wardby/wardby"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && npm install --global --omit=dev npm@12.0.2 \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin wardby \
    && chmod 0755 /var/tmp /run/lock
# Debian's world-writable /var/tmp and /run/lock (/var/lock) closed: uid 10001 writes only HOME,
# /workspace and /tmp, also on a launcher without a read-only root (compatibility.docker.test.ts).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN docker --version && docker compose version
WORKDIR /opt/wardby
COPY --from=worker-dependencies /worker/node_modules ./node_modules
COPY --from=build /build/dist/gemini-coding-worker ./gemini-coding-worker
COPY --from=build /build/dist/coding-worker ./coding-worker
COPY --from=build /build/dist/coding/protocol.js ./coding/protocol.js
COPY --from=build /build/dist/coding/run-settings.js ./coding/run-settings.js
COPY --from=build /build/dist/coding/commit-subject.js ./coding/commit-subject.js
COPY --from=build /build/dist/coding/google-web-tools.js ./coding/google-web-tools.js
COPY --from=build /build/dist/coding/gemini-cli-env.js ./coding/gemini-cli-env.js
COPY --from=build /build/dist/coding/redact.js ./coding/redact.js
COPY --from=build /build/dist/core/secret-spans.js ./core/secret-spans.js
COPY --from=build /build/dist/coding/registry ./coding/registry
COPY --from=build /build/dist/coding/tunnel-env.js ./coding/tunnel-env.js
COPY --from=build /build/dist/coding/tunnel-token.js ./coding/tunnel-token.js
COPY --from=build /build/dist/coding/collect-exclude.js ./coding/collect-exclude.js
# The package-manager shims, wardby-packages and the uv shim: the Codex driver image's lines, verbatim.
COPY src/coding-worker/npm-shim.mjs ./bin/npm-shim.mjs
RUN chmod 0755 /opt/wardby/bin/npm-shim.mjs \
    && ln -s npm-shim.mjs /opt/wardby/bin/npm \
    && ln -s npm-shim.mjs /opt/wardby/bin/pnpm \
    && ln -s npm-shim.mjs /opt/wardby/bin/yarn \
    && printf '%s\n' 'case ":$PATH:" in *:/opt/wardby/bin:*) ;; *) PATH="/opt/wardby/bin:$PATH" ;; esac' > /etc/profile.d/wardby-shims.sh \
    && PATH="/opt/wardby/bin:$PATH" npm --version \
    && PATH="/opt/wardby/bin:$PATH" yarn --version \
    && test "$(bash -lc 'command -v npm')" = /opt/wardby/bin/npm \
    && test "$(bash -lc 'command -v yarn')" = /opt/wardby/bin/yarn
COPY src/coding-worker/dependency-cache.mjs ./coding-worker/dependency-cache.mjs
COPY src/coding-worker/result-bundle.mjs ./coding-worker/result-bundle.mjs
COPY src/coding-worker/plan-folder.mjs ./coding-worker/plan-folder.mjs
COPY src/coding-worker/registry-refusals.mjs ./coding-worker/registry-refusals.mjs
COPY src/coding-worker/wardby-packages.mjs ./coding-worker/wardby-packages.mjs
COPY src/coding-worker/pypi-plan.mjs ./coding-worker/pypi-plan.mjs
COPY src/coding-worker/uv-lock.mjs ./coding-worker/uv-lock.mjs
COPY src/coding-worker/uv-shim.mjs ./coding-worker/uv-shim.mjs
RUN chmod 0755 /opt/wardby/coding-worker/wardby-packages.mjs /opt/wardby/coding-worker/uv-shim.mjs \
    && ln -s ../coding-worker/wardby-packages.mjs /opt/wardby/bin/wardby-packages \
    && ln -s ../coding-worker/uv-shim.mjs /opt/wardby/bin/uv \
    && test "$(bash -lc 'command -v wardby-packages')" = /opt/wardby/bin/wardby-packages \
    && test "$(bash -lc 'command -v uv')" = /opt/wardby/bin/uv \
    && { /opt/wardby/bin/uv --version 2>&1 || true; } | grep -q "uv is not installed"
# The CLI's system settings and admin policies (Decision 6): root-owned and not writable by others, or
# the CLI skips them; the driver refuses to start unless their hashes match (system-check.ts).
COPY src/gemini-coding-worker/system-settings.json /etc/gemini-cli/settings.json
COPY src/gemini-coding-worker/policies/wardby.toml /etc/gemini-cli/policies/wardby.toml
RUN chown -R root:root /etc/gemini-cli \
    && chmod 0755 /etc/gemini-cli /etc/gemini-cli/policies \
    && chmod 0644 /etc/gemini-cli/settings.json /etc/gemini-cli/policies/wardby.toml
# Fail the build, not every run: every module the entry point imports loads, the baked settings pass
# the driver's own check, and the installed CLI is the pinned one.
# The two lists cover every module main.js reaches (image-policy.test.ts).
RUN node --input-type=module -e 'await Promise.all(["agent-state", "cli", "context-files", "driver", "environment", "failure", "leftovers", "output", "process", "settings", "stream", "system-check"].map((name) => import(`/opt/wardby/gemini-coding-worker/${name}.js`))); const m = await import("/opt/wardby/gemini-coding-worker/system-check.js"); await m.verifyGeminiSystemSettings();' \
    && node --input-type=module -e 'await Promise.all(["artifact", "credentials", "debug-trace", "errors", "mcp-config", "output-schema", "plan-output", "run-frame", "security-instructions", "task-note"].map((name) => import(`/opt/wardby/coding-worker/${name}.js`))); const m = await import("/opt/wardby/coding-worker/run-frame.js"); if (typeof m.prepareWorkerRun !== "function") process.exit(1)' \
    && node --input-type=module -e 'const m = await import("/opt/wardby/coding-worker/dependency-cache.mjs"); if (typeof m.prepareDependencies !== "function") process.exit(1)' \
    && node --input-type=module -e 'const m = await import("/opt/wardby/coding-worker/result-bundle.mjs"); if (typeof m.createResultBundle !== "function" || !(await m.gitAvailable())) process.exit(1)' \
    && node --input-type=module -e 'const m = await import("/opt/wardby/coding-worker/plan-folder.mjs"); if (typeof m.collectPlanFolder !== "function") process.exit(1)' \
    && /opt/wardby/bin/wardby-packages 2>&1 | grep -q "no package registry is configured" \
    && test "$(HOME=/tmp/gemini-version node /opt/wardby/node_modules/@google/gemini-cli/bundle/gemini.js --version)" = "0.70.0" \
    && rm -rf /tmp/gemini-version
COPY --from=command-agent /wardby-cmd /opt/wardby/bin/wardby-cmd
# The leftover-process sweep's marker (leftovers.ts): the driver is in this image's own pid namespace. A
# root-owned file under the root-owned /opt/wardby, not an ENV: the launchers attest the worker's exact
# WARDBY_* environment, so the image bakes no WARDBY_* variable.
RUN touch /opt/wardby/worker-pid-namespace \
    && chown root:root /opt/wardby /opt/wardby/worker-pid-namespace \
    && chmod 0755 /opt/wardby \
    && chmod 0644 /opt/wardby/worker-pid-namespace
RUN /opt/wardby/bin/wardby-cmd --version | grep -q "protocol 1"

# node-python (build with --target node-python): Python, pytest, ruff, uv and poetry, exactly as
# src/coding-worker/Dockerfile.node-python (the comments there explain each step).
FROM base AS node-python
ARG PYTHON_DEFAULT_VERSION=3.12
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        pytest==8.3.4 ruff==0.16.7 uv==0.13.4 poetry==2.5.1 \
    && apt-get purge -y --auto-remove python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && UV_NO_CACHE=1 UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install --no-bin 3.12 3.13 3.14 \
    && for python in /opt/uv-python/cpython-*/bin/python3; do \
        "$python" -m pip install --no-cache-dir --break-system-packages --upgrade pip==26.2.2; \
    done \
    && python_home="$(echo /opt/uv-python/cpython-${PYTHON_DEFAULT_VERSION}-linux-*)" \
    && test -x "$python_home/bin/python3" \
    && ln -s "$python_home/bin/python3" /usr/bin/python \
    && python -m pip install --no-cache-dir --break-system-packages pytest==8.3.4 ruff==0.16.7 \
    && printf '%s\n' \
        'export UV_PYTHON_INSTALL_DIR=/opt/uv-python' \
        'export UV_PYTHON_DOWNLOADS=never' \
        > /etc/profile.d/wardby-uv.sh
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make \
    && test ! -e /usr/bin/pip \
    && test ! -e /usr/bin/pip3 \
    && python --version \
    && python -c "import sys; assert '.'.join(map(str, sys.version_info[:2])) == '${PYTHON_DEFAULT_VERSION}'" \
    && printf 'def test_ok():\n    assert 1 + 1 == 2\n' > /tmp/test_ok.py \
    && python -m pytest -q -p no:cacheprovider /tmp/test_ok.py \
    && rm /tmp/test_ok.py \
    && test "$(bash -lc 'command -v uv')" = /opt/wardby/bin/uv \
    && bash -lc 'uv --version' | grep -q '^uv 0.13.4' \
    && python -m venv --system-site-packages /tmp/venv-check \
    && /tmp/venv-check/bin/python -m pip --version \
    && /tmp/venv-check/bin/python -m pytest --version \
    && rm -rf /tmp/venv-check \
    && poetry --version \
    && UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON_DOWNLOADS=never uv venv --python 3.12 /tmp/uv-check \
    && /tmp/uv-check/bin/python -c "import sys; assert sys.version_info[:2] == (3, 12)" \
    && rm -rf /tmp/uv-check \
    && for python in /opt/uv-python/cpython-*/bin/python3; do \
        "$python" -m pip --version | grep -q '^pip 26.2.2 ' || exit 1; \
    done
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON_DOWNLOADS=never
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/wardby/gemini-coding-worker/main.js"]

# The plain Node worker: the default target.
FROM base AS runtime
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
ENTRYPOINT ["node", "/opt/wardby/gemini-coding-worker/main.js"]
