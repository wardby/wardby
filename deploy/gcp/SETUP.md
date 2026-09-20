# One-time GCP project setup

Prerequisites before `terraform plan`/`apply` will work against a real (even
throwaway/sandbox) project. Do this once per project; the Terraform module
itself provisions everything after this point.

Requires the `gcloud` CLI installed and authenticated
(`gcloud auth login`).

## 1. Create or select a project

```bash
gcloud projects create my-gcp-project-id --name="reevo-run sandbox"
gcloud config set project my-gcp-project-id
```

## 2. Link a billing account

Cloud SQL and Cloud Run both require billing enabled, even on the free tier.

```bash
gcloud billing accounts list
gcloud billing projects link my-gcp-project-id --billing-account=BILLING_ACCOUNT_ID
```

## 3. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  artifactregistry.googleapis.com
```

API enablement can take up to a couple of minutes to propagate — if
`terraform apply` fails with an "API not enabled" error immediately after
this step, wait and retry.

## 4. Verify domain ownership (manual, one time, before `domain.tf` applies)

`google_cloud_run_domain_mapping` refuses to create until Google has
verified you own `var.domain_name`. This is a browser-based flow, not
something Terraform can do for you:

```bash
gcloud domains verify your-domain.example.com
```

This opens Search Console; follow its instructions (a DNS TXT record or an
HTML file upload) to complete verification. Do this before running
`terraform apply` — `domain.tf`'s resource will otherwise fail.

## 5. Set up a Terraform state backend

Not included in this module (deliberately — see `../README.md`). A GCS
bucket is the natural choice on GCP:

```bash
gcloud storage buckets create gs://my-gcp-project-id-tfstate \
  --location=us-central1 --uniform-bucket-level-access
gcloud storage buckets update gs://my-gcp-project-id-tfstate --versioning
```

Then add a backend block (not committed to this module — put it in a local
`backend.tf` you keep out of version control, or pass `-backend-config`
flags to `terraform init`):

```hcl
terraform {
  backend "gcs" {
    bucket = "my-gcp-project-id-tfstate"
    prefix = "control-plane"
  }
}
```

## 6. Authenticate Terraform itself

Simplest for a personal sandbox — Application Default Credentials under
your own gcloud login (no service account key file to manage):

```bash
gcloud auth application-default login
```

For a real shared/CI deployment, use a dedicated Terraform service account
with `roles/run.admin`, `roles/cloudsql.admin`, `roles/secretmanager.admin`,
`roles/iam.serviceAccountAdmin`, and `roles/resourcemanager.projectIamAdmin`
instead — that's a separate, more deliberate decision this baseline
doesn't make for you.

## 7. Build and push a container image

`var.container_image` has no default — this module doesn't build or
publish the image. A minimal path using Artifact Registry and the existing
`deploy/Dockerfile`:

```bash
gcloud artifacts repositories create reevo-run \
  --repository-format=docker --location=us-central1

# from the repo root:
docker build -f deploy/Dockerfile --target runtime \
  -t us-central1-docker.pkg.dev/my-gcp-project-id/reevo-run/control-plane:latest .
docker push us-central1-docker.pkg.dev/my-gcp-project-id/reevo-run/control-plane:latest
docker inspect --format '{{index .RepoDigests 0}}' \
  us-central1-docker.pkg.dev/my-gcp-project-id/reevo-run/control-plane:latest

docker build -f deploy/Dockerfile --target migration \
  -t us-central1-docker.pkg.dev/my-gcp-project-id/reevo-run/control-plane-migrate:latest .
docker push us-central1-docker.pkg.dev/my-gcp-project-id/reevo-run/control-plane-migrate:latest
docker inspect --format '{{index .RepoDigests 0}}' \
  us-central1-docker.pkg.dev/my-gcp-project-id/reevo-run/control-plane-migrate:latest
```

Use the first digest as `container_image` and the second as
`migration_image` in your `terraform.tfvars` (not mutable tags — consistent
with how every other image in this repo is pinned). `terraform apply` runs
the migration image automatically against the live database on every
apply where it changes — see `migration-job.tf`.

## 8. Plan and apply

```bash
cd deploy/gcp
cp terraform.tfvars.example terraform.tfvars   # fill in your values from the steps above
terraform init
terraform plan
terraform apply
```

## 9. Point DNS at the mapping

`terraform apply` creates the domain mapping, but the DNS records
themselves are provider-specific and not a Terraform output. Fetch them
after apply:

```bash
gcloud run domain-mappings describe --domain=your-domain.example.com \
  --region=us-central1 --format="value(status.resourceRecords)"
```

Add the returned records at your DNS provider; propagation and Google's
managed TLS certificate issuance can take up to ~24 hours.

## 10. Tear down a sandbox project when done

```bash
terraform destroy
gcloud projects delete my-gcp-project-id
```

`cloudsql_deletion_protection = true` (the default) blocks `terraform destroy`
from removing the Cloud SQL instance. Setting it to `false` is not enough on
its own: the provider reads that guard from **state**, not from the flags
passed to `destroy`, so it has to be applied first. For a genuinely disposable
sandbox:

```bash
terraform apply -var="cloudsql_deletion_protection=false"   # writes it to state
terraform destroy -var="cloudsql_deletion_protection=false"
```

Passing it only to `destroy` fails partway through — after the service,
secrets, and service account are already gone — with "failed to delete
instance because deletion_protection is set to true", leaving a half-torn-down
deployment. If you hit that, the targeted recovery is
`terraform apply -target=google_sql_database_instance.main -var="cloudsql_deletion_protection=false"`,
then destroy again.

## 11. Using your own identity provider (delegating mode)

By default the module deploys `auth_provider = "self-hosted"`: reevo acts as
its own OAuth authorization server, and you create accounts with
`reevo auth user create`, which hands back a login key. That needs no external
identity system, which makes it the fastest way to get a deployment running —
but most deployments will want to front an IdP they already run:

```hcl
auth_provider = "delegating"
auth_issuer   = "https://login.example.com/realms/prod"
auth_jwks_uri = "https://login.example.com/realms/prod/protocol/openid-connect/certs"
```

In this mode reevo only _verifies_ tokens — it never issues them — and there is
no local user administration at all: a `Principal` row is created from the
token's subject the first time each person authenticates. `reevo auth` and
login keys are self-hosted-mode concepts and play no part here. The module also
stops generating `AUTH_SIGNING_KEY`/`AUTH_CREDENTIAL_HASH_KEY`, since nothing
signs tokens or hashes login keys any more.

Four things must line up on the IdP side, and each fails in a way that does not
obviously point at its cause:

1. **Audience.** Tokens must carry an `aud` equal to this deployment's
   canonical URI (`domain_name`, or `mcp_canonical_uri_override`). Most IdPs
   call this an API identifier or resource, and it usually needs an explicit
   audience mapper — the default is often the client id. reevo accepts an
   origin with or without its trailing slash, so copying `resource` verbatim
   out of `https://<your-domain>/.well-known/oauth-protected-resource` is safe.
2. **Scopes.** reevo authorizes per-tool off the token's `scope` claim, and a
   spec-compliant client requests _every_ scope listed in that same metadata
   document. All of them must exist in the IdP or the authorization request
   fails wholesale with `invalid_scope` — at the IdP, before reevo is involved.
3. **Client registration.** MCP clients self-register via dynamic client
   registration, which most IdPs disable by default. If yours does, register
   one client yourself and have people connect with it explicitly:

   ```bash
   claude mcp add --transport http reevo https://<your-domain>/mcp \
     --client-id <your-client-id> --callback-port 8765
   ```

   `--callback-port` pins the redirect URI, for IdPs that will not accept a
   wildcard localhost port.

4. **Reachability.** Cloud Run must be able to reach `auth_jwks_uri` to fetch
   signing keys.

`deploy/keycloak-test/` brings up a throwaway Keycloak configured correctly for
all four, which is worth running locally before pointing this at a real IdP.
