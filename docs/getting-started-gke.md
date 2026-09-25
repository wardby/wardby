# Getting started on GKE

This is the supported Google Cloud deployment path for Wardby. It creates a
GKE Autopilot cluster, Artifact Registry, private-IP Cloud SQL for PostgreSQL,
isolated coding workers, an HTTPS Gateway, and the Wardby control plane.

The older `deploy/gcp` Cloud Run module is deprecated. New deployments should
use `deploy/gke` and the `gke-autopilot` Kubernetes overlay described here.

> This deployment creates billable Google Cloud resources. Use a dedicated
> project, review `terraform plan`, configure budgets and alerts, and understand
> the teardown procedure before applying it.

## Architecture

- The Wardby control plane and coding proxy run in GKE Autopilot.
- Each Codex coding run uses an ephemeral gVisor-backed pod.
- Cloud SQL PostgreSQL has no public IP and is reached through private services
  access on the cluster's VPC.
- Runtime, migration, and worker images are stored in Artifact Registry and
  deployed by immutable digest. Two worker images are published: the default
  `node` toolchain and `node-python` (Debian's Python 3 with pytest and ruff).
  Coding agents select the latter with `toolchain: "node-python"` and
  `toolchainVersion: "3.12"`, the key it is registered under.
- A global GKE Gateway terminates TLS with Certificate Manager and applies a
  Cloud Armor rate-limit policy.
- Namespace RBAC and default-deny network policies constrain the launcher,
  proxy, control plane, and worker pods.

Claude Code's two-container executor is currently Docker-only; the Kubernetes
launcher accepts Codex coding workers.

## 1. Prerequisites

Install and authenticate:

- Google Cloud CLI (`gcloud`)
- Terraform 1.10 or newer
- Docker with `linux/amd64` build support
- `kubectl`
- Helm 3 or later (installs External Secrets Operator)
- Node.js 24 and npm

You also need:

- a Google Cloud project with billing enabled;
- a DNS hostname you control, such as `wardby.example.com`;
- an OpenAI API key and an Anthropic API key (the current deployment script
  provisions both proxy routes);
- a dedicated GitHub App installed on the repositories coding agents may use;
  and
- permission to create GKE, Cloud SQL, networking, Artifact Registry,
  Certificate Manager, and Cloud Armor resources.

Clone the repository because the cloud deployment assets are not exposed as an
`npx` deployment command:

```sh
git clone https://github.com/wardby/wardby.git
cd wardby
npm ci
```

Authenticate both Terraform and Docker:

```sh
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT_ID
gcloud auth configure-docker YOUR_REGION-docker.pkg.dev
```

## 2. Enable Google Cloud APIs

```sh
gcloud services enable \
  artifactregistry.googleapis.com \
  certificatemanager.googleapis.com \
  cloudresourcemanager.googleapis.com \
  compute.googleapis.com \
  container.googleapis.com \
  iam.googleapis.com \
  networksecurity.googleapis.com \
  secretmanager.googleapis.com \
  servicenetworking.googleapis.com \
  sqladmin.googleapis.com
```

API enablement can take several minutes to propagate.

## 3. Configure Terraform

```sh
cp deploy/gke/terraform.tfvars.example deploy/gke/terraform.tfvars
```

Set `project_id`, `region`, and the VPC/subnetwork. The selected network **must
be the network used by the cluster** because private-services peering is not
transitive.

Use a remote Terraform backend for shared or production deployments: state
tracks real infrastructure, and losing it is expensive to reconstruct even
though it holds no secret. Every workload logs in through Cloud SQL IAM, so
state contains no database password; Terraform creates the Secret Manager
secrets empty too.

Review before applying:

```sh
terraform -chdir=deploy/gke init
terraform -chdir=deploy/gke validate
terraform -chdir=deploy/gke plan
terraform -chdir=deploy/gke apply
```

Terraform creates the Autopilot cluster with the standard Gateway API channel,
Artifact Registry, private service range, Cloud SQL instance, database, and
database user.

Fetch the cluster context and verify the Gateway classes:

```sh
$(terraform -chdir=deploy/gke output -raw kubectl_context_command)
kubectl get gatewayclass
```

`gke-l7-global-external-managed` must report `ACCEPTED=True` before continuing.
Google notes that Gateway API enablement can take significant time to reconcile.

## 4. Prepare secrets

Create `.env.local` at the repository root and keep it untracked:

```dotenv
OPENAI_API_KEY="..."
ANTHROPIC_API_KEY="..."
SECRET_APP_KEY="64_HEX_CHARACTERS"
GITHUB_APP_ID="..."
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----"
```

Generate `SECRET_APP_KEY` with:

```sh
openssl rand -hex 32
```

`.env.local` is only the **first-time source**. On its first run `up.sh`
copies each value into Google Secret Manager, over stdin and never in a process
argument, and External Secrets Operator syncs them into the cluster from then
on. A value already in Secret Manager is never overwritten, so after the first
deployment Secret Manager is the source of truth. You can then remove the
production values from `.env.local`.

Redeploying onto a cluster that already runs Wardby carries its existing
`SECRET_APP_KEY` and login signing keys over, so stored credentials still
decrypt and nobody has to sign in again.

## 5. Prepare the public edge

The committed Gateway expects three global resources named
`wardby-control-plane`: a static address, Certificate Manager certificate map,
and Cloud Armor security policy.

Reserve the address and create the policy:

```sh
gcloud compute addresses create wardby-control-plane --global
gcloud compute security-policies create wardby-control-plane
gcloud compute security-policies rules create 1000 \
  --security-policy=wardby-control-plane \
  --src-ip-ranges='*' \
  --action=throttle \
  --rate-limit-threshold-count=300 \
  --rate-limit-threshold-interval-sec=60 \
  --conform-action=allow \
  --exceed-action=deny-429 \
  --enforce-on-key=IP
```

Create a DNS authorization for your hostname:

```sh
gcloud certificate-manager dns-authorizations create wardby-control-plane \
  --domain=wardby.example.com
gcloud certificate-manager dns-authorizations describe wardby-control-plane
```

Add the returned `dnsResourceRecord` CNAME to your DNS provider. Then create
the certificate and map:

```sh
gcloud certificate-manager certificates create wardby-control-plane \
  --domains=wardby.example.com \
  --dns-authorizations=wardby-control-plane
gcloud certificate-manager maps create wardby-control-plane
gcloud certificate-manager maps entries create wardby-control-plane \
  --map=wardby-control-plane \
  --certificates=wardby-control-plane \
  --hostname=wardby.example.com
```

Wait for the certificate and map entry to become active. These steps follow
Google's [Certificate Manager DNS-authorization
procedure](https://cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth)
and [GKE Gateway guidance](https://cloud.google.com/kubernetes-engine/docs/how-to/deploying-gateways).

## 6. Deploy Wardby

The deployment script is idempotent. It converges Terraform, builds and pushes
`linux/amd64` images, resolves immutable digests, seeds Secret Manager and installs External Secrets Operator to sync it,
renders the GKE overlay, and waits for the proxy and control plane:

```sh
HOSTNAME=wardby.example.com deploy/gke/up.sh
```

Point the hostname's public A record at the reserved address:

```sh
gcloud compute addresses describe wardby-control-plane \
  --global --format='value(address)'
```

Allow DNS and the managed certificate to converge before treating an HTTPS
failure as an application failure.

On a brand-new project, run `terraform apply` and then
`bootstrap-database-iam.sh` before `up.sh`: the bootstrap has to grant the
migrator before any migration can run. See "Database login" below for the
exact order, including the database check `up.sh` doesn't pass until a second
bootstrap run has granted the coding proxy too.

### Database login

Each workload authenticates to Cloud SQL as its own Google service account,
through the Cloud SQL Auth Proxy, via Workload Identity from one Kubernetes
service account. What each may do inside the database comes from a `NOLOGIN`
group role in `deploy/gke/database-grants.sql`:

| Workload      | Google service account   | Kubernetes service account | May do                                                                                                                                                                 |
| ------------- | ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane | `<name_prefix>-app`      | `wardby-control-plane`     | `wardby_app`: read/write every table                                                                                                                                   |
| Coding proxy  | `<name_prefix>-proxy`    | `wardby-coding-proxy`      | `wardby_proxy`: only its budget ledger — `CodingProxySession`/`CodingProxyRequest`, plus update `tokensIn`, `tokensOut` and `costUsd` on `Run`, and read only its `id` |
| Migrations    | `<name_prefix>-migrator` | `wardby-migrator`          | Acts as the table owner (`SET ROLE`), so `prisma migrate deploy` can alter and create tables                                                                           |

`deploy/gke/bootstrap-database-iam.sh` applies the grants as the built-in
owner, from a short-lived Job inside the cluster. Run it whenever
`database-grants.sql` changes, and as part of the orders below. The grants run
in one transaction, so a statement the database refuses leaves nothing applied.

The built-in owner is not a Terraform resource: `bootstrap-database-iam.sh`
creates it if it's missing, sets a one-time password on it through the Cloud
SQL Admin API, uses that password once to apply the grants, and resets it to
a value nobody holds on every exit, including a failed grant. No password is
ever stored, printed, or passed as a process argument.

A brand-new project runs, in this order:

1. `terraform -chdir=deploy/gke apply` — creates the cluster, the instance
   and the three IAM database users. Run it yourself rather than through
   `up.sh`, which would go on to the migrations before the migrator has its
   grants.
2. `deploy/gke/bootstrap-database-iam.sh` (default mode) — fetches the
   cluster's kubectl credentials if you don't have them yet, creates the
   owner, and applies the migrator's (and the app's) grants. The coding
   proxy's ledger tables don't exist yet, so its grants are skipped: expected.
3. `deploy/gke/up.sh` — applies the migrations and rolls out, then stops at
   the database check: the coding proxy's grants are on tables that did not
   exist in step 2.
4. `deploy/gke/bootstrap-database-iam.sh` again — now that the tables exist,
   also applies the coding proxy's ledger grants.
5. `deploy/gke/up.sh` — rolls out again and passes every check.

Two bootstrap runs, not one: a grant on a named table can't apply before the
migration that creates that table has run.

`bootstrap-database-iam.sh --check` runs the grants inside a transaction that
is then rolled back, and reports success or the exact statement the database
refused, without changing anything. Run it before the real run on a live
deployment.

`connector_enforcement` (the Cloud SQL instance setting) defaults to
`REQUIRED`: it refuses any connection that does not come through the Auth
Proxy or a Cloud SQL connector, and with port 5432 to the instance closed in
every NetworkPolicy, there's no route left for a plain Postgres connection to
even attempt. Set it to `NOT_REQUIRED` only while moving an older deployment
off password login, below.

### Moving an older deployment

A deployment still on password login — from before this module retired it —
moves over in two stages, because real pods are already serving traffic
throughout.

**1. Adopt this module's Terraform without breaking password login yet.**
Set `connector_enforcement = "NOT_REQUIRED"` in `terraform.tfvars`,
overriding the new default, then `terraform apply`. That apply only forgets
the old password-login user from state (`removed`, not destroyed, in
`cloudsql.tf`) and changes nothing live.

**2. Cut the running pods to IAM login, with the password still there as a
fallback.** Feed the owner's current password without ever displaying it,
straight from Secret Manager's `<name_prefix>-database-url` (this secret still
exists on a deployment that hasn't retired the password yet):

```sh
gcloud secrets versions access latest --secret wardby-database-url \
    --project=YOUR_PROJECT_ID \
  | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p' \
  | deploy/gke/bootstrap-database-iam.sh --password-from-stdin --check
```

(Substitute your `name_prefix` if you changed it from the default `wardby`.)
`--check` proves every grant applies and changes nothing. The same command
without `--check` applies them for real; the running pods are undisturbed,
since their password is unchanged. Then `deploy/gke/up.sh` rolls out
password-less pods and proves the control plane and the coding proxy each
read the database through their own IAM login before it finishes.

**3. Retire the password**, once every pod speaks IAM login and this change
has merged to `main`:

1. Confirm nothing still uses the password: both Deployments' pods log in as
   IAM users, and no pod has a password `DATABASE_URL` in its effective env.
2. Delete the `database-url` Secret Manager secret:
   `gcloud secrets delete <name_prefix>-database-url --quiet` — this module no
   longer creates or reads it. Deleting it by hand first, before the next
   step, is what lets Terraform drop it from state instead of trying to
   destroy it.
3. `terraform plan`: expect the generated password destroyed, the
   `database-url` secret and its IAM binding gone from state (already
   deleted by hand), the old password-login user forgotten (not destroyed),
   `connector_enforcement` moving to `REQUIRED`, and no other destroy. Review
   the plan, then apply only once it matches that. If apply still fails
   trying to destroy the `database-url` secret, the secret wasn't actually
   deleted in step 2 — delete it and re-apply. Never turn off
   `secrets_deletion_protection` to get past that error: it unprotects every
   other secret in the same set, including `SECRET_APP_KEY` and the auth
   keys, and losing `SECRET_APP_KEY` makes every credential already stored
   in the database unreadable.
4. `deploy/gke/up.sh` — new ExternalSecrets carry no `DATABASE_URL`,
   NetworkPolicies no longer allow 5432, migrations, rollout, and the
   database and endpoint checks.
5. `deploy/gke/bootstrap-database-iam.sh` (default mode) — the guard now
   passes, since the Secret no longer has a `DATABASE_URL`: it sets a
   one-time owner password, reapplies the grants, and resets the password to
   a value nobody holds.
6. Verify: a direct password connection is refused (NetworkPolicy blocks
   5432, and the instance refuses it too), the pods still log in through
   IAM, and the Terraform state holds no database password.

## 7. Verify

```sh
kubectl -n wardby-coding get pods
kubectl -n wardby-coding get gateway,httproute
kubectl -n wardby-coding describe gateway wardby-control-plane

curl -sS -o /dev/null -w '%{http_code}\n' \
  https://wardby.example.com/.well-known/oauth-protected-resource
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  https://wardby.example.com/mcp
```

The discovery request should return `200`; an unauthenticated MCP
`initialize` request should return `401`. Send the JSON body: without it the
server answers `415`, because it checks the content type before the token.

Create the first self-hosted login credential. It is printed once:

```sh
kubectl exec -n wardby-coding deploy/wardby-control-plane \
  -c control-plane -- \
  node dist/cli.js auth user create --subject YOUR_SUBJECT
```

The deployment helper configures Wardby's self-hosted authorization server by
default. To use your organization's OAuth/OIDC provider instead, configure the
control-plane secret for delegated authentication and follow
[Bring your own identity provider](getting-started-identity-provider.md). In
delegated mode, users and clients belong to the external provider and you do
not create Wardby login credentials.

Run the coding boundary preflight inside the configured control-plane pod:

```sh
kubectl exec -n wardby-coding deploy/wardby-control-plane \
  -c control-plane -- \
  node dist/cli.js coding preflight
```

Before production use, complete the [release verification](release-verification.md)
and [security deployment](security-deployment.md) checklists.

## 8. Operate and update

Re-run `deploy/gke/up.sh` after a source or configuration change. It rebuilds
images, pushes them, substitutes immutable digests, leaves Secret Manager values
as they are, waits for rollouts, and then checks the public endpoint: discovery
must answer `200` and an unauthenticated MCP request `401`, or the deploy fails.

A control-plane restart is designed not to drop requests, at the cost of a
slower rollout. A new pod must stay Ready for three minutes before the old one
is retired, because the load balancer can take well over a minute to start
routing to a new pod even after its health check passes; the old pod then keeps
serving for 30 seconds while the load balancer drains it. `up.sh` checks the
endpoint only after the old pod is gone, and requires a steady minute of
successful responses.

Migrations run as a `wardby-migrate-<unix time>` Job before the Deployments
roll; if it fails, `up.sh` prints the `migrate` and `cloud-sql-proxy` container
logs (and, if those are empty or the Job timed out, the Job's and pod's
events), then stops.

### Roll back

Images are pinned by digest, so undoing a rollout restores exactly what ran
before. `up.sh` prints the previous digests at the end of every deploy.

```sh
kubectl -n wardby-coding rollout undo deploy/wardby-control-plane
kubectl -n wardby-coding rollout undo deploy/wardby-coding-proxy
```

`rollout undo` restores only the Deployments' images and pod templates — there
is no password path to fall back to any more, so a rollback is safe only for
a version that still speaks IAM login. It does not touch any NetworkPolicy: a
change to the database egress rules themselves is not undone by `rollout
undo`.

Database migrations only go forward: a rollback does not undo a schema change.
That is safe while every migration is additive (new tables, nullable columns,
indexes), which is the rule for this repository. Secrets are not part of a
rollout either; they come from Secret Manager whichever version is running.

Useful diagnostics:

```sh
kubectl -n wardby-coding get events --sort-by=.lastTimestamp
kubectl -n wardby-coding logs deploy/wardby-control-plane -c control-plane
kubectl -n wardby-coding logs deploy/wardby-coding-proxy
terraform -chdir=deploy/gke plan
```

### Rotate a secret

Add a version in Secret Manager, force both ExternalSecrets to sync and wait
for them, then restart both Deployments. The names below assume the default
`name_prefix` of `wardby`; substitute yours if you changed it.

```sh
printf '%s' "$NEW_VALUE" | gcloud secrets versions add wardby-openai-api-key --project=YOUR_PROJECT_ID --data-file=-
KUBE_CONTEXT="$(kubectl config current-context)" NAMESPACE=wardby-coding bash -c 'source deploy/gke/lib-secrets.sh && wait_external_secrets_synced 120s wardby-coding-proxy-env wardby-control-plane-env' && \
kubectl -n wardby-coding rollout restart deploy/wardby-coding-proxy deploy/wardby-control-plane
```

Pods read their environment only at start, hence the restart. The LLM API
keys and the database URL are read by both Deployments; the other secrets only
by the control plane. Do **not** rotate `SECRET_APP_KEY` this way: it encrypts
credentials already stored in the database, and a new key leaves them
unreadable.

See [Observability](observability.md) for Prometheus, Grafana, and cloud metric
collection options.

## 9. Teardown

The cluster, Cloud SQL and the Secret Manager secrets use deletion protection. Disable all three flags and
apply that change before destroying:

```hcl
deletion_protection         = false
cluster_deletion_protection = false
secrets_deletion_protection = false
```

```sh
terraform -chdir=deploy/gke apply
terraform -chdir=deploy/gke destroy
```

The static address, Certificate Manager resources, DNS records, and Cloud Armor
policy were created outside Terraform and must be removed separately after the
Gateway is gone. Review the project for retained Artifact Registry images and
remote Terraform state before deleting the project.
