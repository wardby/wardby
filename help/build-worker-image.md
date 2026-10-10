---
id: build-worker-image
title: Build a custom worker image for another language
summary: A procedure an MCP assistant follows to build a custom coding worker image for Go, Java, Rust or another language on Wardby's driver base image, check it, and point a Codex coding agent at it with workerImageRef.
audience: operator
tags: [worker-image, custom-image, workerImageRef, toolchain, other-language, go, golang, java, rust, ruby, codex]
appliesTo: ">=0.5.3"
---

# Build a custom worker image for another language

Wardby's own worker images have Node (`toolchain: node`) or Node and Python
3.12 (`toolchain: node-python`). For any other language, build your own image
on top of Wardby's driver base image and set the coding agent's
`codingProfile.workerImageRef` to it. The long-form guide is
[`docs/coding-worker-byo-images.md`](../docs/coding-worker-byo-images.md).

These steps build on the driver image (`codingProfile.provider: codex`). For a
`claude-code` agent, search help for a Claude Code image article for this
version; if there is none, tell the user and stop.

If you are an assistant connected to Wardby over MCP, follow these steps. Do
them in order, ask the user instead of guessing, and stop at the first failed
prerequisite. Never write into the user's repository; ask where to keep the
Dockerfile (for example a folder outside the repository).

## Step 1: find the toolchain

Read the manifests at the repository root to learn the language and version:
`go.mod` (Go; the `go` line), `pom.xml` or `build.gradle(.kts)` (Java; Maven or
Gradle), `Cargo.toml` and `rust-toolchain.toml` (Rust), `Gemfile` and
`.ruby-version` (Ruby), `composer.json` (PHP), `*.csproj` or `global.json`
(.NET). Also read how the project runs its tests (README, CI workflow, Makefile).
If there are several languages, or the version is unclear, ask the user which
toolchain and version to install.

## Step 2: get the base image digest

Run `npx @wardby/cli@latest doctor` in the Wardby project directory. It prints:

```text
Base image for your own worker images: ghcr.io/wardby/wardby/wardby-coding-worker-driver@sha256:<digest>
```

Run doctor with the same Wardby version that runs the agents (re-run
`quickstart` first if you upgraded), so the base image matches. Use exactly the
reference it prints: a worker built on an older driver rejects newer run input.
If doctor prints no such line, this Wardby version is too old: ask the user to
upgrade, and stop.

## Step 3: write the Dockerfile

Know the filesystem a run gets before you choose where things go:

- the root filesystem is **read-only**, so anything baked into the image
  (including a dependency cache) is read-only at run time;
- `/tmp` and `/home/wardby` are empty **`noexec`** scratch mounts of only 16 to
  64 MB; anything the image put there is hidden, and nothing there can be run;
- `/workspace` is the checkout, on a disk of `CODING_DISK_MB` (2048 MB by
  default; raise it per agent with `codingProfile.workspaceDiskMb`, up to the
  operator's `CODING_MAX_DISK_MB`). It is the only place where a run can write
  and execute files;
- a run has **no network** except Wardby's npm and PyPI proxy, so other
  dependencies must be in the image;
- files left in `/workspace` can become part of the run's result, except folders
  named `node_modules`, `.venv`, `__pycache__`, `.cache` and a few other caches
  (at any depth), plus the repository-relative paths in
  `codingProfile.collectExclude`.

So put every cache, build output and temporary directory the toolchain writes
under **`/workspace/.cache/`**, and bake dependencies into a read-only location
the toolchain reads from without writing. This Go image follows that recipe,
and runs `go test` under a run's restrictions:

```dockerfile
FROM <base image from step 2>
# The toolchain, from the official image pinned by digest.
COPY --from=golang:1.23-bookworm@sha256:<digest> /usr/local/go /usr/local/go
# Dependencies: download the repository's modules at build time into a
# read-only, file-based module proxy that runs read from.
COPY go.mod go.sum /tmp/deps/
RUN cd /tmp/deps \
    && GOMODCACHE=/opt/go-deps GOFLAGS=-modcacherw /usr/local/go/bin/go mod download \
    && rm -rf /tmp/deps /root/.cache
# Caches and temp files under /workspace/.cache; this wrapper creates them
# before every go command (go test runs its test binary from GOTMPDIR).
RUN printf '%s\n' '#!/bin/sh' \
      'for dir in "$GOCACHE" "$GOTMPDIR" "$GOMODCACHE"; do [ -n "$dir" ] && mkdir -p "$dir"; done' \
      'exec /usr/local/go/bin/go "$@"' > /usr/local/bin/go \
    && chmod 0755 /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt
ENV GOCACHE=/workspace/.cache/go-build \
    GOTMPDIR=/workspace/.cache/go-tmp \
    GOMODCACHE=/workspace/.cache/go-mod \
    GOPROXY=file:///opt/go-deps/cache/download \
    GOSUMDB=off \
    GOTOOLCHAIN=local \
    CGO_ENABLED=0
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
ENTRYPOINT ["node", "/opt/wardby/coding-worker/main.js"]
```

The `USER`, `ENV NODE_ENV=…`, `WORKDIR` and `ENTRYPOINT` lines are required as they are. For other toolchains, apply the
same recipe (adapt these, then prove them in step 4):

- **Rust:** `CARGO_TARGET_DIR=/workspace/.cache/cargo-target` and
  `CARGO_HOME=/workspace/.cache/cargo`; bake dependencies with `cargo vendor`
  into `/opt/cargo-vendor` and point a `/.cargo/config.toml` in the image at it
  (source replacement, `net.offline = true`). Rust needs a C linker, so drop
  the `gcc` check and tell the user why.
- **Java (Maven):** `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=/workspace/.cache/java-tmp`
  (the JVM unpacks native libraries there) and a wrapper that creates it; bake
  dependencies with `mvn dependency:go-offline` into `/opt/m2`, and run Maven
  offline by setting `MAVEN_ARGS` (Maven 3.9 or later) to `-o`,
  `-Dmaven.repo.local=/workspace/.cache/m2` and
  `-Dmaven.repo.local.tail=/opt/m2`. Add
  `target` to `codingProfile.collectExclude`.
- **Java (Gradle):** the same `java.io.tmpdir`,
  `GRADLE_USER_HOME=/workspace/.cache/gradle`, a dependency cache baked into
  `/opt/gradle-ro` and used read-only through `GRADLE_RO_DEP_CACHE`, `--offline`,
  and `build` and `.gradle` in `codingProfile.collectExclude`.

Other rules:

- **Install by pinned version or digest.** Never `latest`, and never pipe a
  download into a shell (use `COPY --from=<image>@sha256:...`, distribution
  packages, or `ADD --checksum=sha256:<sum> <url>`).
- **Keep every hardening check.** The image must not contain docker, ssh, curl,
  wget, sudo, gcc or make. If the toolchain really needs one of them (a C
  compiler for cgo or Rust, for example), drop only that check and tell the
  user why.
- **Provide the command names the project uses** (for example a `python`
  symlink when the README says `python`).
- **Ask before copying the repository's manifests** (`go.mod`, `pom.xml`, …)
  into the build context, and rebuild the image when its dependencies change.
- The base image is `linux/amd64`. On an Apple Silicon or other ARM machine,
  pass `--platform linux/amd64` to `docker build` and `docker run`.

## Step 4: build it and run the tests the way a run would

```sh
docker build --tag wardby-worker-<language>:local <dockerfile folder>
```

Then run the project's test command against a **throwaway clone**, never the
user's checkout, with a run's restrictions:

```sh
git clone <repository> /tmp/wardby-image-check
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --tmpfs /home/wardby:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700 --network none --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges -v /tmp/wardby-image-check:/workspace --entrypoint sh wardby-worker-<language>:local -c '<test command, e.g. go test ./...>'
```

On Linux, make the clone writable for user 10001 first (it is a throwaway copy:
`chmod -R a+rwX /tmp/wardby-image-check`). Fix the Dockerfile until the tests
run; a "permission denied" when running a built file means something still
writes executables to `/tmp` or `/home/wardby`. Delete the clone afterwards.

## Step 5: choose the image reference

`workerImageRef` must be immutable; a tag is refused.

- **Local quickstart** (the Docker launcher on this machine): use the local
  image ID, `docker image inspect --format '{{.Id}}' wardby-worker-<language>:local`
  (a `sha256:...` value).
- **Hosted Wardby**: push the image to a registry the workers can pull from,
  and use `<registry>/<name>@sha256:<digest>`.

## Step 6: update the builder and try it

1. Call `update_agent` with the coding agent's id and
   `codingProfile: {workerImageRef: "<reference from step 5>"}`. This needs the
   `agents:admin` scope and the admin role; the local operator of a quickstart
   install has both. On a hosted server, ask an administrator if it is refused.
2. Start a small run that exercises the toolchain:
   `trigger_agent {agentId, task: "Run the project's tests and report the results. Change nothing."}`.
3. Read the result with `get_run` and report to the user what ran, what passed
   and what failed. A command that is missing, or a dependency that could not
   be fetched, means going back to step 3. If the run reports the workspace is
   full, raise `codingProfile.workspaceDiskMb`.

To undo it, call `update_agent` with `codingProfile: {workerImageRef: null}`.

Related: [Use local git repositories](local-repositories.md),
[Approve packages for coding agents](coding-packages.md),
[Troubleshoot coding workers](troubleshooting/coding-workers.md) and
[Get started](getting-started.md).
