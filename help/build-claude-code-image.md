---
id: build-claude-code-image
title: Build a tool runner image for a Claude Code agent
summary: A procedure an MCP assistant follows to build a custom image for a Claude Code coding agent (Ruby, Go, Java or another language) FROM the release's tool runner image, check it, and set it with workerImageRef.
audience: operator
tags: [claude-code, custom-image, workerImageRef, tool-runner, worker-image, other-language, ruby, toolchain]
appliesTo: ">=0.5.4"
---

# Build a tool runner image for a Claude Code agent

A Claude Code agent uses two containers. One runs Claude Code and holds its API
key; it always uses Wardby's standard image. The other, the **tool runner**,
runs the agent's commands and has the repository. `codingProfile.workerImageRef`
replaces the tool runner. The long-form guide is
[`docs/coding-worker-byo-images.md`](../docs/coding-worker-byo-images.md).

For a Codex agent, follow [Build a custom worker image](build-worker-image.md)
instead.

If you are an assistant connected to Wardby over MCP, follow these steps. Do
them in order, ask the user instead of guessing, and stop at the first failed
prerequisite. Never write into the user's repository; ask where to keep the
Dockerfile (for example a folder outside the repository).

## Step 1: find the toolchain

Read the project's manifests and how it runs its tests, as in "Step 1: find the
toolchain" of [Build a custom worker image](build-worker-image.md). Ask the user
when the language or version is unclear.

## Step 2: find the base image

Ask the user for the value of `CODING_CLAUDE_TOOL_RUNNER_IMAGE` in the Wardby
server's settings (on a quickstart install, `.wardby/.env` in the Wardby project
directory). Use `CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` instead when
the project also needs Python. This image comes from the same Wardby release as
the server, which the custom image must match.

If the value is a bare local ID (`sha256:...`), tag it first, because Docker
cannot build `FROM` an ID:

```sh
docker tag sha256:<id> wardby-tool-runner-base:local
```

## Step 3: write the Dockerfile

Start from the base image, install as `root`, and end as the tool runner's user:

```dockerfile
FROM <base image from step 2>
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends <packages> \
    && rm -rf /var/lib/apt/lists/*
USER 10001:10001
```

Rules:

- **Keep the entrypoint.** Do not set `ENTRYPOINT` or `CMD`, and keep
  `USER 10001:10001` as the last `USER` line.
- **Install everything at build time.** A run can download only npm and PyPI
  packages, so every other package must be in the image.
- **Compile in an earlier stage.** The tool runner is Debian 12 (bookworm).
  Compile native code in an earlier build stage that uses a bookworm image,
  and copy only the results. The long-form guide has a Ruby example.
- **Settings go in `/etc/profile.d/`.** Commands run as `sh -lc` with a fixed
  environment, so `ENV` lines do not reach them. Put settings in a file under
  `/etc/profile.d/`, and put programs in `/usr/local/bin`.
- **Mind the run's filesystem.** The root filesystem is read-only. `/tmp` and
  `/home/wardby` are empty scratch space; anything the image put there is
  hidden. `/workspace` is the checkout and the only place a run can write. Put
  caches and temporary files under `/workspace/.cache/`.
- **No root at run time.** Commands always run as user 10001 with
  `no-new-privileges`, so setuid programs do not help.
- Release images are `linux/amd64`. On an ARM machine, pass
  `--platform linux/amd64` to `docker build` and `docker run`.

## Step 4: build it and run the tests the way a run would

```sh
docker build --tag wardby-tool-runner-<language>:local <dockerfile folder>
```

Then run the project's test command against a **throwaway clone**, never the
user's checkout. This command uses a run's restrictions and the same fixed
environment a run gives commands, so `ENV` lines in the image do not apply:

```sh
git clone <repository> /tmp/wardby-image-check
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m --tmpfs /home/wardby:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700 --network none --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges -v /tmp/wardby-image-check:/workspace -w /workspace --entrypoint env wardby-tool-runner-<language>:local -i HOME=/home/wardby LANG=C.UTF-8 PATH=/opt/wardby/bin:/usr/local/bin:/usr/bin:/bin sh -lc '<test command, e.g. bundle exec rake test>'
```

On Linux, make the clone writable for user 10001 first (it is a throwaway copy:
`chmod -R a+rwX /tmp/wardby-image-check`). Fix the Dockerfile until the tests
run. A "command not found" means a missing program or a missing
`/etc/profile.d/` setting. Delete the clone afterwards.

## Step 5: choose the image reference

`workerImageRef` must be immutable; a tag is refused.

- **Local quickstart** (Wardby runs coding jobs with Docker on this machine):
  use the local image ID,
  `docker image inspect --format '{{.Id}}' wardby-tool-runner-<language>:local`.
  Wardby never pulls these images, so build on the same machine.
- **Hosted Wardby**: push the image to a registry the cluster can pull from,
  and use `<registry>/<name>@sha256:<digest>`.

## Step 6: update the builder and try it

1. Call `update_agent` with the coding agent's id and
   `codingProfile: {workerImageRef: "<reference from step 5>"}`. This needs the
   `agents:admin` scope and the admin role. On a hosted server, ask an
   administrator if it is refused.
2. Start a small run that exercises the toolchain:
   `trigger_agent {agentId, task: "Run the project's tests and report the results. Change nothing."}`.
3. Read the result with `get_run` and report to the user what ran, what passed
   and what failed.

If a run fails with `worker_tool_runner_unreachable`, the image was usually not
built `FROM` this release's tool runner, or its `USER` or `ENTRYPOINT` was
changed. Rebuild the image whenever Wardby is upgraded.

To undo it, call `update_agent` with `codingProfile: {workerImageRef: null}`.

Related: [Build a custom worker image](build-worker-image.md),
[Approve packages for coding agents](coding-packages.md) and
[Troubleshoot coding workers](troubleshooting/coding-workers.md).
