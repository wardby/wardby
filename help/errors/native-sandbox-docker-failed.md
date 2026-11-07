---
id: errors/native-sandbox-docker-failed
title: Native worker Docker command failed
summary: A Docker command Wardby ran to start or clean up a sandbox worker failed.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_docker_failed]
appliesTo: ">=0.6.0"
---

# Native worker Docker command failed

`native_sandbox_docker_failed` means a Docker command needed to launch a worker (pull the image, create the run network, join the gateway to it, or start the container) failed. The message names the step and includes Docker's error output.

1. Confirm the server can reach the Docker daemon (`docker info` as the server's user).
2. For an image step, confirm the image exists on the host (a local id must already be present; a digest must be pullable without registry credentials, or pull it beforehand).
3. For a network step, confirm `NATIVE_GATEWAY_CONTAINER` names a running gateway container on this Docker host.
4. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
