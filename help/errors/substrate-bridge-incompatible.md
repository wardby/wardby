---
id: errors/substrate-bridge-incompatible
title: A Substrate run's bridge is from another release (substrate_bridge_incompatible)
summary: A coding run on the experimental Substrate launcher failed because the Substrate bridge in its image speaks another protocol than the coding proxy; use bridge images and custom images built for the proxy's release.
audience: operator
tags: [error, substrate, substrate_bridge_incompatible, custom-image, bridge, upgrade, job launcher]
appliesTo: ">=0.9.15"
---

# A Substrate run's bridge is from another release

`substrate_bridge_incompatible` means the Substrate bridge in one of the run's
images speaks another protocol than the coding proxy. Every bridge request
names its protocol, and the proxy refuses one it does not serve (HTTP 426). The
run fails, and its actors are removed, before the startup timeout.

What to do:

1. **A custom image** (`codingProfile.workerImageRef`): rebuild it on this
   release's bridge. The bridge digest is the `substrateTool` (Claude Code) or
   `substrateCodex` (Codex) key in `dist/quickstart-images.json` of the release
   your coding proxy runs. See
   [Custom images](../../docs/substrate-backend.md#custom-images).
2. **The deployment's bridge images**: set `CODING_CLAUDE_WORKER_IMAGE`,
   `CODING_CLAUDE_TOOL_RUNNER_IMAGE`, `CODING_WORKER_IMAGE` and their
   per-toolchain variants to the bridge images of the same release as the
   proxy.
3. **Right after an upgrade**: a run that started on the older bridge images
   fails this way once the new proxy serves it. Run it again. Upgrade with no
   Substrate run in flight to avoid it.

See [Run coding agents on Substrate](../job-launcher-substrate.md) and the
[Substrate backend guide](../../docs/substrate-backend.md#requirements).
