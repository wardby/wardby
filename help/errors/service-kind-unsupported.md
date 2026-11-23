---
id: errors/service-kind-unsupported
title: This kind of service is not available to this run
summary: Wardby refused the coding run because the repository declares a docker service, and this deployment's job launcher cannot start that kind (it needs the Kubernetes job launcher with the gVisor runtime class).
audience: operator
tags: [error, coding-agents, services, docker, kind, gvisor, kubernetes, refusal, service_kind_unsupported]
appliesTo: ">=0.10.2"
---

# This kind of service is not available to this run

`service_kind_unsupported` means the repository's `.wardby/services.yaml`
names a catalog entry whose kind this deployment's job launcher does not
start. Today that is a `docker` entry (a rootless Docker daemon in the run):

"This repository asks for `<name>`, which this wardby deployment can't start:
Docker services need the Kubernetes job launcher with the gVisor runtime
class."

A `docker` service starts only with `JOB_LAUNCHER=kubernetes` and
`KUBERNETES_RUNTIME_CLASS=gvisor`. Every other configuration refuses it:

- the Docker job launcher (`JOB_LAUNCHER=docker`);
- the experimental Substrate job launcher (`JOB_LAUNCHER=substrate`);
- the Kubernetes job launcher without a runtime class, or with one other than
  `gvisor`.

The daemon's container needs `SETUID` and `SETGID` and keeps privilege
escalation possible for its user-namespace setup, so wardby only runs it where
gVisor keeps it from the node.

## What to do

1. Run the coding agent on a deployment that uses the Kubernetes job launcher
   with `KUBERNETES_RUNTIME_CLASS=gvisor`, or
2. remove the `docker` entry from the repository's `.wardby/services.yaml` on
   the base branch if its tests do not need Docker.

Sidecar services (such as `postgres` or `redis`) are not affected: they still
start on the Kubernetes, Docker and Substrate job launchers. A launcher that
cannot start services at all refuses with
[`service_launcher_unsupported`](service-launcher-unsupported.md) instead.

See [Give coding runs the services their tests need](../coding-services.md)
and [Coding services](../../docs/coding-services.md#docker-in-coding-runs-docker-kind).
