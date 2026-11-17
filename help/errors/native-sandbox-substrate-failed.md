---
id: errors/native-sandbox-substrate-failed
title: Native worker Substrate call failed
summary: With NATIVE_SANDBOX_LAUNCHER=substrate, a Substrate or Kubernetes Secret call that launches a sandbox run's actor failed; the error names the call and a fixed code.
audience: operator
tags: [error, native-agents, sandbox, substrate, native_sandbox_substrate_failed]
appliesTo: ">=0.10.1"
---

# Native worker Substrate call failed

`native_sandbox_substrate_failed: <call>: <code>` means that with `NATIVE_SANDBOX_LAUNCHER=substrate` (experimental), a call Wardby made to start the run's worker actor failed. Wardby deleted what the launch had made, and the run never started. The error carries only the call's name and a fixed code, never Substrate's or Kubernetes's own message.

**`<call>`** is the step that failed:

- `ensureActorTemplate`, `getActorTemplate`, `deleteActorTemplate`: creating or reading the worker's actor template (a template whose golden snapshot failed is deleted and created again).
- `createActor`, `putEgressPolicy`, `resumeActor`: creating the run's actor, its egress policy, and starting it.
- `createSecret`: the per-run Secret in `SUBSTRATE_CREDENTIALS_NAMESPACE` that holds the run's capability.
- `launch`: the launch itself. `input_invalid` means the run had no gateway session to launch with; `unexpected` means something else failed. Trigger the run again, and check the server's log.

The same calls, and `getActor`, `deleteActor`, `deleteEgressPolicy`, `deleteSecret` and `sessionActive`, also appear in the server's log lines for watching and removing workers (`substrate_call_failed`, and `removing a native sandbox worker failed; the next sweep will retry`). Those do not fail a run.

**`<code>`** is what Substrate answered:

- `substrate_unavailable`: the Substrate API could not be reached, or answered with an error other than the ones below. Check `SUBSTRATE_API_URL`, the token file (`SUBSTRATE_TOKEN_FILE`, audience `api.ate-system.svc`), `SUBSTRATE_CA_FILE` and `SUBSTRATE_SERVER_NAME`, and that the Substrate API server is running.
- `substrate_not_found`: the actor or template the call needed is gone, for example deleted with Substrate's own tooling while the run was starting. Trigger the run again.
- `substrate_already_exists`: an object of that name already exists and could not be replaced, for example a leftover actor whose delete failed. The clean-up sweep removes leftovers; trigger the run again.
- `substrate_template_missing`: the template was deleted while the run was starting. Trigger the run again; the next launch creates it again.
- `substrate_resource_exhausted`: no room on Substrate's workers. A refused start normally fails as [native_sandbox_capacity](native-sandbox-capacity.md) instead.
- `golden_snapshot_failed`: Substrate could not build the template's golden snapshot (as `getActorTemplate: golden_snapshot_failed`). Check that Substrate's workers can pull `NATIVE_SANDBOX_WORKER_IMAGE` and that it is the `wardby-native-worker` image of this release or later. The next launch rebuilds the template, and each run waits for that build, so fix the image rather than retrying.
- `unexpected`: any other failure. A `createSecret` failure is always `unexpected`: check that the server's Kubernetes identity (`SUBSTRATE_KUBE_CONTEXT`) can create and delete Secrets in `SUBSTRATE_CREDENTIALS_NAMESPACE`.

If every launch fails after a Substrate API-server outage, restart Substrate's egress gateway: it can stay unable to apply egress policies until restarted.

See [Run native agents in a sandbox](../native-sandbox.md), the
[native sandbox guide](../../docs/native-sandbox.md#set-up-with-agent-substrate-experimental)
and the [Substrate job launcher guide](../../docs/substrate-backend.md).
