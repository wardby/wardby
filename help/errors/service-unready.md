---
id: errors/service-unready
title: Service did not become ready
summary: A coding run failed at launch because one of its services never passed its readiness check (coding_service_unready:<name>), on Kubernetes, Docker or Substrate.
audience: operator
tags: [error, services, substrate, coding_service_unready, substrate_bridge_service_unready, WARDBY_SERVICE_SETUP_DONE]
appliesTo: >=0.2.1
---

# Service did not become ready

A run that failed with category `service_unready` (launcher error
`coding_service_unready:<name>`) started, but the named service never became
ready, so the coding agent never started. A service is not ready when its
readiness command keeps failing past its failure threshold, its image cannot
be pulled or started, or it is still not ready when the launcher's start-up
limit runs out.

1. On Kubernetes, inspect the run pod's init-container status and events for
   the `service-<name>` container: image pull errors, crash loops, or probe
   failures. On Docker the service's container is removed with the failed run,
   so reproduce it on the Docker host: pull the entry's image and run it with
   `--read-only`, `--user 10001:10001`, a `--tmpfs` at its `dataPath` and at
   each `writablePaths` entry, and its `serviceEnv`; then run its readiness
   command with `docker exec`.
2. For a custom catalog entry, confirm the image runs as a non-root user with a
   read-only root filesystem: every directory it writes to must be its
   `dataPath` or one of its `writablePaths`. Probe over TCP on `127.0.0.1`
   rather than a Unix socket.
3. Each entry's readiness settings (`periodSeconds`, `timeoutSeconds`,
   `failureThreshold`) apply within an overall start-up limit, whatever the
   entry's own threshold would otherwise allow. On Kubernetes that limit is
   the pod-start timeout (`KUBERNETES_READY_TIMEOUT_MS`, default 120000, an
   operator setting) and includes image pulls; if first pulls on new nodes
   are slow, raise it or mirror the image into a nearby registry. On Docker
   the limit is a fixed 120 seconds covering every service of the run
   together (they start one at a time), never runs past the run's own
   timeout, and has no setting to raise it; image pulls are not counted in it
   but may take up to 5 minutes each. The Docker launcher pulls without
   registry credentials, so pull a private or rate-limited image on the
   Docker host beforehand.
4. Trigger a new run once the cause is fixed.

## On Substrate

On the experimental Substrate launcher (from release 0.10.1) each service is a
container in the run's workspace actor. The run's recorded service status
(the viewer's run detail, or `services` in the viewer API) gives the reason,
and the workspace actor's log has `substrate_bridge_service_unready` with the
service's name and the same reason:

| Reason              | Usual cause and fix                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_failed`      | The service wrote no progress within 30 seconds of its start: usually the image has no `/bin/sh` (a distroless image cannot run there). Use an image with `/bin/sh` and `sleep`.                                                               |
| `exited`            | The `startCommand` is wrong, or the image's entrypoint needs root (`chown`, `gosu`). Substrate runs the image's default user with almost no capabilities: set a `substrateImage` whose default user is non-root and start the server directly. |
| `probe_failed`      | The readiness command kept failing past its threshold. For an entry with `substrateImage`, readiness also needs the file at `$WARDBY_SERVICE_SETUP_DONE`: make the `startCommand` create it once setup is done.                                |
| `timed_out`         | Not ready within the readiness settings and `SUBSTRATE_STARTUP_TIMEOUT_SEC`. A first run of a new combination of image and services also waits for image pulls and a golden snapshot; raise `SUBSTRATE_STARTUP_TIMEOUT_SEC` if that is slow.   |
| `image_unavailable` | The service image could not be pulled or started on the workers. Check the digest, and configure pull access on the worker nodes for a private registry (Wardby passes no pull credential).                                                    |

A service that exits later in the run is not restarted. See
[On the Substrate job launcher](../../docs/coding-services.md#on-the-substrate-job-launcher).

When this run is a sub-run another agent dispatched (for example a router
handing work to a coding agent), the parent sees a failed sub-run on its own
status comment, with a line naming the service: "A sub-run could not start:
The `<name>` service didn't become ready, so the run couldn't start."

See [Coding services](../coding-services.md).
