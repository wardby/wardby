---
id: errors/native-sandbox-image-not-pinned
title: Native worker image not pinned
summary: NATIVE_SANDBOX_WORKER_IMAGE is a mutable tag, so Wardby refused to launch a sandbox worker.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_image_not_pinned]
appliesTo: ">=0.5.4"
---

# Native worker image not pinned

`native_sandbox_image_not_pinned` means `NATIVE_SANDBOX_WORKER_IMAGE` is not immutable. Wardby only launches a worker from a digest (`repo@sha256:...`) or a local image id, so the code it isolates cannot change underneath it.

1. Use the digest-pinned reference listed as `nativeWorker` in `dist/quickstart-images.json` for your version, or build locally with `npm run native-worker:image:local` and use the image id from `docker image inspect --format '{{.Id}}' wardby-native-worker:local`.
2. On Kubernetes (`NATIVE_SANDBOX_LAUNCHER=kubernetes`) a local image id is not accepted: the image must be a registry digest, `repo@sha256:...`, that the cluster can pull. Push your build to a registry and use its digest.
3. Set it as `NATIVE_SANDBOX_WORKER_IMAGE`, restart the server, and trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
