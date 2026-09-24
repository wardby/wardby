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
  deployed by immutable digest.
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
  compute.googleapis.com \
  container.googleapis.com \
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

Use a remote Terraform backend for shared or production deployments. A local
state file contains the generated database password (until IAM
database authentication replaces it) and must not be committed. It contains no
other secret: Terraform creates the Secret Manager secrets empty.

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

## 7. Verify

```sh
kubectl -n wardby-coding get pods
kubectl -n wardby-coding get gateway,httproute
kubectl -n wardby-coding describe gateway wardby-control-plane

curl -sS -o /dev/null -w '%{http_code}\n' \
  https://wardby.example.com/.well-known/oauth-protected-resource
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  https://wardby.example.com/mcp
```

The discovery request should return `200`; an unauthenticated MCP POST should
return `401`.

Create the first self-hosted login credential. It is printed once:

```sh
kubectl exec -n wardby-coding deploy/wardby-control-plane \
  -c control-plane -- \
  node dist/cli.js auth user create --subject YOUR_SUBJECT
```

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
images, pushes them, substitutes immutable digests, leaves Secret Manager values as they are, and
waits for rollouts.

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
printf '%s' "$NEW_VALUE" | gcloud secrets versions add wardby-openai-api-key --data-file=-
for es in wardby-coding-proxy-env wardby-control-plane-env; do
  kubectl -n wardby-coding annotate externalsecret "$es" force-sync="$(date +%s)" --overwrite
done
kubectl -n wardby-coding wait externalsecret --all --for=condition=Ready --timeout=120s
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

The cluster, Cloud SQL and the Secret Manager secrets use deletion protection. Disable both flags and
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
