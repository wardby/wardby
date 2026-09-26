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
- Native runs use the durable executor (`EXECUTOR=dbos`), so a run survives
  the control-plane pod being preempted or rescheduled. See "Durable executor"
  below.

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
| Control plane | `<name_prefix>-app`      | `wardby-control-plane`     | `wardby_app`: read/write every table, including the durable executor's in schema `dbos`; never change a schema                                                         |
| Coding proxy  | `<name_prefix>-proxy`    | `wardby-coding-proxy`      | `wardby_proxy`: only its budget ledger — `CodingProxySession`/`CodingProxyRequest`, plus update `tokensIn`, `tokensOut` and `costUsd` on `Run`, and read only its `id` |
| Migrations    | `<name_prefix>-migrator` | `wardby-migrator`          | Acts as the table owner (`SET ROLE`), so `prisma migrate deploy` and `dbos schema` can alter and create tables                                                         |

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
even attempt. Leave it at the default; an older deployment still on password
login moves off it on an earlier revision of this module, below.

### Moving an older deployment

A deployment still on password login — from before this module retired it —
can't adopt this revision directly: this revision no longer syncs the
password `DATABASE_URL`, closes port 5432 and refuses non-Auth-Proxy
connections, which would cut off pods still logging in with the password.
It moves over in stages, because real pods are already serving traffic
throughout.

**1–2. Cut the running pods to IAM login, on the revision before this one.**
Check out the revision of this module that added IAM login, before the
password was retired: the merge of pull request #83 into `main`.
`git log --oneline --first-parent main -- deploy/gke` lists the merges that
changed this module, newest first; it's the one titled
`Merge pull request #83 ...`, just below the merge that retired the password
(`git log --oneline --merges --grep='#83' main` finds it directly). Then
`git checkout <that commit>` and follow that revision's own
`docs/getting-started-gke.md`, "Database login", and its order for "an
existing deployment still on password login": `bootstrap-database-iam.sh
--password-from-stdin --check`, the same without `--check`, then `up.sh`.
That rolls out password-less pods while the password still works as a
fallback, and proves the control plane and the coding proxy each read the
database through their own IAM login. That revision's
`connector_enforcement` default is still `NOT_REQUIRED`, so nothing that
still uses the password is cut off. Then return to this revision
(`git checkout main`) for the last stage.

**3. Retire the password**, once every pod speaks IAM login and this change
has merged to `main`:

1. Confirm nothing still uses the password: both Deployments' pods log in as
   IAM users, and no pod has a password `DATABASE_URL` in its effective env.
2. Delete the `database-url` Secret Manager secret:
   `gcloud secrets delete <name_prefix>-database-url --quiet` — this module no
   longer creates or reads it. Deleting it by hand first, before the next
   step, is what lets Terraform drop it from state instead of trying to
   destroy it.
3. Remove any `connector_enforcement` line from `terraform.tfvars` (or set
   it to `REQUIRED`), so the new default takes effect. Then `terraform plan`:
   expect the generated password destroyed, the `database-url` secret and
   its IAM binding gone from state (already deleted by hand), the old
   password-login user forgotten (not destroyed), `connector_enforcement`
   moving to `REQUIRED` on the instance (updated in place, not replaced),
   and no other destroy. Review
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

Create the first self-hosted login credential. It is printed once.
`--role admin` makes this operator account an admin. Only admins can use all
the privileged operations: `make_owner`, BYO `workerImageRef`, and package
approval. A `package-approver` can approve packages only. Users created
without `--role` have no roles. See
[roles and privileged operations](security-deployment.md#roles-and-privileged-operations).

```sh
kubectl exec -n wardby-coding deploy/wardby-control-plane \
  -c control-plane -- \
  node dist/cli.js auth user create --subject YOUR_SUBJECT --role admin
```

When you upgrade a deployment created before roles existed, every existing
user has no roles, including you. Grant the admin role to yourself, then
reconnect your MCP client:

```sh
kubectl exec -n wardby-coding deploy/wardby-control-plane \
  -c control-plane -- \
  node dist/cli.js auth user grant --subject YOUR_SUBJECT --role admin
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

### Durable executor

The control plane runs native runs on the durable executor (`EXECUTOR=dbos`):
each LLM turn and tool call is checkpointed in Postgres, in schema `dbos`. If
the control-plane pod is preempted, evicted or rescheduled, its replacement
picks each interrupted run up from its last completed step once the run's
heartbeat times out (about a minute after the replacement is running). Only
the step that was in flight runs again. Coding runs are Kubernetes Jobs and are unaffected.

- **Schema.** The migration Job creates and migrates `dbos` as the migrator
  (`npm run dbos:migrate`) after the Prisma migrations, so it always runs
  before the control plane starts. The control plane's role only reads and
  writes it: `database-grants.sql` grants `wardby_app` `USAGE` on the schema,
  `SELECT`/`INSERT`/`UPDATE`/`DELETE` on its tables, and the same through the
  owner's default privileges for tables a later DBOS version adds.
- **Executor id.** `DBOS_EXECUTOR_ID` is left unset, so every process gets a
  random one. A replacement pod does not need the old pod's id: the
  reconciler adopts any interrupted run, whichever process started it. This is
  also what makes the overlapping rolling update safe.
- **Version.** `up.sh` sets `DBOS__APPVERSION` to the runtime image digest. A
  run resumes only under the version that started it: across a pod move, or an
  `up.sh` re-run whose source did not change, runs continue. When you deploy
  new code, runs still in flight as the old pod stops are marked `lost`, the
  same as without the durable executor. Deploy between runs if that matters.
- **Data at rest and retention.** `dbos.operation_outputs` holds every step's
  output — prompts, model responses and full tool results — with no retention
  limit. Pruning finished workflows is the operator's job; see
  [Durable executor](security-deployment.md#durable-executor) for what is
  stored and how to prune it with `DBOS.deleteWorkflow`.

**Enabling it on an existing deployment.** The grants changed, so apply them
before deploying: run `deploy/gke/bootstrap-database-iam.sh --check`, then
`deploy/gke/bootstrap-database-iam.sh`, then `deploy/gke/up.sh`. Without the
grants the new control-plane pod crash-loops with "permission denied" while
the old one keeps serving, and `up.sh` stops at the rollout. On a brand-new
project the order under "Database login" already covers it.

**Switching back** to the in-process executor: set `EXECUTOR` to `in-process`
in `deploy/kind-coding/manifests/overlays/gke-autopilot/control-plane.yaml`
and re-run `up.sh`. Runs in flight at that moment end `lost`.

### Pod priority and headroom

The GKE overlay defines three PriorityClasses so that, when a node runs short,
the scheduler evicts the cheapest pods first instead of an arbitrary one:

| Class                  | Value   | Used by                                  | Preempts others |
| ---------------------- | ------- | ---------------------------------------- | --------------- |
| `wardby-control-plane` | 1000000 | control plane and coding proxy           | yes             |
| `wardby-coding-run`    | 1000    | coding-run pods and the preflight canary | no              |
| `wardby-headroom`      | -10     | the `wardby-headroom` placeholder        | no              |

Coding runs get their class through `KUBERNETES_RUN_PRIORITY_CLASS` on the
control plane. GKE's own `system-*` classes still outrank all three: priority
decides who is evicted first, not whether anything can be.

`wardby-headroom` is a one-replica Deployment of the `pause` image that
reserves spare capacity, preferably on the control plane's node. A
higher-priority pod that cannot fit takes that capacity by evicting the
placeholder rather than a Wardby pod, and Autopilot then provisions a node for
the placeholder. Autopilot bills for its requests (250m CPU and 512 MiB of
memory), and it counts against the `wardby-coding` ResourceQuota. To disable
it, set `replicas: 0` in
`deploy/kind-coding/manifests/overlays/gke-autopilot/priority.yaml` and re-run
`up.sh`; raise its requests to reserve more.

A PriorityClass's value and preemption policy cannot be changed in place:
delete the class and re-run `up.sh` to change them.

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
