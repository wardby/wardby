# deploy/gke — managed Postgres for a GKE-hosted control plane

Terraform for a Cloud SQL Postgres instance with **no public IP**, reachable
from a GKE cluster over a VPC peering. It is the durable store behind the
control plane deployed by
`deploy/kind-coding/manifests/overlays/gke-autopilot/`, replacing the throwaway
`emptyDir` Postgres that overlay ships for smoke tests.

Scope is deliberately narrow: this module creates the **database and its
networking**, nothing else. The cluster itself is not yet in Terraform.

## Why not deploy/gcp

`deploy/gcp` deploys the control plane to Cloud Run with a **public-IP** Cloud
SQL instance, which Cloud Run reaches through the Cloud SQL connector. GKE pods
cannot use that connector, and the alternatives — a public IP with authorized
networks, or an Auth Proxy sidecar in every workload — are worse than a private
address that both the control plane and the coding proxy dial directly. The two
modules describe different architectures on purpose; neither is a variant of the
other.

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

## Teardown

Apply `deletion_protection = false` **first**, then destroy. The flag is read
from Terraform state, so leaving it true means an extra apply on an instance you
are trying to remove. `google_sql_user` uses `deletion_policy = "ABANDON"`
because Postgres refuses to drop a user that owns tables, which is exactly what
the migrations create.
