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

Then hand the connection string to the cluster without it passing through a
terminal:

```bash
terraform output -raw database_url    # pipe this into your secret tooling
```

`DATABASE_URL` is needed by **two** workloads — the control plane and the coding
proxy. The proxy reads the database to validate a run's capability token and to
record token usage and cost, so a deployment that updates only the control
plane's secret fails at the first coding run, not at deploy time.

The control plane's `migrate` initContainer runs `prisma migrate deploy` on
every start, so pointing it at a fresh instance creates the schema with no extra
step.

## Egress

The namespace is default-deny. Both workloads need an egress rule to the
instance's private address on 5432; the overlay's rules that select the
throwaway database by pod label do not match a Cloud SQL address.

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
wardby's Secrets is confined to `wardby-coding`.

Before it deletes any hand-made Secret, `up.sh` proves External Secrets can
really read Secret Manager with a throwaway ExternalSecret that reads one key
(`deploy/kind-coding/manifests/overlays/gke-autopilot/secrets/canary.yaml`). If
that read fails it stops, and the existing Secrets are left as they were.

`verify-eso-kind.sh` proves the manifests, the scoping and the handover on a
throwaway kind cluster. Run it after changing any of them or the chart version.

If External Secrets is broken during an incident, the synced Secrets stay in
place: ESO never deletes them on a sync error. If `wardby-control-plane-env`
itself has to be rebuilt by hand, first detach it from ESO without deleting
it:

```sh
kubectl -n wardby-coding delete externalsecret wardby-control-plane-env --cascade=orphan
```

(A plain delete would also delete the Secret, because ESO owns it.) Then run
`deploy/kind-coding/control-plane-secret.sh` with `KUBE_CONTEXT` set. It
rebuilds only `wardby-control-plane-env`, from `.env.local`, and takes
`DATABASE_URL` from the existing `wardby-coding-proxy-env` Secret, which must
still exist. It does not rebuild `wardby-coding-proxy-env`. If that Secret is gone as well,
recreate it by hand with `DATABASE_URL`, `OPENAI_API_KEY` and
`ANTHROPIC_API_KEY`, reading each value with
`gcloud secrets versions access latest --secret <name>` and piping it into a
Secret manifest over stdin, never with values on the command line. Re-running
`up.sh` later hands the Secrets back to ESO.

## Database login

`database-iam.tf` gives each workload its own Google service account and,
through Workload Identity, its own Cloud SQL IAM database user — no password
in any pod. Every connection to the instance goes through the Cloud SQL Auth
Proxy sidecar (`--private-ip`, listening on `127.0.0.1:5432`, dialing out to
the instance on 3307), which is what actually holds the IAM credential; the
application code just connects to localhost.

| Identity      | Google service account   | Kubernetes service account | Database role                                                                                                                                       |
| ------------- | ------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane | `<name_prefix>-app`      | `wardby-control-plane`     | `wardby_app` — read/write every table                                                                                                               |
| Coding proxy  | `<name_prefix>-proxy`    | `wardby-coding-proxy`      | `wardby_proxy` — only `CodingProxySession`/`CodingProxyRequest`, plus update `tokensIn`, `tokensOut` and `costUsd` on `Run`, and read only its `id` |
| Migrations    | `<name_prefix>-migrator` | `wardby-migrator`          | `SET ROLE` to the built-in owner, so migrations can alter and create tables                                                                         |

`database-grants.sql` grants each privilege set to a `NOLOGIN` group role
(`wardby_app`, `wardby_proxy`) rather than to the IAM users directly, then
grants the IAM users membership. `bootstrap-database-iam.sh` applies that file
as the built-in owner, from a short-lived Job inside the cluster (the instance
has no public address to reach from outside it), in one transaction: a
statement the database refuses leaves nothing applied. Run it again whenever
`database-grants.sql` changes. Grants on named tables apply only once the
migrations have created them, which is why a brand-new project runs it twice.

A brand-new project, in order (`docs/getting-started-gke.md`, "Database login",
has the command that feeds the password):

1. `terraform apply` — the instance and the three IAM database users.
2. `up.sh` — stops at the migration step, as expected: the migrator has no
   grants yet.
3. `bootstrap-database-iam.sh --password-from-stdin`, fed the password from
   Secret Manager's `<name_prefix>-database-url` exactly as for the cutover —
   the migrator's grants. Default mode would refuse: the Secret already holds a
   password `DATABASE_URL`.
4. `up.sh` — migrations and rollout; its database check then stops it, because
   the coding proxy's tables did not exist in step 3.
5. `bootstrap-database-iam.sh --password-from-stdin` again — adds the coding
   proxy's ledger grants, now that its tables exist.
6. `up.sh` — passes every check.

An existing deployment: `bootstrap-database-iam.sh --password-from-stdin
--check` (every grant applies, then rolled back — the only way to know the
instance accepts them), then the same without `--check`, then `up.sh`.

The bootstrap has two modes:

- **Default (emergency admin access).** Sets a random password on the
  built-in owner through the Cloud SQL Admin API, creating the owner if it
  does not exist, uses it once for this run, and resets it to another random
  value that is never stored — on every exit, including a failed grant. It
  refuses to run this way while Secret `wardby-control-plane-env` still has a
  `DATABASE_URL` key, since that means running pods still log in with the
  current owner password and changing it would cut them off; `--force-rotate`
  overrides that refusal and is for an emergency only, knowing it cuts those
  pods off.
- **`--password-from-stdin`.** Uses the password it is given and never
  changes it. This is the path for moving a running deployment from password
  login to IAM login: the owner password the pods already use also applies
  the grants, so nothing already running is disturbed.

Either mode takes `--check`: the grants run inside a transaction that is
rolled back, and the bootstrap reports success or the exact refusal while
changing nothing. Run it before the real run on a live deployment.

`connector_enforcement` (a Cloud SQL instance setting, `cloudsql.tf`) set to
`REQUIRED` refuses any connection that does not come through the Auth Proxy
or a Cloud SQL connector — so a leaked password is useless on the network. It
defaults to `NOT_REQUIRED` for now, because pods may still log in with the
password; it becomes the default when the password login is retired (a
follow-up change). Set it to `REQUIRED` yourself on a deployment that never
used password login.

After the rollout, `up.sh` runs one query through the control plane's and the
coding proxy's own database login, and fails the deploy if either cannot read
the database — while the password login is still enabled, `kubectl rollout
undo` then restores the previous version.

## Teardown

Apply `deletion_protection = false` **first**, then destroy. The flag is read
from Terraform state, so leaving it true means an extra apply on an instance you
are trying to remove. `google_sql_user` uses `deletion_policy = "ABANDON"`
because Postgres refuses to drop a user that owns tables, which is exactly what
the migrations create.
