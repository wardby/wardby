# deploy/

Deployment configuration for wardby, organized by target.

- **`local/`** — docker-compose for local development (Postgres, the coding
  proxy). `npm run db:up` / `npm run coding:local:up`.
- **`observability/`** — local Prometheus + Grafana stack (`npm run
observability:up`), dev/local only. See `docs/observability.md`.
- **`aws/`** — placeholder for an AWS target (Fargate `JobLauncher`, per the
  same isolation contract used by other coding-worker launchers). Not yet built.
- **`gke/`** — the supported Google Cloud path: GKE Autopilot, private-IP Cloud
  SQL, Artifact Registry, and the `gke-autopilot` Kubernetes overlay. Start with
  the [full GKE guide](../docs/getting-started-gke.md).
- **`gcp/`** — **deprecated** Cloud Run reference. It remains temporarily for
  existing operators but should not be used for a new installation.

  **Maintaining an existing Cloud Run deployment?** See `gcp/SETUP.md` — project
  creation, billing, required APIs, domain verification, a Terraform state
  bucket, and building/pushing the container image all have to happen
  before `terraform apply` will succeed; none of it is scriptable from
  inside the Terraform module itself.

  **Usage (once SETUP.md's prerequisites are done):**
  1. `cd deploy/gcp`
  2. Configure a Terraform state backend for your own deployment (not
     included in this module — e.g. add a `backend "gcs" { bucket = "..." }`
     block to a local override file, or pass `-backend-config` flags).
  3. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in your
     project id, region, and domain — or supply your own `.tfvars` file
     without copying this folder at all.
  4. `terraform init && terraform validate && terraform plan`

  **Scope:** this module provisions the always-on control plane (Cloud Run
  service + Cloud SQL) only. The coding-worker `JobLauncher` (Cloud Run
  Jobs), the coding-proxy's VPC/firewall egress lockdown, a CI/CD deploy
  pipeline, and Cloud-native observability are not part of this deprecated
  module.

`deploy/Dockerfile` (top level) is the production application image,
independent of target.
