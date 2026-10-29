FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS dependencies
WORKDIR /runner
COPY src/claude-tool-runner/package.json src/claude-tool-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The tool runner every Claude Code run uses; the two targets below add only their toolchain.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS base
# perl-base: the pinned base image ships an older build; take Debian's security fixes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade perl-base \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev npm@12.0.2 \
    && npm cache clean --force \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin wardby
WORKDIR /opt/wardby/claude-tool-runner
COPY --from=dependencies /runner/node_modules ./node_modules
COPY src/claude-tool-runner/main.mjs ./main.mjs
COPY src/claude-tool-runner/command.mjs ./command.mjs
# The package-manager shim (src/coding-worker/npm-shim.mjs), linked as npm, pnpm and yarn: verifies
# a project's lockfile with the registry proxy before an install, then runs the real tool (pnpm, and
# a pinned yarn 2+, through corepack). Commands run under `sh -l`, whose /etc/profile resets PATH,
# so profile.d puts the shim back in front.
COPY src/coding-worker/npm-shim.mjs /opt/wardby/bin/npm-shim.mjs
RUN chmod 0755 /opt/wardby/bin/npm-shim.mjs \
    && ln -s npm-shim.mjs /opt/wardby/bin/npm \
    && ln -s npm-shim.mjs /opt/wardby/bin/pnpm \
    && ln -s npm-shim.mjs /opt/wardby/bin/yarn \
    && printf '%s\n' 'case ":$PATH:" in *:/opt/wardby/bin:*) ;; *) PATH="/opt/wardby/bin:$PATH" ;; esac' > /etc/profile.d/wardby-shims.sh \
    && PATH="/opt/wardby/bin:$PATH" npm --version \
    && test "$(sh -lc 'command -v npm')" = /opt/wardby/bin/npm
# The dependency cache (src/coding-worker/dependency-cache.mjs): on a dependency-cache run the worker
# asks this tool runner, before the agent starts, to restore the run's npm dependencies with the same
# npm and environment its commands use. main.mjs imports it as ../coding-worker/dependency-cache.mjs.
COPY src/coding-worker/dependency-cache.mjs /opt/wardby/coding-worker/dependency-cache.mjs
RUN node --input-type=module -e 'const m = await import("/opt/wardby/coding-worker/dependency-cache.mjs"); if (typeof m.prepareDependencies !== "function" || typeof m.sealUploadWindow !== "function") process.exit(1)'
# `wardby-packages` (src/coding-worker/wardby-packages.mjs): lists the package registry's refusals for
# the run, which pip and uv don't print. command.mjs imports registry-refusals.mjs as
# ../coding-worker/registry-refusals.mjs to add them to a failed command's output.
COPY src/coding-worker/registry-refusals.mjs /opt/wardby/coding-worker/registry-refusals.mjs
COPY src/coding-worker/wardby-packages.mjs /opt/wardby/coding-worker/wardby-packages.mjs
# `wardby-packages plan` and the uv shim (src/coding-worker/uv-shim.mjs + uv-lock.mjs), linked as uv:
# verify a Python lockfile with the registry proxy (pypi-plan.mjs) before an install, and point a
# uv.lock's PyPI URLs at the proxy for the command. The real uv is in the node-python image.
COPY src/coding-worker/pypi-plan.mjs /opt/wardby/coding-worker/pypi-plan.mjs
COPY src/coding-worker/uv-lock.mjs /opt/wardby/coding-worker/uv-lock.mjs
COPY src/coding-worker/uv-shim.mjs /opt/wardby/coding-worker/uv-shim.mjs
RUN chmod 0755 /opt/wardby/coding-worker/wardby-packages.mjs /opt/wardby/coding-worker/uv-shim.mjs \
    && ln -s ../coding-worker/wardby-packages.mjs /opt/wardby/bin/wardby-packages \
    && ln -s ../coding-worker/uv-shim.mjs /opt/wardby/bin/uv \
    && test "$(sh -lc 'command -v wardby-packages')" = /opt/wardby/bin/wardby-packages \
    && test "$(sh -lc 'command -v uv')" = /opt/wardby/bin/uv \
    && /opt/wardby/bin/wardby-packages 2>&1 | grep -q "no package registry is configured"
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

# node-python (build with --target node-python): the same tool runner plus Python, pytest and ruff,
# matching the Codex node-python worker image (src/coding-worker/Dockerfile.node-python) package for
# package. python3-venv stays: in registry mode the agent installs packages with
# `python -m venv --system-site-packages .venv && .venv/bin/python -m pip install ...`, and pip there
# reaches only the proxy's registry through the PIP_* settings in WARDBY_TOOL_SETUP. The system pip is
# removed (Debian refuses `pip install` outside a venv, and the root filesystem is read-only anyway).
FROM base AS node-python
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && python3 -m pip install --no-cache-dir --break-system-packages pytest==8.3.4 ruff==0.16.7 uv==0.13.4 \
    && apt-get purge -y --auto-remove python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    # Most Python projects (and their own docs) say `python`, not `python3`.
    && ln -s /usr/bin/python3 /usr/bin/python
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make \
    && test ! -e /usr/bin/git \
    && test ! -e /usr/bin/pip \
    && test ! -e /usr/bin/pip3 \
    && python --version \
    && python -m pytest --version \
    && uv --version \
    # The uv shim (/opt/wardby/bin/uv) runs this real uv.
    && test "$(sh -lc 'command -v uv')" = /opt/wardby/bin/uv \
    && sh -lc 'uv --version' | grep -q '^uv 0.13.4' \
    && python -m ruff --version \
    # A registry-mode venv must be creatable offline, carry pip, and still see pytest/ruff.
    && python -m venv --system-site-packages /tmp/venv-check \
    && /tmp/venv-check/bin/python -m pip --version \
    && /tmp/venv-check/bin/python -m pytest --version \
    && rm -rf /tmp/venv-check \
    && test "$(sh -lc 'command -v python')" = /usr/bin/python
USER 10001:10001

# The plain Node tool runner: the default target, so `docker build` without --target builds it.
FROM base AS runtime
