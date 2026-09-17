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
```

Use the resulting `@sha256:...` digest (not a mutable tag) as
`container_image` in your `terraform.tfvars` — consistent with how every
other image in this repo is pinned.

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

`deletion_protection = true` (the default) blocks `terraform destroy` from
removing the Cloud SQL instance — set `cloudsql_deletion_protection = false`
in `terraform.tfvars` first if this is genuinely a disposable sandbox.
