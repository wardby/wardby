---
id: coding-toolchain
title: Run a coding agent's commands in your own dev image (toolchain)
summary: Register your team's dev or CI image as a toolchain catalog entry, declare it in .wardby/services.yaml, and a Claude Code agent on the Kubernetes or Docker launcher runs every command in that image, unchanged, sharing the run's workspace.
audience: operator
tags: [toolchain, dev image, custom environment, workerImageRef, setupCommand, kubernetes, docker, docker service]
appliesTo: ">=0.10.2"
---

# Run a coding agent's commands in your own dev image (toolchain)

When a repository's tests need your team's own image (a C extension with no
Linux wheel, system libraries, a specific interpreter, the settings the image
sets), register that image as a **toolchain**. A run that declares it starts
your image, unchanged, next to the run, sharing `/workspace`, and every command
the agent runs goes there. You don't rebuild the image on top of Wardby's tool
runner, as a `workerImageRef` requires.

Toolchains work for **Claude Code agents on the Kubernetes and Docker job
launchers**. On the Substrate launcher, and for Codex agents, the run is refused with
[`service_launcher_unsupported`](errors/service-launcher-unsupported.md). Don't
confuse it with `codingProfile.toolchain` (`node`/`node-python`), which picks
Wardby's standard image.

1. **Check the image.** It needs `/bin/sh`, files readable by any user (it runs
   as uid 10001 with a read-only root filesystem), every directory it writes in
   `writablePaths` (for example `/tmp`), and no credentials baked into `ENV` or
   files. Try it:
   `docker run --rm --read-only --user 10001:10001 --cap-drop ALL --tmpfs /tmp -e HOME=/tmp <image> sh -c '<a test>'`.
2. **Register it** with `create_service`, `kind: "toolchain"`, pinned by digest,
   with `serviceEnv`, `resources`, `writablePaths` and an optional
   `setupCommand` (runs once before the agent's first command; write its output
   to `HOME` or `/tmp`, never `/workspace`). Your image's own entrypoint does
   not run. If your code hard-codes service host names (compose names such as
   `elastic`), list them in `hostAliases`: each resolves to `127.0.0.1`, where
   the run's services listen.
3. **Declare it** in `.wardby/services.yaml`:

   ```yaml
   toolchain:
     python-dev: "3.13"
   ```

4. **Allow it** on the agent: add its name to `codingProfile.services`.
5. **Run a probe task**: print the interpreter version, import a package only
   your image has, and run one test.

Commands get your image's `ENV` and `PATH`, then `serviceEnv`, then Wardby's
settings, including `HOME=/home/wardby` and `USER`/`LOGNAME=wardby`. Packages already
in the image did not pass the package proxy's checks; packages a run installs
still do.

A toolchain run can also declare a `docker` service (Kubernetes with gVisor):
Wardby then mounts the daemon's socket in the toolchain and supplies the
`docker` CLI and compose plugin, added at the end of `PATH` with `DOCKER_HOST`
and `DOCKER_CONFIG` set, so your image needs no Docker CLI. See
[Docker in coding runs](coding-services.md#docker-in-coding-runs-docker-kind).

If the agent sees `wardby-cmd: toolchain_setup_failed`,
`wardby-cmd: toolchain_unusable:shell` or `wardby-cmd: toolchain_unusable:agent`
as a command's output, `setupCommand` failed, the image has no `/bin/sh`, or
the agent isn't using this release's Claude Code images.

The full rules, environment order and errors are in
[`docs/coding-services.md`](../docs/coding-services.md#running-the-agents-commands-in-your-own-image-toolchain).
See also [Give coding runs the services their tests need](coding-services.md).
