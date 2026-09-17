# deploy/

Deployment configuration for reevo-run, organized by target.

- **`local/`** — docker-compose for local development (Postgres, the coding
  proxy). `npm run db:up` / `npm run coding:local:up`.
- **`observability/`** — local Prometheus + Grafana stack (`npm run
  observability:up`), dev/local only. See `docs/phase-7-production-readiness.md`.
- **`aws/`** — placeholder for an AWS target (Fargate `JobLauncher`, per the
  roadmap's Phase 5 follow-ons). Not yet built.
- **`gcp/`** — GCP production hosting via Terraform (the baseline IaC tool
  for every reevo-run cloud deployment, GCP included — this module is the
  reference example future cloud targets, e.g. `aws/`, follow). Design:
  `docs/superpowers/specs/2026-09-17-gcp-control-plane-hosting-design.md`.

  **Usage:**
  1. `cd deploy/gcp`
  2. Configure a Terraform state backend for your own deployment (not
     included in this module — e.g. add a `backend "gcs" { bucket = "..." }`
     block to a local override file, or pass `-backend-config` flags).
  3. Copy `terraform.tfvars.example` to `terraform.tfvars` and fill in your
     project id, region, and domain — or supply your own `.tfvars` file
     without copying this folder at all.
  4. `terraform init && terraform validate && terraform plan`

  **Reusable two ways:** fork this whole folder into your own repo and edit
  in place, or keep it as-is and point your own `.tfvars` at it — no
  project-specific identity (project id, domain, resource names) is
  hardcoded anywhere in the module; every such value is a variable.

  **Scope:** this module provisions the always-on control plane (Cloud Run
  service + Cloud SQL) only. The coding-worker `JobLauncher` (Cloud Run
  Jobs), the coding-proxy's VPC/firewall egress lockdown, a CI/CD deploy
  pipeline, and Cloud-native observability are separate, not-yet-built
  follow-on modules.

`deploy/Dockerfile` (top level) is the production application image,
independent of target.
