---
id: errors/substrate-image-not-digest
title: A Substrate run's image is not a registry digest (substrate_image_not_digest)
summary: A coding run on the experimental Substrate launcher failed at launch because its worker or tool-runner image is not pinned as repo@sha256:<digest>.
audience: operator
tags: [error, substrate, substrate_image_not_digest, job launcher, coding-agents, image, digest]
appliesTo: ">=0.9.15"
---

# A Substrate run's image is not a registry digest

`substrate_image_not_digest` means the run's agent image or tool-runner image is
not a registry digest (`repo@sha256:<64 hex>`). Substrate pulls the images from
a registry, so each must be pinned that way. The run fails at launch, before
anything is created.

The control plane already refuses to start with `JOB_LAUNCHER=substrate` unless
`CODING_CLAUDE_WORKER_IMAGE` and the tool-runner images are digests, so this is
usually a run that kept an image it was given earlier: a run dispatched while
the deployment used local image ids (on the Docker launcher), or an agent's
custom image (`workerImageRef`) set as a local image id. Run it again on the
current configuration. An agent's custom image (`workerImageRef`) must be
pushed to a registry and set as `repo@sha256:<digest>`; a local image ID
(`sha256:…`, which the Docker launcher accepts) is refused here.

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md).
