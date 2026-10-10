# Bring-Your-Own Coding-Worker Images

wardby ships worker images for `node` and `node-python` toolchains
(`src/coding-worker/Dockerfile`, `Dockerfile.node-python`). For any other
language toolchain (Ruby, PHP, .NET, ...), build your own image on top of
wardby's published **driver base image** and point your agent's
`workerImageRef` at it, instead of waiting for wardby to hand-author a new
`Dockerfile.<toolchain>`.

The driver image is for Codex agents. A Claude Code agent's image starts from a
different base; see [Codex and Claude Code](#codex-and-claude-code).

## The driver image

`ghcr.io/wardby/wardby/wardby-coding-worker-driver` contains wardby's
compiled Node.js coding-worker driver, `git`, `ca-certificates`, and the
`wardby` user (uid/gid 10001) — nothing language-specific. It's built from
`src/coding-worker/Dockerfile.driver` and published on `driver-vN` git tags;
each release's GitHub Release notes carry the resolved
`@sha256:...` digest to pin. `wardby doctor` prints the digest your installed
version's own workers are built on ("Base image for your own worker images:
…"); build on that one so your image matches the run input your Wardby sends.

An MCP assistant connected to Wardby can do the whole procedure for you: the
`build-worker-image` help article walks it through finding the toolchain,
writing and checking the Dockerfile, and setting `workerImageRef`.

The image deliberately stops before setting `USER`, `WORKDIR`, or
`ENTRYPOINT`, and before any of the hardened binary-absence checks wardby's
own images run. Those depend on what you install on top — some toolchains
(Ruby native gems, .NET native interop) legitimately need a compiler, so
there's no one-size-fits-all hardening rule. Your derived Dockerfile owns
that decision and must finish the job itself.

## Writing your Dockerfile

`src/coding-worker/Dockerfile.node-python` in this repo is the reference
example — it's a real, CI-built image built this same way. The shape is:

```dockerfile
FROM ghcr.io/wardby/wardby/wardby-coding-worker-driver@sha256:<pin the real digest from a driver-vN release>
RUN apt-get update \
    && apt-get install -y --no-install-recommends <your toolchain packages> \
    && rm -rf /var/lib/apt/lists/*
# Assert the binaries your sandbox must not contain are absent. Adjust the
# list to what your toolchain actually needs — e.g. a native-extension
# ecosystem may need to keep a compiler and drop this line for it.
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo
USER 10001:10001
ENV NODE_ENV=production HOME=/home/wardby
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/wardby/coding-worker/main.js"]
```

Provide the command names your ecosystem's tooling and docs actually use.
A worker only has what you install: Debian's `python3` package ships no
`python`, so a task that runs `python -m pytest` — as most Python projects'
own READMEs tell it to — reports a failed command even when the suite is
green. `Dockerfile.node-python` symlinks `python` to `python3` for exactly
that reason, and asserts both work.

### Design for the run's filesystem

A run's root filesystem is read-only; `/tmp` and `/home/wardby` are empty
`noexec` tmpfs mounts of 16 to 64 MB (anything the image put there is hidden);
`/workspace` (the checkout, `CODING_DISK_MB` large, or the agent's
`codingProfile.workspaceDiskMb`) is the only place a run can write and execute;
and a run reaches no package registry except Wardby's npm and PyPI proxy. So:

- point every cache, build output and temp directory under `/workspace/.cache/`
  (a `.cache` folder is never collected into the result, at any depth), and
  create those directories from a small wrapper around the toolchain command,
  keeping the `ENTRYPOINT` unchanged. For Go: `GOCACHE`, `GOTMPDIR` (`go test`
  runs its test binary from there) and `GOMODCACHE`;
- bake dependencies into a read-only location the toolchain only reads from
  (Go: a file-based module proxy filled by `go mod download`, used through
  `GOPROXY=file://...`); a baked cache cannot be written to during a run;
- add build folders that stay in the checkout (Maven `target`, Gradle `build`)
  to `codingProfile.collectExclude`.

Before using the image, run the project's tests against a throwaway clone with
a run's restrictions: `--read-only`, `--tmpfs /tmp:rw,noexec,nosuid,size=64m`,
`--tmpfs /home/wardby:rw,noexec,nosuid,size=64m,uid=10001,gid=10001`,
`--network none`, `--user 10001:10001`, `--cap-drop ALL` and
`--security-opt no-new-privileges`. The `build-worker-image` help article has a
complete Go Dockerfile that passes this check, recipes for Rust and Java, and
the exact command.

### Build and pin it

On a local quickstart install with the Docker launcher, `workerImageRef` can be
the local image ID (`docker image inspect --format '{{.Id}}' <your-tag>`).
Otherwise, build it, push it to your own registry, and note the resulting digest —
`docker inspect --format '{{index .RepoDigests 0}}' <your-tag>` after a push,
or read it straight from `docker buildx build --push`'s output.

## Pointing an agent at it

Set `CodingAgentProfile.workerImageRef` to your image's digest (a mutable
tag is rejected — see `isImmutableDockerImage` in
`src/providers/jobs/docker-isolation.ts`). Through the MCP API, that means
passing `workerImageRef` inside `codingProfile` on `create_agent` or
`update_agent`.

**This requires the `agents:admin` scope**, not just `agents:write` —
`workerImageRef` bypasses wardby's own curated toolchain matrix entirely, so
setting or changing it is gated the same way `make_owner` is: a caller with
only `agents:write` can still manage coding agents normally (including
picking `toolchain`/`toolchainVersion` from wardby's own images), but cannot
point one at an arbitrary image without the step-up scope. The scope alone
isn't enough: the caller must also hold the admin role (see
[roles and privileged operations](security-deployment.md#roles-and-privileged-operations)).

## Codex and Claude Code

A Codex agent runs in one container, and its commands run there too. A Claude
Code agent uses two containers: one runs Claude Code and holds its API key; the
other runs the agent's commands and has your repository. `workerImageRef` always
replaces the container that runs commands.

|                                | Codex agent                                  | Claude Code agent                                                                                               |
| ------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| What `workerImageRef` replaces | the agent's only container                   | the container that runs commands                                                                                |
| Build your image `FROM`        | the coding-worker driver image (`driver-vN`) | the `wardby-claude-tool-runner` image from the same wardby release (or `wardby-claude-tool-runner-node-python`) |
| Rebuild when                   | the driver image changes                     | you upgrade wardby                                                                                              |
| Claude Code itself runs on     | —                                            | wardby's standard image, never yours                                                                            |

The driver image sections above are for Codex. The subsections below are for
Claude Code. In them, "tool runner" means the container that runs a Claude Code
agent's commands.

### Build a custom image for a Claude Code agent

1. **Find your release's tool runner image.** It is the value of
   `CODING_CLAUDE_TOOL_RUNNER_IMAGE` on your server. To start from Node and
   Python, use `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` instead. A
   release value looks like
   `ghcr.io/wardby/wardby/wardby-claude-tool-runner@sha256:<digest>`. If the
   value is a local image ID (`sha256:...` only), give it a name first, because
   Docker cannot build `FROM` a bare ID:
   `docker tag sha256:<id> wardby-tool-runner-base:local`.
2. **Make a build folder.** Use a small folder of your own, outside your
   repository. Put in it the Dockerfile and only the files the Dockerfile
   copies.
3. **Write the Dockerfile.** Start from the image in step 1, install your tools
   as `root`, then switch back to the tool runner's user:

   ```dockerfile
   FROM ghcr.io/wardby/wardby/wardby-claude-tool-runner@sha256:<digest from step 1>
   USER root
   RUN apt-get update \
       && apt-get install -y --no-install-recommends <your packages> \
       && rm -rf /var/lib/apt/lists/*
   USER 10001:10001
   ```

   Keep these rules:
   - The last `USER` line is `USER 10001:10001`.
   - Do not set `ENTRYPOINT` or `CMD`. The tool runner starts with the base
     image's own entrypoint.
   - Install everything at build time. A run cannot install system packages.
   - Put tools in `/usr/local/bin` or `/usr/bin`. Do not put anything under
     `/tmp` or `/home/wardby`: a run hides both.
   - Put environment settings your commands need in a file under
     `/etc/profile.d/` (see "How the tool runner runs commands" below). `ENV`
     lines in the Dockerfile do not reach the agent's commands.

4. **Build it:** `docker build --tag <name> <build folder>`. Release images are
   `linux/amd64`; on an ARM machine, add `--platform linux/amd64`.
5. **Get an immutable reference.** A tag is refused.
   - **Docker launcher:** use the local image ID,
     `docker image inspect --format '{{.Id}}' <name>`. Build on the same Docker
     host that runs wardby's workers. Wardby never pulls these images.
   - **Kubernetes:** push the image to a registry your cluster can pull from,
     and use `<registry>/<name>@sha256:<digest>`.
6. **Point the agent at it.** Call `update_agent` with the agent's id. This
   needs the `agents:admin` scope and the admin role:

   ```json
   {
     "id": "<agent id>",
     "codingProfile": { "workerImageRef": "<reference from step 5>" }
   }
   ```

7. **Try it.** Trigger a small task that uses your tools, such as "Run the
   project's tests and report the results. Change nothing."

To undo it, set `codingProfile.workerImageRef` to `null`. The agent then uses
the standard tool runner for its `toolchain`.

### Languages other than Node and Python

A run can download packages only from wardby's package registry, which serves
npm and PyPI. Packages for any other language must be in the image. If a
package compiles native code, compile it in an earlier build stage and copy
only the results into the final image. The final image then needs no compiler.

The tool runner is based on Debian 12 (bookworm). Build stages that compile
code must use a bookworm-based image too, so the results work with the tool
runner's system libraries.

This example adds Ruby and a project's gems. It is a starting point to adapt,
not a tested recipe. Copy the project's `Gemfile` and `Gemfile.lock` into the
build folder first.

```dockerfile
# Stage 1: install Ruby and the project's gems, compiling any native code.
FROM ruby:3.3-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
ENV BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_DEPLOYMENT=true
WORKDIR /build
COPY Gemfile Gemfile.lock ./
RUN bundle install

# Stage 2: the tool runner from your wardby release, plus Ruby and the gems.
FROM ghcr.io/wardby/wardby/wardby-claude-tool-runner@sha256:<digest>
USER root
# Shared libraries Ruby needs at run time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libffi8 libgmp10 libssl3 libyaml-0-2 zlib1g \
    && rm -rf /var/lib/apt/lists/*
# Ruby lives in /usr/local, and the gems in /usr/local/bundle.
COPY --from=builder /usr/local /usr/local
# Settings for the agent's commands (Dockerfile ENV lines do not reach them).
RUN printf '%s\n' \
      'export GEM_HOME=/usr/local/bundle' \
      'export BUNDLE_PATH=/usr/local/bundle' \
      'export BUNDLE_APP_CONFIG=/usr/local/bundle' \
      'export BUNDLE_DEPLOYMENT=true' \
      > /etc/profile.d/ruby.sh \
    && sh -lc 'ruby --version && bundle --version'
USER 10001:10001
```

Pin the `ruby` image by digest for repeatable builds. Rebuild the image when
the project's `Gemfile.lock` changes.

### If a run fails

| What you see                                | What it usually means                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker_tool_runner_unreachable`            | The image was not built `FROM` the tool runner of the same wardby release, or the Dockerfile changed its `USER` or `ENTRYPOINT`.            |
| A command is "not found"                    | The tool is not in the image, or it is not on the `PATH` described below.                                                                   |
| A tool ignores a setting you set with `ENV` | Move the setting to a file under `/etc/profile.d/`.                                                                                         |
| "Permission denied" when running a file     | Something writes a program to `/tmp` or `/home/wardby` and runs it. Point that tool's temporary or cache folder under `/workspace/.cache/`. |

### How the tool runner runs commands

These details explain the rules above.

- **User and privileges.** Commands always run as user `10001`, with no Linux
  capabilities and `no-new-privileges`. `root` and setuid programs do not work
  at run time.
- **Filesystem.** The root filesystem is read-only. `/tmp` and `/home/wardby`
  are small, empty scratch space where files cannot be run; anything the image
  put there is hidden. `/workspace` holds the repository and is the only place
  where a run can write and run files.
- **Shell and environment.** Each command runs as `sh -lc "<command>"` with a
  fixed environment: `HOME=/home/wardby`, `LANG=C.UTF-8`, `TMPDIR` under
  `/workspace/.cache/`, wardby's package registry settings, and
  `PATH=/opt/wardby/bin:/usr/local/bin:/usr/bin:/bin`. The login shell reads
  `/etc/profile` and the files in `/etc/profile.d/`, so that is where your own
  settings go. `/etc/profile` resets `PATH` to Debian's default, so add any
  other folder to `PATH` in your `/etc/profile.d/` file.
- **Network.** The tool runner reaches only wardby's package registry (npm and
  PyPI).
- **Images on the Docker launcher are never pulled.** The image must already
  be on the Docker host. Kubernetes needs a registry digest
  (`repo@sha256:<64 hex>`).
- **Server settings.** Claude Code itself always runs on
  `CODING_CLAUDE_WORKER_IMAGE`. The server still needs both
  `CODING_CLAUDE_WORKER_IMAGE` and `CODING_CLAUDE_TOOL_RUNNER_IMAGE` set, even
  for agents with their own `workerImageRef`.
- **Toolchain.** While `workerImageRef` is set, `toolchain` and
  `toolchainVersion` do not choose the image, for either builder.

## Running services with a BYO image

An agent whose `codingProfile.services` allows a service ([coding
services](coding-services.md)) needs a worker image built on **driver v11 or
later**. The driver validates the run input it receives with a strict schema:
a worker built on an older driver base doesn't recognize the input's
`services` field and rejects the run outright, rather than silently starting
without them. Rebuild your image on a current `driver-vN` digest (see "The
driver image" above) before allowing any service on an agent that uses it.

## Repository skills need a current driver

On a Codex agent, a `workerImageRef` image never receives Claude Code's
repository context (`claudeContext`) or `claudeBareMode`. The one new input key
it can see is `repoSkills`, which wardby writes only when an agent sets
`repoSkills: false`. A worker built on
an older driver base validates its input with a strict schema, so it rejects
runs of agents with `repoSkills: false` (the run fails with
`worker_input_failed`), and it keeps offering Codex's built-in skills
(`imagegen`, `openai-docs`, `skill-creator`, `skill-installer`), which a
current driver always disables. Rebuild any `workerImageRef` image on a
current `driver-vN` digest (see "The driver image" above) before relying on
either behavior.

## What this doesn't cover

wardby does not re-validate the contents of your built image beyond the
digest-pinning check above. The mitigant is architectural, not a scan: the
guardrails that actually matter for a sandboxed run — protected paths, the
single-commit-per-run invariant, branch/PR scoping, hardened git config —
live in wardby's own orchestration code (`src/providers/vcs/git.ts`,
`src/providers/executor/container.ts`), not inside the worker image. A
compromised or careless BYO image changes the blast radius of the one job
running inside it; it can't reach past those checks, since the image only
ever talks git through that code path.
