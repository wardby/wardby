---
id: install-helm
title: Install Wardby with Helm
summary: Install and upgrade the Wardby Kubernetes workloads with the Helm chart published at oci://ghcr.io/wardby/wardby.
audience: operator
tags: [deployment, helm, install, upgrade, kubernetes, gke, chart, oci, metrics, prometheus, podAnnotations]
appliesTo: ">=0.10.2"
---

# Install Wardby with Helm

The `wardby` Helm chart installs the control plane, coding proxy, native
gateway, schema migration, network policies, RBAC, priority classes and
resource quota into one namespace:

```sh
helm install wardby oci://ghcr.io/wardby/wardby --version <x.y.z> \
  --namespace wardby-coding --create-namespace -f my-values.yaml
```

Upgrade with `helm upgrade` and the same values. The schema migration runs as
a pre-install/pre-upgrade hook, so a failed migration fails the release and
leaves the previous build running.

The chart needs, and does not create: a cluster with a sandboxed
`RuntimeClass` and enforced `NetworkPolicy`, PostgreSQL with each workload's
login and grants, Wardby images in a registry the cluster can pull from, and
the workload Secrets (`wardby-control-plane-env`, `wardby-coding-proxy-env`,
`wardby-native-gateway-env`).

At minimum set `hostname` (the control plane serves only
`https://<hostname>/mcp`), `image.registry`, a `tag` or `digest` for the
runtime and migration images, a `digest` for each worker image the control
plane launches (they run only by digest), and
the database settings. Set `gateway.enabled: true` to publish the endpoint through a
Gateway API Gateway.

To scrape Prometheus metrics, set `codingProxy.metrics.enabled: true` (proxy
traffic and cost) and `controlPlane.metrics.enabled: true` (the coding-run
lifecycle), and list your collector under each one's `ingressFrom`; the ports
stay closed to everyone else. Add
annotations to the pods with `podAnnotations`, or per workload with
`<workload>.podAnnotations`. Either change restarts those pods.

Install one release per cluster: resource names are fixed, and the
PriorityClasses and launcher ClusterRoles are cluster-wide.

To take over a deployment applied from the Kustomize overlay without
restarting it, render values that match the running objects exactly (set each
workload's `envOrder` to its current variable order), compare with
`helm template`, then label and annotate the objects for the release before
`helm install`. See "Adopt an existing deployment" in the full guide.

Full guide, including values for Cloud SQL, other PostgreSQL, TLS and GKE
load-balancer policies:
[`docs/install-helm.md`](../docs/install-helm.md).

The chart runs one control-plane copy by default, which is not highly
available; set `controlPlane.replicas: 2` to ride out node drains. See
[Availability and PodDisruptionBudgets](availability.md).

Related: [Availability and PodDisruptionBudgets](availability.md),
[Deploy Wardby on GKE Autopilot](deploy-gke.md),
[Choose a deployment target](deployment-targets.md),
[Models and pricing](models.md).
