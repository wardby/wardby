---
id: errors/substrate-image-incomplete
title: A Substrate run's image lacks something the bridge runs (substrate_image_incomplete)
summary: A coding run on the experimental Substrate launcher failed because its image lacks the runner, GNU tar, or a /workspace or /run/wardby directory user 10001 can write; the code names the missing item.
audience: operator
tags: [error, substrate, substrate_image_incomplete, tar, workspace, run_dir, runner, job launcher]
appliesTo: ">=0.9.15"
---

# A Substrate run's image lacks something the bridge runs

`substrate_image_incomplete:<item>` means the Substrate bridge checked the
image it runs in before starting the run and found something missing. It
reports the first missing item, in this order, and the run fails with its
actors removed:

| Item        | What is missing                                                                                                                                   | Fix                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `runner`    | The tool runner (`/opt/wardby/claude-tool-runner/main.mjs`, Claude Code) or the Codex worker (`/opt/wardby/coding-worker/main.js`) is not a file. | Build `FROM` the release's tool-runner image (Claude Code) or the driver image (Codex), and keep those files.                   |
| `tar`       | GNU tar: `tar --version` does not say "GNU tar".                                                                                                  | Keep the base image's GNU tar; do not replace it with BusyBox or bsdtar.                                                        |
| `workspace` | `/workspace` that user 10001 can write.                                                                                                           | `RUN mkdir -p /workspace && chown -R 10001:10001 /workspace` as root.                                                           |
| `run_dir`   | A `/run/wardby` directory (`tool` for Claude Code, `input` and `output` for Codex) that user 10001 can write.                                     | Run the bridge layer's `mkdir -p /run/wardby/...` and `chown -R 10001:10001 /run/wardby` lines (see the examples linked below). |

The bridge does not check `/tmp`. An image whose only fault is an unwritable
`/tmp` fails with [substrate_startup_timeout](substrate-startup-timeout.md)
instead.

The item is the bridge's own report, and the bridge in a custom image is part
of that image. Any process in the actor that holds the workspace (the tool
actor, or a Codex run's one actor) can send it, so a run's own commands could
fail their run this way. Only one of the four fixed items is accepted and
recorded; nothing else from the image reaches the run's result or the logs.

See [Custom images](../../docs/substrate-backend.md#custom-images),
[build-claude-code-image](../build-claude-code-image.md),
[build-worker-image](../build-worker-image.md) and
[Run coding agents on Substrate](../job-launcher-substrate.md).
