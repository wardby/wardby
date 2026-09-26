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
`@sha256:...` digest to pin.

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

Build it, push it to your own registry, and note the resulting digest —
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
