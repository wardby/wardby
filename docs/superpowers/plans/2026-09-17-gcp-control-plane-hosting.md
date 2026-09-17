# GCP Control-Plane Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline execution). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project 1 of the GCP move — a per-process `DBOS_EXECUTOR_ID` fix, and a Terraform module (`deploy/gcp/`) that stands up the always-on control plane (Cloud Run service + Cloud SQL) as a reusable baseline others can copy or parameterize.

**Architecture:** One small application-code change (Task 1), then a Terraform module built file-by-file in dependency order — foundational config first (providers, variables), then the database, then identity/secrets, then the compute service that consumes both, then ingress, then the reusability/docs finishing touches.

**Tech Stack:** TypeScript/Vitest (Task 1 only). Terraform >= 1.10 (confirmed installed locally: 1.10.5), `hashicorp/google` provider `~> 8.3` (confirmed current stable: 8.3.0 via the Terraform Registry API on 2026-09-17), `hashicorp/random` provider for the generated DB password.

**Spec:** `docs/superpowers/specs/2026-09-17-gcp-control-plane-hosting-design.md`

## Global Constraints

- **No project-specific identity hardcoded anywhere in `deploy/gcp/`** — every resource name derives from a `name_prefix` variable; `project_id`, `region`, `domain_name` have no default (Terraform requires them explicitly). This module must work both copied-and-edited and reused-as-is with a different `terraform.tfvars`.
- **Terraform state backend is not configured in the module.** No `backend` block in `versions.tf` — documented in `deploy/README.md` as a per-deployment choice instead.
- **Postgres 16 + a shared-core/custom tier requires `edition = "ENTERPRISE"`** on `google_sql_database_instance` — confirmed via search on 2026-09-17; omitting it fails at `apply` time with an "Invalid Tier for ENTERPRISE_PLUS Edition" error. Every task touching `cloudsql.tf` must include this.
- **No `terraform apply`/`plan` against a real GCP project is automated by this plan.** Every Terraform task's verification step is `terraform validate` and `terraform fmt -check` only — those require no credentials and are safe to run in this environment.
- **DBOS_EXECUTOR_ID is a per-process `crypto.randomUUID()`, not fetched from anywhere GCP-specific** — Task 1 is the only application-code task in this plan.

---

## Task 1: Per-process `DBOS_EXECUTOR_ID` via `crypto.randomUUID()`

**Files:**

- Modify: `src/config/providers.ts` (`loadDbosConfig`, find via `export function loadDbosConfig`)
- Test: `src/config/providers.test.ts`

**Interfaces:**

- No signature change: `loadDbosConfig(env: NodeJS.ProcessEnv = process.env): DbosConfig` stays synchronous, same parameters, same return type. Only `executorId`'s value when `DBOS_EXECUTOR_ID` is unset changes (was `undefined`, now a generated UUID string).

- [ ] **Step 1: Write the failing test**

In `src/config/providers.test.ts`, find the `describe("loadDbosConfig", ...)` block and replace its first test (currently asserting `executorId: undefined`):

```typescript
it("generates a per-call UUID for the executor id when none is set, rather than leaving it undefined", () => {
  const config = loadDbosConfig({ DATABASE_URL: "postgresql://reevo:reevo@localhost:55432/reevo" });
  expect(config.systemDatabaseUrl).toBe("postgresql://reevo:reevo@localhost:55432/reevo");
  expect(config.schemaName).toBe("dbos");
  // v4 UUID shape: 8-4-4-4-12 hex, third group starts with "4".
  expect(config.executorId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it("generates a different id on each call, so two processes never collide by default", () => {
  const a = loadDbosConfig({ DATABASE_URL: "postgresql://x" });
  const b = loadDbosConfig({ DATABASE_URL: "postgresql://x" });
  expect(a.executorId).not.toBe(b.executorId);
});
```

Leave the other two existing tests in that `describe` block ("honours explicit
overrides" and "leaves systemDatabaseUrl undefined when neither variable is
set") exactly as they are — they don't touch `executorId`'s unset case.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/providers.test.ts -t "generates a per-call UUID"`
Expected: FAIL — `config.executorId` is `undefined`, doesn't match the UUID regex.

- [ ] **Step 3: Write minimal implementation**

In `src/config/providers.ts`, find:

```typescript
export function loadDbosConfig(env: NodeJS.ProcessEnv = process.env): DbosConfig {
  return {
    systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL ?? env.DATABASE_URL,
    schemaName: env.DBOS_SCHEMA ?? "dbos",
    executorId: env.DBOS_EXECUTOR_ID,
  };
}
```

Replace with:

```typescript
export function loadDbosConfig(env: NodeJS.ProcessEnv = process.env): DbosConfig {
  return {
    systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL ?? env.DATABASE_URL,
    schemaName: env.DBOS_SCHEMA ?? "dbos",
    executorId: env.DBOS_EXECUTOR_ID ?? crypto.randomUUID(),
  };
}
```

Also update this field's doc comment (find `executorId: string | undefined;`
a few lines above, with the comment starting `/**\n   * Stable per-*process* executor identity.`) — after the existing text, add:

```typescript
   *
   * Defaults to a freshly generated UUID per call (per process) when unset
   * — not left undefined — so two replicas of a horizontally-scaled
   * deployment (e.g. a Cloud Run service with min_instance_count > 1) never
   * silently share an identity just because no one set one explicitly. An
   * explicit DBOS_EXECUTOR_ID still always wins, for local dev or a small
   * deployment wanting a stable, human-readable id across restarts.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/providers.test.ts -t "generates a per-call UUID"`
Expected: PASS

- [ ] **Step 5: Run the full file and adjacent executor tests to check for regressions**

Run: `npx vitest run src/config/providers.test.ts src/providers/executor/build.test.ts`
Expected: All PASS. (`build.test.ts`'s "fails fast for EXECUTOR=dbos without DBOS_EXECUTOR_ID" test passes a `DATABASE_URL` but no `DBOS_EXECUTOR_ID` and expects a throw — verify this doesn't break: it does not, because that test calls `buildExecutor` directly with a raw env object that also omits `DATABASE_URL`'s... no — re-check: that specific test _does_ set `DATABASE_URL` and omits `DBOS_EXECUTOR_ID`, expecting `DbosExecutor`'s constructor to throw "DBOS_EXECUTOR_ID, unique per running process". After this change, `loadDbosConfig` now generates a UUID instead of leaving it undefined, so `DbosExecutor` **will no longer throw** for that case — this test's expectation is now wrong and must be updated in this same step.)

- [ ] **Step 6: Fix the now-invalid `build.test.ts` expectation**

In `src/providers/executor/build.test.ts`, find the test
`"fails fast for EXECUTOR=dbos without DBOS_EXECUTOR_ID rather than defaulting to a shared id"` and delete it — the behavior it asserted (throwing when `DBOS_EXECUTOR_ID` is unset) is exactly what Task 1 intentionally changes. Replace it with:

```typescript
it("generates its own executor id for EXECUTOR=dbos when DBOS_EXECUTOR_ID is not set", () => {
  const executor = buildExecutor({ executor: "dbos" }, providers, undefined, {
    DATABASE_URL: "postgresql://reevo:reevo@localhost:55432/reevo",
  });
  expect(executor).toBeInstanceOf(DbosExecutor);
});
```

- [ ] **Step 7: Run the full test suite to check for regressions**

Run: `npx vitest run src/config/providers.test.ts src/providers/executor/build.test.ts`
Expected: All PASS.

- [ ] **Step 8: Typecheck, lint, build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: No errors.

- [ ] **Step 9: Commit**

```bash
git add src/config/providers.ts src/config/providers.test.ts src/providers/executor/build.test.ts
git commit -m "$(cat <<'EOF'
feat(config): generate a per-process DBOS_EXECUTOR_ID instead of leaving it unset

DbosExecutor's constructor previously required DBOS_EXECUTOR_ID be set
explicitly, refusing to construct otherwise (to avoid two processes
silently sharing an identity). A horizontally-scaled deployment (Cloud Run
service, min_instance_count > 1) needs every replica to get a distinct id
automatically without hand-assigning one per replica. loadDbosConfig now
generates a fresh UUID per call when the env var is unset; an explicit
DBOS_EXECUTOR_ID still always wins.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 2: Terraform scaffold — `versions.tf` + `variables.tf`

**Files:**

- Create: `deploy/gcp/versions.tf`
- Create: `deploy/gcp/variables.tf`

- [ ] **Step 1: Run terraform to confirm there's nothing to validate yet**

Run: `cd deploy/gcp && terraform validate`
Expected: FAIL — `Error: Could not load plugin` or similar, since no provider requirements exist yet in an empty directory (only `.gitkeep`).

- [ ] **Step 2: Write `versions.tf`**

```hcl
terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.3"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # No backend block: state storage is a per-deployment choice, documented
  # in ../README.md rather than hardcoded here. Configure one (e.g. `backend
  # "gcs" { bucket = "..." }`) before running `terraform init` for real.
}

provider "google" {
  project = var.project_id
  region  = var.region
}
```

- [ ] **Step 3: Write `variables.tf`**

```hcl
variable "project_id" {
  description = "GCP project id to deploy into. No default: every deployment must set this explicitly."
  type        = string
}

variable "region" {
  description = "GCP region for all resources (e.g. \"us-central1\")."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to every resource name, so multiple copies of this module can coexist in one project or across projects without colliding."
  type        = string
  default     = "reevo-run"
}

variable "domain_name" {
  description = "Custom domain to map to the Cloud Run service (e.g. \"reevo.example.com\"). No default: DNS ownership is deployment-specific."
  type        = string
}

variable "min_instance_count" {
  description = "Minimum Cloud Run replicas. 2+ avoids a scale-to-zero gap in scheduler availability and a single point of failure across restarts/deploys."
  type        = number
  default     = 2
}

variable "max_instance_count" {
  description = "Maximum Cloud Run replicas."
  type        = number
  default     = 10
}

variable "cloudsql_tier" {
  description = "Cloud SQL machine tier (e.g. \"db-f1-micro\" for a cheap baseline, \"db-custom-2-8192\" for production)."
  type        = string
  default     = "db-f1-micro"
}

variable "cloudsql_availability_type" {
  description = "Cloud SQL availability: \"ZONAL\" (single zone, cheaper) or \"REGIONAL\" (synchronous standby + automatic failover, ~2x cost)."
  type        = string
  default     = "ZONAL"
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.cloudsql_availability_type)
    error_message = "cloudsql_availability_type must be \"ZONAL\" or \"REGIONAL\"."
  }
}

variable "cloudsql_deletion_protection" {
  description = "Prevent accidental destroy of the Cloud SQL instance. Defaults on; a copy of this module used for disposable dev/test environments should set this false explicitly."
  type        = bool
  default     = true
}

variable "container_image" {
  description = "Fully-qualified image reference for the Cloud Run service (e.g. a digest-pinned image built from ../Dockerfile). No default: this module doesn't build or publish the image."
  type        = string
}
```

- [ ] **Step 4: Run terraform to verify it now validates**

Run: `cd deploy/gcp && terraform init -backend=false && terraform validate`
Expected: PASS — `Success! The configuration is valid.`

- [ ] **Step 5: Format check**

Run: `cd deploy/gcp && terraform fmt -check`
Expected: No output (already correctly formatted). If it lists this file, run `terraform fmt` and re-check.

- [ ] **Step 6: Commit**

```bash
git add deploy/gcp/versions.tf deploy/gcp/variables.tf
git commit -m "$(cat <<'EOF'
feat(deploy): scaffold the GCP Terraform module - providers and variables

No project-specific identity hardcoded: project_id, region, and
domain_name have no default and must be supplied per-deployment;
name_prefix defaults to "reevo-run" but is override-able so multiple
copies of this module can coexist. No backend block - state storage is
documented as a per-deployment choice in deploy/README.md, not baked in.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 3: `cloudsql.tf` — one instance, one database, a generated app-user password

**Files:**

- Create: `deploy/gcp/cloudsql.tf`

**Interfaces:**

- Produces: `google_sql_database_instance.main`, `google_sql_database.app`,
  `google_sql_user.app`, `random_password.db_password` — referenced by
  Task 5's `cloud-run.tf` (connection name, database name, user, password)
  and Task 4's `secrets.tf` (the password value, to store in Secret Manager).

- [ ] **Step 1: Run terraform to confirm the plan currently has no database resources**

Run: `cd deploy/gcp && terraform validate`
Expected: PASS (Task 2 alone is already valid) — this step is here to give a clean baseline to diff against once `cloudsql.tf` exists, not to prove failure.

- [ ] **Step 2: Write `cloudsql.tf`**

```hcl
resource "random_password" "db_password" {
  length  = 32
  special = false # avoid characters that need extra escaping in a connection string
}

resource "google_sql_database_instance" "main" {
  name             = "${var.name_prefix}-postgres"
  project          = var.project_id
  region           = var.region
  database_version = "POSTGRES_16"

  # POSTGRES_16 requires edition = "ENTERPRISE" whenever a shared-core or
  # db-custom-* tier is used; omitting it fails at apply time (confirmed
  # 2026-09-17, not assumed).
  settings {
    tier              = var.cloudsql_tier
    edition           = "ENTERPRISE"
    availability_type = var.cloudsql_availability_type

    ip_configuration {
      ipv4_enabled = true
    }

    backup_configuration {
      enabled = true
    }
  }

  deletion_protection = var.cloudsql_deletion_protection
}

# One logical database. The app/public schema (Prisma migrations) and the
# dbos schema (DBOS's own bootstrap at DBOS.launch()) both live inside it -
# schemas, not separate databases, mirroring local dev's DBOS_SCHEMA
# convention. Nothing else for Terraform to provision here: both schemas
# are created by the application at runtime, not by this module.
resource "google_sql_database" "app" {
  name     = var.name_prefix
  project  = var.project_id
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = var.name_prefix
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  password = random_password.db_password.result
}
```

- [ ] **Step 3: Run terraform to verify it validates**

Run: `cd deploy/gcp && terraform validate`
Expected: PASS

- [ ] **Step 4: Format check**

Run: `cd deploy/gcp && terraform fmt -check`
Expected: No output; run `terraform fmt` if it lists this file.

- [ ] **Step 5: Commit**

```bash
git add deploy/gcp/cloudsql.tf
git commit -m "$(cat <<'EOF'
feat(deploy): add Cloud SQL instance, database, and app user

One Postgres 16 instance and one logical database - the app's Prisma
schema and DBOS's own schema both live inside it (DBOS_SCHEMA), matching
local dev's convention; nothing for Terraform to provision at the schema
level since both are created by the application at runtime. edition =
"ENTERPRISE" is required alongside a shared-core/custom tier on Postgres
16+ or apply fails - confirmed via the provider docs, not assumed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 4: `service-accounts.tf` + `secrets.tf`

**Files:**

- Create: `deploy/gcp/service-accounts.tf`
- Create: `deploy/gcp/secrets.tf`

**Interfaces:**

- Consumes: `random_password.db_password`, `google_sql_database_instance.main`, `google_sql_database.app`, `google_sql_user.app` (Task 3).
- Produces: `google_service_account.cloud_run` (referenced by Task 5's `cloud-run.tf` as the service's identity), `google_secret_manager_secret.db_url` (referenced by Task 5 as an env var source).

- [ ] **Step 1: Write `service-accounts.tf`**

```hcl
# Custom, least-privilege identity for the Cloud Run service - deliberately
# not the broad-scope default compute service account, to bound the blast
# radius of any future SSRF-class bug to exactly what reevo needs.
resource "google_service_account" "cloud_run" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-run"
  display_name = "${var.name_prefix} Cloud Run service"
}

resource "google_project_iam_member" "cloud_run_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}
```

- [ ] **Step 2: Write `secrets.tf`**

```hcl
resource "google_secret_manager_secret" "db_url" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-database-url"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_url" {
  secret = google_secret_manager_secret.db_url.id
  # Unix-socket form: matches how Cloud Run's built-in Cloud SQL volume
  # mount exposes the instance, at /cloudsql/<connection_name> (Task 5).
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db_password.result}@localhost/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

resource "google_secret_manager_secret_iam_member" "db_url_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}
```

- [ ] **Step 3: Run terraform to verify it validates**

Run: `cd deploy/gcp && terraform validate`
Expected: PASS

- [ ] **Step 4: Format check**

Run: `cd deploy/gcp && terraform fmt -check`
Expected: No output; run `terraform fmt` if it lists these files.

- [ ] **Step 5: Commit**

```bash
git add deploy/gcp/service-accounts.tf deploy/gcp/secrets.tf
git commit -m "$(cat <<'EOF'
feat(deploy): add a least-privilege service account and Secret Manager entry

Custom service account (not the broad-scope default compute SA) for the
Cloud Run service, granted only cloudsql.client. The generated DB
connection string lives in Secret Manager, granted to that service account
via IAM - never written into Terraform state as a bare env var value in
cloud-run.tf, and never baked into the container image.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 5: `cloud-run.tf`

**Files:**

- Create: `deploy/gcp/cloud-run.tf`

**Interfaces:**

- Consumes: `google_service_account.cloud_run` (Task 4), `google_secret_manager_secret.db_url` (Task 4), `google_sql_database_instance.main.connection_name` (Task 3), `var.min_instance_count`/`var.max_instance_count`/`var.container_image` (Task 2).
- Produces: `google_cloud_run_v2_service.main` (referenced by Task 6's `domain.tf` and `outputs.tf`).

- [ ] **Step 1: Write `cloud-run.tf`**

```hcl
resource "google_cloud_run_v2_service" "main" {
  name     = "${var.name_prefix}-control-plane"
  project  = var.project_id
  location = var.region

  template {
    service_account = google_service_account.cloud_run.email

    scaling {
      min_instance_count = var.min_instance_count
      max_instance_count = var.max_instance_count
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image = var.container_image

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "EXECUTOR"
        value = "dbos"
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.db_url_access]
}
```

- [ ] **Step 2: Run terraform to verify it validates**

Run: `cd deploy/gcp && terraform validate`
Expected: PASS. If it fails on the `volumes`/`volume_mounts`/`env.value_source` block shapes (these were confirmed via web search, not the provider schema directly — verify against the installed provider's actual schema if this fails): run `terraform providers schema -json | jq '.provider_schemas["registry.terraform.io/hashicorp/google"].resource_schemas["google_cloud_run_v2_service"]'` (after `terraform init`) to see the exact expected block structure and correct the file to match.

- [ ] **Step 3: Format check**

Run: `cd deploy/gcp && terraform fmt -check`
Expected: No output; run `terraform fmt` if it lists this file.

- [ ] **Step 4: Commit**

```bash
git add deploy/gcp/cloud-run.tf
git commit -m "$(cat <<'EOF'
feat(deploy): add the Cloud Run service for the always-on control plane

google_cloud_run_v2_service with min/max instance count from variables
(default min=2 for HA), the custom service account from service-accounts.tf,
a Cloud SQL volume mount (Unix socket, no VPC connector needed for this),
and DATABASE_URL sourced from Secret Manager rather than a plain env value.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 6: `domain.tf` + `outputs.tf`

**Files:**

- Create: `deploy/gcp/domain.tf`
- Create: `deploy/gcp/outputs.tf`

**Interfaces:**

- Consumes: `google_cloud_run_v2_service.main` (Task 5).

- [ ] **Step 1: Write `domain.tf`**

```hcl
resource "google_cloud_run_domain_mapping" "main" {
  name     = var.domain_name
  project  = var.project_id
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.main.name
  }
}
```

- [ ] **Step 2: Write `outputs.tf`**

```hcl
output "cloud_run_service_url" {
  description = "The Cloud Run service's default *.run.app URL."
  value       = google_cloud_run_v2_service.main.uri
}

output "custom_domain" {
  description = "The custom domain mapped to the service - this is the stable MCP canonicalUri/AUTH_AUDIENCE."
  value       = var.domain_name
}

output "cloudsql_connection_name" {
  description = "Cloud SQL instance connection name, for gcloud/psql access outside the app."
  value       = google_sql_database_instance.main.connection_name
}
```

- [ ] **Step 3: Run terraform to verify it validates**

Run: `cd deploy/gcp && terraform validate`
Expected: PASS

- [ ] **Step 4: Format check**

Run: `cd deploy/gcp && terraform fmt -check`
Expected: No output; run `terraform fmt` if it lists these files.

- [ ] **Step 5: Commit**

```bash
git add deploy/gcp/domain.tf deploy/gcp/outputs.tf
git commit -m "$(cat <<'EOF'
feat(deploy): add custom domain mapping and module outputs

google_cloud_run_domain_mapping gives the MCP server a stable custom-domain
identity for canonicalUri/AUTH_AUDIENCE, fully replacing the separate
ngrok plan's motivation (docs/private/2026-09-13-http-reachable-service-plan.md).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 7: `terraform.tfvars.example` + `deploy/README.md` finalization

**Files:**

- Create: `deploy/gcp/terraform.tfvars.example`
- Modify: `deploy/README.md`

- [ ] **Step 1: Write `terraform.tfvars.example`**

```hcl
# Copy this file to terraform.tfvars and fill in your own values, OR pass
# these as -var flags / a different .tfvars file - this module reads
# variables, it doesn't assume this exact file exists.
#
# Usage pattern A: fork this whole deploy/gcp/ folder into your own repo
# and edit in place.
# Usage pattern B: keep this folder as-is (e.g. as a git submodule or a
# vendored copy) and supply only your own terraform.tfvars alongside it.

project_id  = "my-gcp-project-id"
region      = "us-central1"
domain_name = "reevo.example.com"

# Optional overrides (defaults shown):
# name_prefix                 = "reevo-run"
# min_instance_count          = 2
# max_instance_count          = 10
# cloudsql_tier                = "db-f1-micro"
# cloudsql_availability_type   = "ZONAL"
# cloudsql_deletion_protection = true

container_image = "us-docker.pkg.dev/my-gcp-project-id/reevo-run/control-plane@sha256:REPLACE_ME"
```

- [ ] **Step 2: Update `deploy/README.md`'s `gcp/` section**

Find the bullet starting `- **\`gcp/\`** — GCP production hosting.` and
replace its whole contents with:

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add deploy/gcp/terraform.tfvars.example deploy/README.md
git commit -m "$(cat <<'EOF'
docs(deploy): document GCP module usage, add an example tfvars file

Covers both reuse patterns this module is designed for - fork the folder,
or keep it as-is and supply a different terraform.tfvars - and the
explicit scope boundary (control plane only; JobLauncher/egress/CI-CD/
observability are separate follow-on modules).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0121bZNoqyDGneNVmc2fCds4
EOF
)"
```

---

## Task 8: Mark the ngrok plan superseded

**Files:**

- Modify: `docs/private/2026-09-13-http-reachable-service-plan.md` (git-ignored — no commit for this file)
- Modify: `docs/private/2026-09-05-roadmap-mcp-native.md` (git-ignored — no commit)
- Modify: `docs/private/2026-09-14-roadmap-status-table.md` (git-ignored — no commit)

- [ ] **Step 1: Mark the ngrok plan's own header superseded**

At the top of `docs/private/2026-09-13-http-reachable-service-plan.md`,
right after its `**Status:** planned, not started (2026-09-13)` line, add:

```markdown
**Superseded 2026-09-17:** the GCP control-plane hosting design
([[2026-09-17-gcp-control-plane-hosting-design]]) gives the MCP server a
stable public HTTPS endpoint via a Cloud Run domain mapping, fully
satisfying this plan's original motivation without a separate tunnel.
Kept here for the record; do not build this ngrok plan.
```

- [ ] **Step 2: Update the roadmap's "HTTPS-reachable reevo service (ngrok)" bullet**

In `docs/private/2026-09-05-roadmap-mcp-native.md`, find the bullet starting
`- **HTTPS-reachable reevo service (ngrok)**` and replace it with:

```markdown
- **HTTPS-reachable reevo service** — ✅ superseded 2026-09-17 by the GCP
  control-plane hosting design's Cloud Run domain mapping
  ([[2026-09-17-gcp-control-plane-hosting-design]]), not the originally
  planned ngrok tunnel ([[2026-09-13-http-reachable-service-plan]], now
  marked superseded). Real usage lands once
  [[2026-09-17-gcp-control-plane-hosting]] (the implementation plan) ships.
```

- [ ] **Step 3: Update the status table's row for this item, if one exists**

In `docs/private/2026-09-14-roadmap-status-table.md`, find the row for
"HTTPS-reachable service (ngrok)" and update its Status/Notes to match the
roadmap wording above (superseded, not simply "not started" anymore).

- [ ] **Step 4: No commit** — all three files are git-ignored (`docs/private/`); saving them is the whole step.
