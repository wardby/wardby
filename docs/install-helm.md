# Install with Helm

The `wardby` Helm chart installs the Kubernetes workloads of a Wardby
deployment: the control plane, the coding proxy, the native gateway, the schema
migration, and the namespace's network policies, RBAC, priority classes and
resource quota. Upgrades are a `helm upgrade`, and the schema migration runs
before the workloads roll.

The chart is published as an OCI artifact:

```sh
helm install wardby oci://ghcr.io/wardby/wardby --version <x.y.z> \
  --namespace wardby-coding --create-namespace -f my-values.yaml
```

Its source is `deploy/helm/wardby/`. Every value is listed, with its default,
in the chart's `README.md` and `values.yaml`.

## What the chart does not create

The chart runs on infrastructure you provide. Before installing, have:

- **A Kubernetes cluster** with a sandboxed `RuntimeClass` for run pods
  (`gvisor` by default, which GKE Sandbox provides), and a CNI that enforces
  `NetworkPolicy`. The defaults target GKE Autopilot; see
  [Getting started on GKE](getting-started-gke.md) for provisioning it with
  Terraform.
- **PostgreSQL**, with the database, roles and grants each workload needs. On
  Cloud SQL, the GKE guide's [Database login](getting-started-gke.md#database-login)
  section sets these up for IAM authentication.
- **Wardby images** in a registry the cluster can pull from: the runtime,
  migration, worker and tool-runner images, all from the same build. Set
  `image.registry`, and for the runtime and migration images a `tag` (which
  defaults to the chart's appVersion) or a `digest`, which wins when both are
  set. The images the control plane launches for coding runs and
  sandbox turns (`codingWorker`, `codingWorkerNodePython`, `codingWorkerNodePython313`,
  `codingWorkerNodePython314`, `claudeCodingWorker`, `claudeToolRunner`,
  `claudeToolRunnerNodePython`, `claudeToolRunnerNodePython313`,
  `claudeToolRunnerNodePython314`, `nativeWorker`) run only by
  digest, so each needs `image.<name>.digest`; the chart refuses to render
  without one. Set an optional worker's `repository` to `""` to leave it
  unconfigured.
- **Secrets** in the release namespace. By default each workload loads one
  Secret with `envFrom`:

  | Workload       | Secret (value)                                              | Holds                                                                                                                                                             |
  | -------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Control plane  | `wardby-control-plane-env` (`controlPlane.envFromSecret`)   | `SECRET_APP_KEY`, model provider keys, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` |
  | Coding proxy   | `wardby-coding-proxy-env` (`codingProxy.envFromSecret`)     | model provider keys, registry credentials                                                                                                                         |
  | Native gateway | `wardby-native-gateway-env` (`nativeGateway.envFromSecret`) | `SECRET_APP_KEY`, model provider keys, GitHub App ID and private key                                                                                              |

  `wardby-jira-env` and `wardby-slack-env` are loaded too when they exist. To
  load secrets another way (one Secret per key, for example), set
  `envFromSecret: ""` and list them under `extraEnv` as `secretKeyRef`
  entries. Never put a secret value in a values file.

- **For a public endpoint:** a Gateway API controller, a DNS record for your
  hostname, and a TLS certificate (or cert-manager to issue one).

## Minimal values

```yaml
hostname: wardby.example.com

image:
  registry: us-docker.pkg.dev/your-project/wardby
  runtime: { tag: 0.6.0 } # or { digest: "sha256:..." }
  migration: { tag: 0.6.0 }
  codingWorker: { digest: "sha256:..." }
  codingWorkerNodePython: { digest: "sha256:..." } # Python 3.12
  codingWorkerNodePython313: { digest: "sha256:..." }
  codingWorkerNodePython314: { digest: "sha256:..." }
  claudeCodingWorker: { digest: "sha256:..." }
  claudeToolRunner: { digest: "sha256:..." }
  claudeToolRunnerNodePython: { digest: "sha256:..." } # Python 3.12
  claudeToolRunnerNodePython313: { digest: "sha256:..." }
  claudeToolRunnerNodePython314: { digest: "sha256:..." }
  nativeWorker: { digest: "sha256:..." }

database:
  egress:
    cidrs: [10.0.0.5/32] # the database's private IP
  cloudSqlProxy:
    instanceConnectionName: your-project:us-central1:wardby
  urls:
    controlPlane: postgresql://wardby-app%40your-project.iam@127.0.0.1:5432/wardby
    codingProxy: postgresql://wardby-proxy%40your-project.iam@127.0.0.1:5432/wardby
    nativeGateway: postgresql://wardby-gateway%40your-project.iam@127.0.0.1:5432/wardby
    migration: postgresql://wardby-migrator%40your-project.iam@127.0.0.1:5432/wardby

serviceAccounts:
  controlPlane:
    annotations:
      iam.gke.io/gcp-service-account: wardby-app@your-project.iam.gserviceaccount.com
  # ... the same for codingProxy, nativeGateway and migration
```

`hostname` is required: it sets `MCP_CANONICAL_URI` and `AUTH_AUDIENCE` to
`https://<hostname>/mcp`, and the control plane refuses requests for any other
host.

## Database

With `database.cloudSqlProxy.enabled` (the default), every workload runs the
Cloud SQL Auth Proxy as a sidecar on `127.0.0.1:5432` and logs in as its own
Google identity, so the URLs carry no password. Set `database.egress.cidrs` to
the instance's private IP; the proxy connects on port 3307.

For another PostgreSQL, set `database.cloudSqlProxy.enabled: false`,
`database.egress.cidrs` to the database's address and `database.egress.port`
to its port (usually 5432). A URL that carries a password belongs in the
workload's Secret as `DATABASE_URL`, with `database.urls.<workload>` left empty.

## Models and budgets

Model provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) come from the
workload Secrets, or from one shared Secret named in `models.providerSecret`.
To use Google Gemini models, put `GEMINI_API_KEY` in a separate Secret named
`wardby-gemini-env` (loaded by `controlPlane.extraEnvFrom` and
`nativeGateway.extraEnvFrom`), not in `models.providerSecret`, which also
reaches the coding proxy. For Vertex AI, set `models.vertexProject` and give the
server's service account `roles/aiplatform.user`; see
[Google Gemini](models.md#google-gemini).
Agent budgets and the model catalog live in the database and are managed with
the MCP tools, not the chart; see [Models and pricing](models.md).

The chart sizes how much the cluster spends at once:

- `codingRuns.maxConcurrent` and `nativeSandbox.maxConcurrent` cap concurrent
  coding runs and sandbox turns.
- `codingRuns.cpus`, `memoryMb`, `diskMb` and `pids`, and the same
  `nativeSandbox` settings, size each run and sandbox pod. Their defaults are
  the server's own.
- `resourceQuota.hard` caps what run and sandbox pods may request. Size it for
  both: concurrency times per-pod resources.

## Metrics and pod annotations

The coding proxy and the control plane can each serve Prometheus metrics: the
proxy's traffic and cost, and the control plane's coding-run lifecycle (see
[Observability](observability.md)). Turn them on with
`codingProxy.metrics.enabled` and `controlPlane.metrics.enabled`. For each, the
chart binds the endpoint to the pod IP on `<workload>.metrics.port` (9464 by
default), adds a `metrics` port to the container and the workload's Service
(`wardby-coding-proxy`, `wardby-control-plane`), and opens that port to the
peers in `<workload>.metrics.ingressFrom`:

```yaml
codingProxy:
  metrics:
    enabled: true
    ingressFrom:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: monitoring
controlPlane:
  metrics:
    enabled: true
    ingressFrom:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: monitoring
```

With `ingressFrom` empty, the port stays closed to everyone: the namespace's
default-deny policy for the coding proxy, and the control plane's own policy,
which admits nothing else in the namespace.

`podAnnotations` adds annotations to every pod the chart creates, and each
workload's own `podAnnotations` (`controlPlane`, `codingProxy`,
`nativeGateway`, `migration`, `headroom`) adds to or overrides them, for
example a collector's scrape configuration on each workload that serves
metrics:

```yaml
codingProxy:
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9464"
controlPlane:
  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9464"
```

Changing pod annotations, or turning metrics on or off, restarts those pods.

## Publishing the endpoint

With `gateway.enabled`, the chart creates a Gateway with an HTTPS listener for
`hostname`, an HTTP listener that redirects to HTTPS, the routes, and a
NetworkPolicy admitting the load balancer to the control plane. The defaults
target GKE's `gke-l7-global-external-managed` class:

```yaml
gateway:
  enabled: true
  addresses:
    - type: NamedAddress
      value: wardby-control-plane # a reserved global address
  tlsSecretName: wardby-control-plane-tls
  certManager:
    enabled: true
    issuerRef: { name: letsencrypt, kind: ClusterIssuer }
  gke:
    securityPolicy: wardby-allowlist # optional Cloud Armor policy
```

`gateway.gke.enabled` adds the `HealthCheckPolicy` (the default check fails
against this server, which answers only its canonical host) and the
`GCPBackendPolicy` (a one-hour backend timeout for event streams). On another
platform, set `gateway.className`, `gateway.loadBalancerCidrs` to your load
balancer's source ranges, and `gateway.gke.enabled: false`.

Everyone who can reach the hostname can reach the OAuth registration and
discovery endpoints. Put an allowlist or rate limit in front of it.

Without `gateway.enabled`, the control plane stays cluster-internal; reach it
with `kubectl exec deploy/wardby-control-plane -- node dist/cli.js mcp`.

## Upgrades

```sh
helm upgrade wardby oci://ghcr.io/wardby/wardby --version <x.y.z> \
  --namespace wardby-coding -f my-values.yaml
```

The `wardby-migrate` Job runs as a pre-upgrade hook. If it fails, the upgrade
fails and the workloads keep running the previous build; read the Job's logs
before retrying. Change the image tags and digests in the same upgrade, all to
the same build.

The control plane rolls one pod at a time, waits three minutes before
counting a new pod available, and gives a stopping pod up to twelve minutes
to finish in-flight work.

## Availability

The chart runs one control-plane copy and one coding proxy, so a node drain or
failure stops MCP, webhooks and schedules until a replacement is ready. Set
`controlPlane.replicas: 2` with `controlPlane.topologySpreadConstraints` to
keep them up. The control plane and the native gateway get a
PodDisruptionBudget of one pod at a time (`<workload>.podDisruptionBudget`).
See [Availability](availability.md) for failure modes, recovery times and
probes.

## Adopt an existing deployment

A deployment applied from the Kustomize overlay can be taken over by the chart
without restarting anything, as long as the chart renders exactly what is
running. Helm only patches the fields the chart sets, so any difference in a
pod template, including the order of environment variables, restarts those
pods, and a control-plane restart ends the runs in flight.

1. Write values that reproduce the running objects: the same ServiceAccount
   names, images (by digest), database URLs, node selectors and env. Set each
   workload's `envOrder` to its current variable order, list secret references
   under `extraEnv`, and set to `null` any chart default the deployment does
   not use (for example `controlPlane.env.AUTH_MAX_CLIENTS: null`).
2. Render with `helm template` and compare every object with
   `kubectl get -o yaml`. Only Helm's own labels may differ.
3. Stop the old tooling from deleting the objects when it lets go of them (for
   example, disable pruning before removing them from its source).
4. Mark each object as belonging to the release:

   ```sh
   kubectl label <kind>/<name> app.kubernetes.io/managed-by=Helm
   kubectl annotate <kind>/<name> meta.helm.sh/release-name=wardby \
     meta.helm.sh/release-namespace=wardby-coding
   ```

   Do the same for the cluster-scoped PriorityClasses and ClusterRoles.

5. `helm install` with those values.

The migration hook runs on the install, which is harmless when no migration is
pending. The hook replaces the migrator ServiceAccount and the `wardby-migrate`
NetworkPolicy with its own copies, and the old migration Job is no longer
needed.

## Limits

- Install one release per cluster. Resource names are fixed because the
  control plane addresses the proxy, gateway and run pods by name, and the
  PriorityClasses and the launcher's ClusterRoles are cluster-wide.
- Low-power mode's scale-to-zero RBAC is not part of the chart yet.
