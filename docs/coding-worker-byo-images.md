# Bring-Your-Own Coding-Worker Images

wardby ships worker images for `node` and `node-python` toolchains
(`src/coding-worker/Dockerfile`, `Dockerfile.node-python`). For any other
language toolchain (Ruby, PHP, .NET, ...), build your own image on top of
wardby's published **driver base image** and point your agent's
`workerImageRef` at it, instead of waiting for wardby to hand-author a new
`Dockerfile.<toolchain>`.

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

## Codex only

Custom toolchains through `workerImageRef` are for Codex agents. A Claude Code
agent's commands run in the Claude tool runner, which `workerImageRef` does not
change, so Claude Code agents cannot use a custom toolchain yet. They can use
wardby's curated `node-python` toolchain (set the matching
`CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` image).

If `workerImageRef` is set on a Claude Code agent anyway, it replaces that
agent's Claude Code worker image (the image that runs the agent, in place of
`CODING_CLAUDE_WORKER_IMAGE`), not the tool runner. Point it only at a Claude
Code worker image from the same wardby release as your control plane.

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

If a Claude Code agent's `workerImageRef` is set (see "Codex only" above), that
image replaces the Claude Code worker and receives `claudeContext` and
`claudeBareMode` too. It must be the Claude Code worker image from this
release; an older one rejects those runs with `worker_input_failed`.

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
