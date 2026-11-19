# The workspace's compiled TypeScript (src/coding), for the node-python target's lockfile session below.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json prisma.config.ts NOTICE ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY help ./help
COPY src ./src
RUN npm run build

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS dependencies
WORKDIR /runner
COPY src/claude-tool-runner/package.json src/claude-tool-runner/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The tool runner every Claude Code run uses; the two targets below add only their toolchain.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS base
# perl-base: the pinned base image ships an older build; take Debian's security fixes.
# git: a run with git history (#536) commits with it, and the worker's result bundle uses it
# (result-bundle.mjs, below). Without recommends, so no ssh client comes with it. The Claude agent
# container itself stays git-free (claude-coding-worker/Dockerfile).
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade perl-base \
    && apt-get install -y --no-install-recommends git \
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
# The result bundle (src/coding-worker/result-bundle.mjs, the same file the Codex driver ships): the
# git check and result bundle tools of a run with git history. main.mjs imports it as
# ../coding-worker/result-bundle.mjs.
COPY src/coding-worker/result-bundle.mjs /opt/wardby/coding-worker/result-bundle.mjs
RUN node --input-type=module -e 'const m = await import("/opt/wardby/coding-worker/result-bundle.mjs"); if (typeof m.createResultBundle !== "function" || !(await m.gitAvailable())) process.exit(1)'
# The plan folder (src/coding-worker/plan-folder.mjs, the same file the Codex driver ships).
COPY src/coding-worker/plan-folder.mjs /opt/wardby/coding-worker/plan-folder.mjs
RUN node --input-type=module -e 'const m = await import("/opt/wardby/coding-worker/plan-folder.mjs"); if (typeof m.placePlanFiles !== "function" || typeof m.collectPlanFolder !== "function" || typeof m.isSafePlanPath !== "function") process.exit(1)'
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
    && git --version
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby
ENTRYPOINT ["node", "/opt/wardby/claude-tool-runner/main.mjs"]

# node-python (build with --target node-python): the same tool runner plus Python, pytest and ruff,
# matching the Codex node-python worker image (src/coding-worker/Dockerfile.node-python) package for
# package. python3-venv stays: in registry mode the agent installs packages with
# `python -m venv --system-site-packages .venv && .venv/bin/python -m pip install ...`, and pip there
# reaches only the proxy's registry through the PIP_* settings in WARDBY_TOOL_SETUP. The system pip is
# removed (Debian refuses `pip install` outside a venv, and the root filesystem is read-only anyway).
#
# uv and poetry run a Python project's own checks. uv also picks the interpreter: a run cannot
# download one (it reaches only the registry proxy), so uv's managed CPython builds are installed
# here, at build time, into /opt/uv-python, and uv is told to look there and never download. Commands
# run under `sh -l`, where Dockerfile ENV does not apply, so profile.d carries those two settings.
# uv reaches the proxy through the UV_* settings in WARDBY_TOOL_SETUP (src/coding/registry/pypi.ts);
# poetry has no such setting, so it installs only from a project's own configuration.
FROM base AS node-python
USER root
# The managed CPython (3.12, 3.13 or 3.14) that `python` runs: the node-python image registered for a
# toolchainVersion is built with that version (CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_<version>).
ARG PYTHON_DEFAULT_VERSION=3.12
# The uv.lock / poetry.lock session (src/coding/registry/pypi-lockfiles/session.ts): before the first
# command it points a project's lockfiles at the registry proxy, and the worker has it put the original
# URLs back once the agent has finished. main.mjs imports it as ../coding/registry/pypi-lockfiles/session.js;
# every import it has is a Node built-in or in these files. Only this target has uv and poetry.
COPY --from=build /build/dist/coding/registry/pypi-lockfiles /opt/wardby/coding/registry/pypi-lockfiles
COPY --from=build /build/dist/coding/registry/pypi-name.js /opt/wardby/coding/registry/pypi-name.js
COPY --from=build /build/dist/coding/registry/pypi-requirements.js /opt/wardby/coding/registry/pypi-requirements.js
COPY --from=build /build/dist/coding/registry/workspace-files.js /opt/wardby/coding/registry/workspace-files.js
COPY --from=build /build/dist/coding/collect-exclude.js /opt/wardby/coding/collect-exclude.js
RUN printf '{"type":"module"}\n' > /opt/wardby/coding/package.json \
    && node --input-type=module -e 'const m = await import("/opt/wardby/coding/registry/pypi-lockfiles/session.js"); if (typeof m.prepareWorkspacePypiLockfiles !== "function" || typeof m.restoreWorkspacePypiLockfiles !== "function") process.exit(1)'
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        pytest==8.3.4 ruff==0.16.7 uv==0.13.4 poetry==2.5.1 \
    && apt-get purge -y --auto-remove python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && UV_NO_CACHE=1 UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install --no-bin 3.12 3.13 3.14 \
    # Each managed CPython ships its own pip, and pip vendors certifi: the pip these builds carry
    # (26.2.1) bundles a certifi with compromised root CAs (GHSA-6q48-6c7w-9gw2), fixed in 26.2.2.
    && for python in /opt/uv-python/cpython-*/bin/python3; do \
        "$python" -m pip install --no-cache-dir --break-system-packages --upgrade pip==26.2.2; \
    done \
    # Most Python projects (and their own docs) say `python`, not `python3`.
    # It is the managed CPython this image is built for (PYTHON_DEFAULT_VERSION), so the agent's
    # toolchainVersion is the interpreter it gets; the system python3 stays Debian's. pytest and ruff
    # go into that interpreter too, so `python -m pytest` and a --system-site-packages venv find them.
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
    && git --version \
    && test ! -e /usr/bin/pip \
    && test ! -e /usr/bin/pip3 \
    && python --version \
    && python -c "import sys; assert '.'.join(map(str, sys.version_info[:2])) == '${PYTHON_DEFAULT_VERSION}'" \
    && python -m pytest --version \
    # pytest must run a real test on this interpreter, not only print its version.
    && printf 'def test_ok():\n    assert 1 + 1 == 2\n' > /tmp/test_ok.py \
    && python -m pytest -q -p no:cacheprovider /tmp/test_ok.py \
    && rm /tmp/test_ok.py \
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
    && test "$(sh -lc 'command -v python')" = /usr/bin/python \
    && uv --version \
    && poetry --version \
    # uv must pick each baked interpreter offline, from a login shell (as a run's commands are).
    && sh -lc 'uv venv --python 3.12 /tmp/uv-check && /tmp/uv-check/bin/python -c "import sys; assert sys.version_info[:2] == (3, 12)"' \
    && sh -lc 'uv venv --python 3.13 /tmp/uv-check13 && /tmp/uv-check13/bin/python --version' \
    && sh -lc 'uv venv --python 3.14 /tmp/uv-check14 && /tmp/uv-check14/bin/python --version' \
    && rm -rf /tmp/uv-check /tmp/uv-check13 /tmp/uv-check14
USER 10001:10001
# The tool runner process runs the lockfile session's `poetry lock`, and it is not a login shell, so it does not
# read /etc/profile.d/wardby-uv.sh. Without these, Poetry sees only the system Python 3.11 and cannot lock a
# project that needs a newer one. A run's commands still get them from profile.d (same values).
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PYTHON_DOWNLOADS=never

# The plain Node tool runner: the default target, so `docker build` without --target builds it.
FROM base AS runtime
