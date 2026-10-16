# deploy/gke — managed Postgres for a GKE-hosted control plane

For the complete path from an empty Google Cloud project through DNS, TLS,
deployment, verification, and teardown, follow the
[GKE getting-started guide](../../docs/getting-started-gke.md). This file covers
the Terraform module's implementation details.

Terraform for a Cloud SQL Postgres instance with **no public IP**, reachable
from a GKE cluster over a VPC peering. It is the durable store behind the
control plane deployed by
`deploy/kind-coding/manifests/overlays/gke-autopilot/`, replacing the throwaway
`emptyDir` Postgres that overlay ships for smoke tests.

It also describes the **cluster** those runs execute in and the **Artifact
Registry** holding their images. The cluster resources were written against a
live cluster and imported, so `terraform plan` against an untouched cluster is
empty — the module reproduces what runs, rather than approximating it.

What is still not in Terraform: the Kubernetes objects inside the cluster (the
control plane Deployment, NetworkPolicies, Gateway). Those are kustomize
manifests under `deploy/kind-coding/manifests/overlays/gke-autopilot/`, applied
separately.

## Why not deploy/gcp

`deploy/gcp` is the deprecated Cloud Run reference and should not be used for a
new installation. It uses a public-IP Cloud SQL instance reached through the
Cloud SQL connector. The supported GKE architecture instead uses a private
address that both the control plane and coding proxy reach directly from the
cluster VPC.

## The constraint to check first

Pass the VPC **your cluster already runs on**. A cluster's network is fixed at
creation, and VPC peering is not transitive, so an instance peered into a
different VPC is unreachable from the cluster — and nothing reports this until a
query times out at run time.

```bash
gcloud container clusters describe <cluster> --region <region> \
  --format='value(network)'
```

If that prints `default`, peering lands in your project's auto-created network.
That is shared space in most projects: the reserved range and the peering are
visible to everything else there. Reversible, but not invisible.

## Apply

```bash
cd deploy/gke
cp terraform.tfvars.example terraform.tfvars   # then edit it
terraform init
terraform apply
```

Terraform creates the instance, the database, and a Cloud SQL IAM database
user per workload (control plane, migrator, coding proxy, native gateway) (`database-iam.tf`) — no password, and nothing resembling a
connection string to hand to the cluster. Migrations run as a separate
`wardby-migrate` Job before the Deployments roll (`up.sh`), not as an
initContainer on either one. See "Database login" below for what runs next.

## Native sandbox

The overlay also deploys the native gateway (`wardby-native-gateway`, two
replicas) so agents set to `nativeExecutionMode=sandbox` run in single-use gVisor
pods; see [Native sandbox](../../docs/native-sandbox.md). The gateway has its
own Workload Identity and database login (table above), its own Cloud SQL Auth
Proxy sidecar, egress to the database on 3307 and the metadata server, DNS
egress to NodeLocal DNSCache (`169.254.20.10`), and the control-plane priority
class. Its `wardby-native-gateway-env` Secret comes from External Secrets and
reuses existing Secret Manager entries (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`SECRET_APP_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`; no new ones), with
Jira settings from `wardby-jira-env` when configured. `DATABASE_URL` is a plain
environment variable built by `up.sh`, never part of the Secret.

The namespace ResourceQuota (26 pods, 11 CPU, 20Gi memory) includes the
gateway's replicas and `NATIVE_SANDBOX_MAX_CONCURRENT` worker pods at 500m and
512Mi each; raise it together with `CODING_MAX_CONCURRENT` or
`NATIVE_SANDBOX_MAX_CONCURRENT`.

To keep idle workers ready, set `NATIVE_SANDBOX_WARM_POOL_SIZE` in the control
plane manifest. Idle workers are extra pods, so raise the ResourceQuota to cover
`NATIVE_SANDBOX_MAX_CONCURRENT` plus `NATIVE_SANDBOX_WARM_POOL_SIZE` worker
pods; each idle worker is billed for its 500m / 512Mi requests. See the
[warm pool](../../docs/native-sandbox.md#warm-pool).

## Low-power mode

`WARDBY_LOW_POWER=1 deploy/gke/up.sh` scales the coding proxy and native
gateway to zero when idle and runs fewer always-on pods; see
[Low-power mode](../../docs/getting-started-gke.md#low-power-mode).

## Run dependency cache

Off by default. The coding-run dependency cache (see
[Dependency cache](../../docs/coding-packages.md#dependency-cache)) keeps npm
`node_modules` snapshots in a private Cloud Storage bucket that only the coding
proxy can use. In `terraform.tfvars` set:

```
dependency_cache_enabled      = true
dependency_cache_bucket_name  = "your-unique-dependency-cache-bucket"
dependency_cache_max_age_days = 14
```

Bucket names are global, so pick one unique to you. Terraform creates the
bucket (uniform access, public access prevention enforced, no versioning) and
grants `roles/storage.objectAdmin` on that bucket to the coding proxy's Google
service account only (the control plane, migrator, gateway and worker pods get
none). The bucket deletes objects older than `dependency_cache_max_age_days + 7`
days as a backstop for objects the proxy never recorded; keep
`dependency_cache_max_age_days` equal to the proxy's
`WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS` (default 14) by hand.

Then deploy with `WARDBY_DEPENDENCY_CACHE=true deploy/gke/up.sh`. That adds
`BLOB_STORE=gcs`, `BLOB_STORE_GCS_BUCKET` (the `dependency_cache_bucket`
output) and `WARDBY_DEPENDENCY_CACHE=true` to the coding proxy only. The
bucket is created from the Terraform variables alone, so a later deploy
without the environment variable switches the cache off without touching the
bucket. `up.sh` stops if the variable is `true` but no bucket exists. The tuning
variables (`WARDBY_DEPENDENCY_CACHE_MAX_SNAPSHOT_MB` and the others in
[Dependency cache limits](../../docs/coding-packages.md#dependency-cache-limits))
are not passed through `up.sh`; set them on the proxy Deployment if you need
them. The proxy also needs `wardby_proxy` access to the `DependencySnapshot`
table, which `up.sh` grants before the rollout (see
[Upgrading an existing deployment](../../docs/getting-started-gke.md#upgrading-an-existing-deployment)).

## Coding workspace disk

A coding run's workspace is 2048 MiB unless the agent sets `workspaceDiskMb`,
and by default an agent can't ask for more than that. To let agents ask for
more (for example, for a large dependency install), deploy with
`CODING_MAX_DISK_MB`:

```bash
CODING_MAX_DISK_MB=8192 deploy/gke/up.sh
```

`up.sh` adds it to the control plane only, which launches the coding runs. It
must be an integer between 2048 and 32768. On Autopilot the control plane also
refuses at startup a value that doesn't leave room for the worker's 1 GiB
inside the 10 GiB pod ephemeral-storage ceiling (see
[Coding worker isolation](../../docs/coding-worker-isolation.md)). Leaving it
unset keeps the 2048 MiB limit. A run whose agent asks for more than the limit
fails with `coding_workspace_disk_exceeds_limit`.

## Coding pod memory and CPU

Every coding run's pod gets 2048 MiB of memory and 1 CPU by default. In a Codex
run the agent and the commands it runs (installs, linters, tests) share that
pod. A repository with a large lint or test suite can run out of memory, which
fails the run with `coding_failure_executor`. To give every coding run more,
deploy with `CODING_MEMORY_MB` and `CODING_CPUS`:

```bash
CODING_MEMORY_MB=6144 CODING_CPUS=2 deploy/gke/up.sh
```

`up.sh` adds them to the control plane only, which builds the coding pods.
`CODING_MEMORY_MB` must be an integer between 1024 and 32768, and `CODING_CPUS`
a number between 0.25 and 16. On Autopilot the control plane fits each pod to the
platform's memory-per-CPU range (about 1 to 6.5 GiB per CPU), so keep the two in
proportion. Autopilot bills pods by what they request, so larger values cost
more for every coding run while it runs. Leaving them unset keeps the defaults.

In a Claude Code run, the commands run in a separate tool-runner container whose
share of the pod is limited (at most 512 MiB and 0.25 CPU), so raising these
values mostly benefits Codex runs.

## Egress

The namespace is default-deny. The control plane, the coding proxy, and the
native gateway each need an egress rule to the instance's private address on
3307, the Cloud SQL Auth Proxy's port — the
overlay's rules that select the throwaway database by pod label do not match
a Cloud SQL address. `connector_enforcement = REQUIRED` (`cloudsql.tf`)
refuses a plain Postgres (5432) connection anyway, so there is no rule for
it.

## Secrets

`secrets.tf` creates one Secret Manager secret per value, **with no versions**,
and grants read access on each to a single Kubernetes service account,
`wardby-coding/wardby-secrets-reader`, as a Workload Identity principal: no
Google service account, no key. `up.sh` fills empty secrets through
`seed-secrets.mjs` and syncs them into the cluster with External Secrets
Operator, installed by Helm at the version pinned in `eso.env` and scoped to
`wardby-coding` by `eso-values.yaml`. One cluster-wide permission remains: ESO's
cert-controller keeps a ClusterRole that reads Secrets and can write only its
own webhook certificate (`external-secrets-webhook`). The controller that writes
wardby's Secrets is confined to `wardby-coding`. `eso-values.yaml` also gives
ESO's three pods explicit requests (100m CPU and 256 MiB each, memory limited to
the same): the chart sets none, and Autopilot would otherwise bill each pod at
its 500m / 2 GiB default.

Before it deletes any hand-made Secret, `up.sh` proves External Secrets can
really read Secret Manager with a throwaway ExternalSecret that reads one key
(`deploy/kind-coding/manifests/overlays/gke-autopilot/secrets/canary.yaml`). If
that read fails it stops, and the existing Secrets are left as they were.

The Jira secrets (`jira-*`) are optional and all or none. `seed-secrets.mjs`
leaves them empty when `.env.local` has none of them, and `up.sh` then skips
`secrets/external-secrets-jira.yaml`; the control plane reads its Secret,
`wardby-jira-env`, with `optional: true`. The Slack bot token
(`slack-bot-token`) is optional the same way: without it `up.sh` skips
`secrets/external-secrets-slack.yaml`, and the control plane reads
`wardby-slack-env` with `optional: true`.

`verify-eso-kind.sh` proves the manifests, the scoping and the handover on a
throwaway kind cluster. Run it after changing any of them or the chart version.

If External Secrets is broken during an incident, the synced Secrets stay in
place: ESO never deletes them on a sync error. If `wardby-control-plane-env`
itself has to be rebuilt by hand, first detach it from ESO without deleting
it:

```sh
kubectl -n wardby-coding delete externalsecret wardby-control-plane-env --cascade=orphan
```

(A plain delete would also delete the Secret, because ESO owns it.) Then
recreate it directly — don't use `deploy/kind-coding/control-plane-secret.sh`,
which is for the kind harness and expects a `DATABASE_URL` this deployment's
Secrets don't have. `DATABASE_URL` isn't a secret value on GKE at all: the
Deployment's own manifest supplies it directly (`control-plane.yaml`), not
the Secret, so a hand-rebuilt Secret needs none. Recreate every
`secret_ids` key (`secrets.tf`) plus `AUTH_PROVIDER` (the constant
`self-hosted` the ExternalSecret's template adds) by hand, reading each with
`gcloud secrets versions access latest --secret <name>` and piping it into a
Secret manifest over stdin, never with values on the command line.
`wardby-coding-proxy-env` needs only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`
the same way. Re-running `up.sh` later hands both Secrets back to ESO.

## Database login

`database-iam.tf` gives each workload its own Google service account and,
through Workload Identity, its own Cloud SQL IAM database user — no password
in any pod. Every connection to the instance goes through the Cloud SQL Auth
Proxy sidecar (`--private-ip`, listening on `127.0.0.1:5432`, dialing out to
the instance on 3307), which is what actually holds the IAM credential; the
application code just connects to localhost.

| Identity       | Google service account   | Kubernetes service account | Database role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane  | `<name_prefix>-app`      | `wardby-control-plane`     | `wardby_app` — read/write every table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Coding proxy   | `<name_prefix>-proxy`    | `wardby-coding-proxy`      | `wardby_proxy` — its budget ledger (`CodingProxySession`/`CodingProxyRequest`/`RunModelUsage`: read, insert, update), the package registry's tables (`RegistryAllowance`, `RegistryFetch`, `RegistryAuditRecord`, `RegistryVersionFact`, `RegistryApprovedVersion`, `RegistryPlanRefusal`: read and insert only), the dependency cache's `DependencySnapshot` (read, insert, update, delete), update `tokensIn`, `tokensOut`, `costUsd` and `turns` on `Run` and read only its `id`, and read only the `runId`, `packageAllowlist`, `packagePolicy`, `repository`, `workerImage`, `toolImage`, `dependencyCache` and `packageAuditMode` columns of `CodingRun` |
| Native gateway | `<name_prefix>-gateway`  | `wardby-native-gateway`    | Member of `wardby_app` — the same data access as the control plane, under its own login: it settles sandboxed runs, dispatches their delegations, and serves memory, datastores and secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Migrations     | `<name_prefix>-migrator` | `wardby-migrator`          | `SET ROLE` to the built-in owner, so migrations can alter and create tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`database-grants.sql` grants each privilege set to a `NOLOGIN` group role
(`wardby_app`, `wardby_proxy`) rather than to the IAM users directly, then
grants the IAM users membership (the gateway's user joins `wardby_app`).
`bootstrap-database-iam.sh` applies that file as the built-in owner, from a
short-lived Job inside the cluster (the instance has no public address to reach
from outside it), in one transaction: a statement the database refuses leaves
nothing applied. It sets a random password on the built-in owner through the
Cloud SQL Admin API, creating the owner if it does not exist, uses it once, and
resets it to another random value that is never stored — on every exit,
including a failed grant.

`up.sh` runs it on every deploy, after the migrations and before the rollout,
so an upgrade needs no manual database step; see
[Upgrading an existing deployment](../../docs/getting-started-gke.md#upgrading-an-existing-deployment). Run it by hand only on a brand-new project, in this order:

1. `terraform apply` — the instance and the four IAM database users. Run
   it directly, not through `up.sh`: `up.sh` would go on to the migrations
   before the migrator has its grants.
2. `bootstrap-database-iam.sh` — fetches the cluster's kubectl credentials if
   they're missing, creates the built-in owner and applies the migrator's (and
   the app's) grants. Grants on tables that don't exist yet are skipped:
   expected.
3. `up.sh` — migrations, then the grants again now that every table exists,
   then the rollout and every check.

`bootstrap-database-iam.sh --check` runs the grants inside a transaction that
is rolled back, and reports success or the exact refusal while changing no
grant.

`connector_enforcement` (a Cloud SQL instance setting, `cloudsql.tf`) set to
`REQUIRED` refuses any connection that does not come through the Auth Proxy
or a Cloud SQL connector — so a leaked password would be useless on the
network anyway, and it is the default now that every workload connects
through the Auth Proxy. Leave it at the default.

After the rollout, `up.sh` runs one query through the control plane's, the
coding proxy's, and the native gateway's own database login, and fails the
deploy if any cannot read the database. It also checks, as the coding proxy's
own role, every privilege `database-grants.sql` gives `wardby_proxy`
(`proxy-grant-checks.mjs`), and fails the deploy if one is missing.
`kubectl rollout undo` then restores the previous images and pod templates,
which also log in through IAM.

## Teardown

Apply `deletion_protection = false` **first**, then destroy. The flag is read
from Terraform state, so leaving it true means an extra apply on an instance you
are trying to remove. The four `google_sql_user.iam` users (`database-iam.tf`)
use `deletion_policy = "ABANDON"`: once a user has been granted privileges,
Postgres refuses to drop it, and destroy would fail partway through.
