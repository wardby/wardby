# deploy/

Deployment configuration for reevo-run, organized by target.

- **`local/`** — docker-compose for local development (Postgres, the coding
  proxy). `npm run db:up` / `npm run coding:local:up`.
- **`observability/`** — local Prometheus + Grafana stack (`npm run
  observability:up`), dev/local only. See `docs/phase-7-production-readiness.md`.
- **`aws/`** — placeholder for an AWS target (Fargate `JobLauncher`, per the
  roadmap's Phase 5 follow-ons). Not yet built.
- **`gcp/`** — GCP production hosting. **Terraform** is the baseline IaC
  tool for every reevo-run cloud deployment, GCP included — modules here
  are the reference example future cloud targets (e.g. `aws/`) follow. Not
  yet built; design: `docs/superpowers/specs/2026-09-17-gcp-control-plane-hosting-design.md`.
  Meant to be reusable two ways: fork the whole folder and edit in place,
  or keep it as-is and supply your own `terraform.tfvars` (see
  `terraform.tfvars.example` once the module exists) — no project-specific
  identity (project id, domain, resource names) is hardcoded.

`deploy/Dockerfile` (top level) is the production application image,
independent of target.
