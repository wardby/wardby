# GCP Control-Plane Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps between "the `deploy/gcp/` Terraform module applies and the app starts" (proven live against the `onit-dashboard` project on 2026-09-18) and "this is safe to run as a real production deployment."

**Architecture:** No new subsystems — this hardens the existing `deploy/gcp/` Cloud Run + Cloud SQL + Secret Manager module and fixes one real app-level bug (`SelfHostedAuthProvider`) that the live test surfaced. This is a **self-hosted** project — each operator builds and applies their own deployment by hand; there is deliberately no CI/CD pipeline in scope here, only the module and the manual runbook in `SETUP.md`. Work is organized in three phases: **Blockers** (must fix before calling any deployment "production"), **Important** (should fix before real user traffic), and **Hardening** (operational maturity). Each phase's tasks are independently shippable — later phases don't block on earlier ones being fully done, but should land in order since later tasks assume earlier infrastructure (e.g. the migration job) exists.

**Tech Stack:** TypeScript/Node 22, Prisma 6 + PostgreSQL, Terraform (`hashicorp/google ~> 8.3`), Cloud Run v2 (services + jobs), Cloud SQL, Secret Manager.

**Spec:** No separate spec document — this plan is synthesized directly from a live end-to-end deployment test of `deploy/gcp/` against the real `onit-dashboard` GCP project on 2026-09-18 (10 real deploy bugs found and fixed, then a full self-hosted OAuth flow — register/authorize/login/consent/token/mcp — verified working end to end). The original module design lives at `docs/superpowers/specs/2026-09-17-gcp-control-plane-hosting-design.md` and `docs/superpowers/plans/2026-09-17-gcp-control-plane-hosting.md`.

## Global Constraints

- **This is a self-hosted project — no CI/CD pipeline.** Every deployment step (build, push, `terraform apply`, migrations) is run by hand by whoever operates that deployment. Don't add GitHub Actions workflows or other automated-deploy tooling to this module; document manual steps in `SETUP.md` instead, matching how state-backend setup and domain verification are already handled there.
- **CLAUDE.md "Deployment (deploy/) — STRICT":** no target-specific identity (project/account id, domain, resource names, real credentials) hardcoded into any committed module file — every such value is a `variable`. Never commit a filled-in `*.tfvars`, real resource IDs, or `.terraform/` state.
- **CLAUDE.md "Database / Prisma — STRICT":** never `prisma db push`; migrations are hand-written and additive; every schema change ships with its migration in the same change; run the drift check (`prisma migrate diff` against an empty shadow DB, must print `-- This is an empty migration.`) after any schema/migration change — **not applicable to this plan**, which touches zero `schema.prisma`/migration files.
- **Never commit to `main`** — do this work on a branch (continue on `gcp-deploy-followups` or a new branch; do not commit directly to `main`).
- Terraform tasks are verified with `terraform fmt -check` and `terraform validate` (a real `terraform plan`/`apply` against a GCP project is a manual, human-triggered step, consistent with how `SETUP.md` already treats state-backend and domain-verification setup).
- App-code tasks are verified with the existing Vitest suite (`npm test`) and `npm run build`; the self-hosted-OAuth-specific tests are gated behind `describe.skipIf(!process.env.DATABASE_URL)` in `src/providers/auth/self-hosted.test.ts` — run with a local Postgres up (`npm run db:up`) and `DATABASE_URL` set to exercise them.

---

## Phase 1 — Blockers

These make the module usable at all for a from-scratch production deploy. Without them, every fresh deploy needs the exact manual workarounds this session used (hand-run migrations through a Cloud SQL proxy tunnel, a permanently exhaustible `/register` endpoint).

### Task 1: Fix the `/register` capacity-exhaustion gap and wire up periodic cleanup

**Context:** `SelfHostedAuthProvider.cleanup()` (`src/providers/auth/self-hosted.ts:339-347`) expires stale `OAuthFamily`/`OAuthAuthorizationCode`/`OAuthAuthorizationRequest`/`AuthFormChallenge`/`AuthSession`/`AuthRateLimit` rows — but **nothing in the codebase ever calls it** (confirmed via `grep -rn "\.cleanup(" src/` — zero callers outside the test file). Worse, it never touches `OAuthClient` rows at all. Self-hosted OAuth mode requires Cloud Run to allow unauthenticated invocation (`allUsers` as `run.invoker` — see `deploy/gcp/cloud-run.tf`'s auth env vars and the live test's finding that the app itself rejects any `Authorization` header on `/token`), which means `POST /register` (`src/mcp/auth/self-hosted/browser.ts:97-124`) is reachable by anyone on the internet, rate-limited only per-IP (`limiter.check("registration", ip, 10)`). `registerClient` (`self-hosted.ts:99-119`) enforces a **global** cap (`maxClients`, default 1000) with no expiry — so a distributed requester can permanently exhaust client-registration capacity for everyone, including real users, with no automatic recovery.

**Files:**

- Modify: `src/providers/auth/self-hosted.ts:339-347` (extend `cleanup()`)
- Modify: `src/mcp/index.ts` (start/stop a periodic call to `cleanup()`)
- Test: `src/providers/auth/self-hosted.test.ts` (extend the existing `describe.skipIf(!process.env.DATABASE_URL)` block)

**Interfaces:**

- Consumes: `SelfHostedAuthProvider.cleanup(): Promise<void>` (already exists, unchanged signature), `DAY` constant from `src/mcp/auth/self-hosted/credentials.ts` (already imported in `self-hosted.ts`).
- Produces: no new exports — `cleanup()`'s behavior changes (also GCs abandoned `OAuthClient` rows), and `startMcp()`'s returned `McpServerHandle.close()` now also clears the new interval.

- [ ] **Step 1: Write the failing test**

Add to `src/providers/auth/self-hosted.test.ts`, immediately before the file's final `});` (after the `"shares login throttles across limiter instances"` test, still inside the `describe.skipIf(!process.env.DATABASE_URL)` block):

```typescript
it("garbage-collects abandoned clients that never completed a token exchange, keeping used ones", async () => {
  const abandoned = await provider.registerClient({ redirectUris: ["https://abandoned.example/cb"] });
  clients.push(abandoned.clientId);
  await db.oAuthClient.update({
    where: { clientId: abandoned.clientId },
    data: { createdAt: new Date(Date.now() - 8 * DAY) },
  });
  const f = await setup();
  await provider.handleToken(await f.code());
  await db.oAuthClient.update({
    where: { clientId: f.client.clientId },
    data: { createdAt: new Date(Date.now() - 8 * DAY) },
  });
  await provider.cleanup();
  await expect(db.oAuthClient.findUnique({ where: { clientId: abandoned.clientId } })).resolves.toBeNull();
  await expect(db.oAuthClient.findUnique({ where: { clientId: f.client.clientId } })).resolves.not.toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run db:up && DATABASE_URL="postgresql://wardby:wardby@localhost:55432/wardby" npx vitest run src/providers/auth/self-hosted.test.ts -t "garbage-collects abandoned clients"`
Expected: FAIL — the abandoned client still exists after `cleanup()` (current `cleanup()` never deletes `OAuthClient` rows).

- [ ] **Step 3: Implement the minimal fix**

In `src/providers/auth/self-hosted.ts`, replace the `cleanup()` method body:

```typescript
  async cleanup() {
    const now = new Date();
    // Retain consumed grants until absolute family expiry for reuse detection.
    await this.db.oAuthFamily.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.oAuthAuthorizationCode.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.oAuthAuthorizationRequest.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.authFormChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.authSession.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.authRateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
    // /register has no auth in front of it once Cloud Run allows
    // unauthenticated invocation (required for self-hosted OAuth to serve
    // real clients at all), and maxClients is a hard global cap - so
    // unthrottled registrations could permanently exhaust it. A client
    // that never completes a single token exchange within a week is
    // abandoned or spam, never a real client still mid-flow (authorization
    // requests expire in 10 minutes, codes in 60 seconds).
    await this.db.oAuthClient.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - 7 * DAY) }, families: { none: {} } },
    });
  }
```

Then in `src/mcp/index.ts`, add a constant near the top of the file (after the existing top-level constants, e.g. right after `const mcpLog = logger.child({ module: "mcp-index" });` at line 50):

```typescript
const SELF_HOSTED_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
```

Then in `startMcp()`, right after the `const http = await startHttpServer({...});` call and before the final `return { close: ... }`:

```typescript
  const cleanupTimer = selfHosted
    ? setInterval(() => {
        selfHosted.cleanup().catch((err: unknown) => mcpLog.warn({ err }, "self-hosted auth cleanup failed"));
      }, SELF_HOSTED_CLEANUP_INTERVAL_MS)
    : undefined;
  return {
    close: async () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      await closeQuietly(http.close(), "HTTP transport close");
      await closeQuietly(providers.executor.close?.(), "executor close");
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `DATABASE_URL="postgresql://wardby:wardby@localhost:55432/wardby" npx vitest run src/providers/auth/self-hosted.test.ts -t "garbage-collects abandoned clients"`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/providers/auth/self-hosted.ts src/mcp/index.ts src/providers/auth/self-hosted.test.ts
git commit -m "$(cat <<'EOF'
fix(auth): garbage-collect abandoned OAuth clients, wire up periodic cleanup

SelfHostedAuthProvider.cleanup() was never called anywhere, and never
touched OAuthClient rows even when called manually - so /register (which
must be internet-reachable for self-hosted OAuth to serve real clients)
had no recovery from registration spam permanently exhausting the global
maxClients cap. Found during live end-to-end testing of deploy/gcp against
onit-dashboard, 2026-09-18.
EOF
)"
```

---

### Task 2: Add a migration step to `deploy/gcp` (Cloud Run Job)

**Context:** `deploy/Dockerfile` already has a dedicated `migration` build target (`FROM build AS migration` / `CMD ["npm", "run", "prisma:migrate"]`, lines 12-13) meant to be run once before/alongside a deploy — but `deploy/gcp/` never builds or runs it. The live test found this the hard way: a fresh `onit-dashboard` deploy left `public.Principal` (and every other Prisma table) missing, discovered only when `wardby auth user create` failed with `The table \`public.Principal\` does not exist`. Every future fresh deploy will hit the exact same wall until this is fixed.

**Files:**

- Create: `deploy/gcp/migration-job.tf`
- Modify: `deploy/gcp/variables.tf` (add `migration_image`)
- Modify: `deploy/gcp/versions.tf` (add the `null` provider, needed for the `local-exec` trigger)
- Modify: `deploy/gcp/cloud-run.tf` (add `null_resource.run_migration` to the service's `depends_on`)
- Modify: `deploy/gcp/SETUP.md` (step 7: build+push both targets, not just `runtime`)

**Interfaces:**

- Consumes: `google_service_account.cloud_run` (from `service-accounts.tf`), `google_sql_database_instance.main` (from `cloudsql.tf`), `google_secret_manager_secret.db_url` / `google_secret_manager_secret_version.db_url` / `google_secret_manager_secret_iam_member.db_url_access` (from `secrets.tf`) — all pre-existing.
- Produces: `google_cloud_run_v2_job.migrate` and `null_resource.run_migration`, consumed by `cloud-run.tf`'s `depends_on`.

- [ ] **Step 1: Add the `migration_image` variable**

In `deploy/gcp/variables.tf`, add after the existing `container_image` variable:

```hcl
variable "migration_image" {
  description = "Fully-qualified image reference for the one-off Prisma migration job, built from deploy/Dockerfile's `migration` target (not the `runtime` target used by container_image). No default: this module doesn't build or publish the image."
  type        = string
}
```

- [ ] **Step 2: Add the `null` provider**

In `deploy/gcp/versions.tf`, add to `required_providers`:

```hcl
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
```

- [ ] **Step 3: Write the migration job resource**

Create `deploy/gcp/migration-job.tf`:

```hcl
# One-time-per-image Prisma migration run against the live database, via
# the Dockerfile's `migration` build target (deploy/Dockerfile:12-13) -
# neither the runtime image nor anything else in this module ran
# migrations before this resource existed. Found the hard way: a fresh
# apply against onit-dashboard left every Prisma table missing
# (2026-09-18) until migrations were run by hand through a Cloud SQL
# proxy tunnel. See docs/superpowers/plans/2026-09-18-gcp-production-readiness.md.
resource "google_cloud_run_v2_job" "migrate" {
  name     = "${var.name_prefix}-migrate"
  project  = var.project_id
  location = var.region

  template {
    template {
      service_account = google_service_account.cloud_run.email
      max_retries     = 0
      timeout         = "300s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image = var.migration_image

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
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.db_url_access,
    google_secret_manager_secret_version.db_url,
  ]
}

# Runs the job automatically on every apply where the migration image
# changes - a plain `terraform apply` should never again leave the schema
# stale. Re-running against an unchanged image is a safe no-op: Prisma's
# `migrate deploy` skips already-applied migrations. Requires the
# identity running `terraform apply` to have `roles/run.developer` (or
# broader, e.g. `roles/run.admin` - see SETUP.md step 6) and the `gcloud`
# CLI available on PATH wherever `terraform apply` runs.
resource "null_resource" "run_migration" {
  triggers = {
    image = var.migration_image
  }

  provisioner "local-exec" {
    command = "gcloud run jobs execute ${google_cloud_run_v2_job.migrate.name} --project=${var.project_id} --region=${var.region} --wait"
  }

  depends_on = [google_cloud_run_v2_job.migrate]
}
```

- [ ] **Step 4: Make the Cloud Run service wait on migrations**

In `deploy/gcp/cloud-run.tf`, extend the existing `depends_on` block on `google_cloud_run_v2_service.main`:

```hcl
  depends_on = [
    google_secret_manager_secret_iam_member.db_url_access,
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_iam_member.app_key_access,
    google_secret_manager_secret_version.app_key,
    google_secret_manager_secret_iam_member.auth_signing_key_access,
    google_secret_manager_secret_version.auth_signing_key,
    google_secret_manager_secret_iam_member.auth_credential_hash_key_access,
    google_secret_manager_secret_version.auth_credential_hash_key,
    google_secret_manager_secret_iam_member.llm_api_key_access,
    google_secret_manager_secret_version.llm_api_key,
    null_resource.run_migration,
  ]
```

- [ ] **Step 5: Update `SETUP.md`'s build/push instructions**

In `deploy/gcp/SETUP.md` step 7, replace the single `docker build`/`push`/`inspect` sequence with both targets:

```bash
gcloud artifacts repositories create wardby \
  --repository-format=docker --location=us-central1

# from the repo root:
docker build -f deploy/Dockerfile --target runtime \
  -t us-central1-docker.pkg.dev/my-gcp-project-id/wardby/control-plane:latest .
docker push us-central1-docker.pkg.dev/my-gcp-project-id/wardby/control-plane:latest
docker inspect --format '{{index .RepoDigests 0}}' \
  us-central1-docker.pkg.dev/my-gcp-project-id/wardby/control-plane:latest

docker build -f deploy/Dockerfile --target migration \
  -t us-central1-docker.pkg.dev/my-gcp-project-id/wardby/control-plane-migrate:latest .
docker push us-central1-docker.pkg.dev/my-gcp-project-id/wardby/control-plane-migrate:latest
docker inspect --format '{{index .RepoDigests 0}}' \
  us-central1-docker.pkg.dev/my-gcp-project-id/wardby/control-plane-migrate:latest
```

Use the first digest as `container_image` and the second as `migration_image` in `terraform.tfvars`.

- [ ] **Step 6: Validate**

Run: `cd deploy/gcp && terraform fmt -check -diff . && terraform init -backend=false && terraform validate`
Expected: `fmt` prints no diff; `validate` succeeds (`Success! The configuration is valid.`).

- [ ] **Step 7: Commit**

```bash
git add deploy/gcp/migration-job.tf deploy/gcp/variables.tf deploy/gcp/versions.tf deploy/gcp/cloud-run.tf deploy/gcp/SETUP.md
git commit -m "$(cat <<'EOF'
feat(deploy): run Prisma migrations automatically as part of terraform apply

deploy/gcp never built or ran deploy/Dockerfile's dedicated `migration`
build target, so every fresh deploy left the schema empty until someone
ran `prisma migrate deploy` by hand through a Cloud SQL proxy tunnel
(found live against onit-dashboard, 2026-09-18). A Cloud Run Job wired to
that target, executed automatically via a null_resource trigger whenever
migration_image changes, closes the gap.
EOF
)"
```

---

## Phase 2 — Important

Should land before real (non-test) user traffic hits a deployment.

### Task 3: Enable point-in-time recovery on Cloud SQL

**Context:** `deploy/gcp/cloudsql.tf`'s `backup_configuration` block only sets `enabled = true` — daily backups, no point-in-time recovery. A single bad migration or accidental `DELETE` between daily backups is otherwise unrecoverable except back to the previous day.

**Files:**

- Modify: `deploy/gcp/cloudsql.tf`

**Interfaces:** none (leaf change to an existing resource's config block).

- [ ] **Step 1: Enable PITR**

In `deploy/gcp/cloudsql.tf`, change:

```hcl
    backup_configuration {
      enabled = true
    }
```

to:

```hcl
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
    }
```

- [ ] **Step 2: Validate**

Run: `cd deploy/gcp && terraform fmt -check -diff . && terraform init -backend=false && terraform validate`
Expected: clean fmt, `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add deploy/gcp/cloudsql.tf
git commit -m "$(cat <<'EOF'
feat(deploy): enable point-in-time recovery on the Cloud SQL instance

Daily backups alone mean up to 24 hours of unrecoverable data loss from a
bad migration or accidental delete. PITR with a 7-day log retention
window closes that gap at negligible additional cost for a db-f1-micro
instance.
EOF
)"
```

---

### Task 4: Admin bootstrap as a Cloud Run Job (retire the manual Cloud SQL proxy tunnel)

**Context:** The only way to provision a self-hosted-auth user today is `wardby auth user create --subject <x>`, which needs a Cloud SQL Auth Proxy tunnel plus manually fetching `DATABASE_URL`/`AUTH_CREDENTIAL_HASH_KEY` out of Secret Manager onto a local machine (exactly what this session had to do to complete the OAuth live test). A Cloud Run Job running inside the same VPC, using the existing Cloud SQL volume mount and Secret Manager env vars already wired for the main service, needs neither a local proxy nor local secret handling.

**Files:**

- Create: `deploy/gcp/admin-cli-job.tf`

**Interfaces:**

- Consumes: `google_service_account.cloud_run`, `google_sql_database_instance.main`, `google_secret_manager_secret.db_url`/`.app_key`/`.auth_signing_key`/`.auth_credential_hash_key` and their `_version`/`_iam_member` counterparts (all pre-existing), `var.container_image` (reuses the runtime image — it already contains `dist/cli.js`).
- Produces: `google_cloud_run_v2_job.admin_cli`, invoked ad hoc via `gcloud run jobs execute ... --args=...` — nothing else in this module depends on it.

- [ ] **Step 1: Write the admin CLI job**

Create `deploy/gcp/admin-cli-job.tf`:

```hcl
# Runs `wardby auth ...` (or any other `dist/cli.js` subcommand) inside the
# same network as the deployed service, reusing its Cloud SQL volume mount
# and Secret Manager wiring - no local Cloud SQL Auth Proxy tunnel or
# manual secret-fetching required (the workaround this session needed to
# provision its first test user, 2026-09-18). Default args are a no-op;
# override at execution time:
#
#   gcloud run jobs execute wardby-admin-cli --region=us-central1 \
#     --args="dist/cli.js,auth,user,create,--subject,someone@example.com" \
#     --wait
resource "google_cloud_run_v2_job" "admin_cli" {
  name     = "${var.name_prefix}-admin-cli"
  project  = var.project_id
  location = var.region

  template {
    template {
      service_account = google_service_account.cloud_run.email
      max_retries     = 0
      timeout         = "60s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image   = var.container_image
        command = ["node"]
        args    = ["dist/cli.js", "auth", "user", "list"]

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
          name = "AUTH_CREDENTIAL_HASH_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.auth_credential_hash_key.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.db_url_access,
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_iam_member.auth_credential_hash_key_access,
    google_secret_manager_secret_version.auth_credential_hash_key,
  ]
}
```

Default `args` list the existing users (`auth user list` — a safe, read-only default so an accidental un-overridden execution does nothing destructive).

- [ ] **Step 2: Validate**

Run: `cd deploy/gcp && terraform fmt -check -diff . && terraform init -backend=false && terraform validate`
Expected: clean fmt, `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add deploy/gcp/admin-cli-job.tf
git commit -m "$(cat <<'EOF'
feat(deploy): add a Cloud Run Job for admin CLI commands

Provisioning the first self-hosted-auth user required a local Cloud SQL
Auth Proxy tunnel and manually fetching DATABASE_URL/
AUTH_CREDENTIAL_HASH_KEY out of Secret Manager onto a laptop (this
session's live test against onit-dashboard, 2026-09-18). Running
`dist/cli.js` as a Cloud Run Job inside the same network, reusing the
service's existing Cloud SQL volume and Secret Manager wiring, needs
neither.
EOF
)"
```

---

### Task 5: Uptime check and alerting

**Context:** No monitoring exists today — the live test only found problems by manually running `gcloud run services describe` and `curl` by hand. A basic uptime check against a safe, unauthenticated, always-200 endpoint (the OAuth discovery document) with an email alert on failure catches the next `HealthCheckContainerError`-class regression automatically.

**Files:**

- Create: `deploy/gcp/monitoring.tf`
- Modify: `deploy/gcp/variables.tf` (add `alert_notification_email`)

**Interfaces:**

- Consumes: `google_cloud_run_v2_service.main.uri` (existing output-producing attribute).
- Produces: nothing consumed elsewhere — leaf task.

- [ ] **Step 1: Add the notification-email variable**

In `deploy/gcp/variables.tf`, add:

```hcl
variable "alert_notification_email" {
  description = "Email address to notify when the uptime check fails. No default: every deployment must set this explicitly."
  type        = string
}
```

- [ ] **Step 2: Write the uptime check and alert policy**

Create `deploy/gcp/monitoring.tf`:

```hcl
resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "${var.name_prefix} deploy alerts"
  type         = "email"
  labels = {
    email_address = var.alert_notification_email
  }
}

# Hits the OAuth discovery document - always 200, no auth required, so a
# failure here means the container itself is down or misrouted, not that
# a bearer token expired or a client made a bad request.
resource "google_monitoring_uptime_check_config" "control_plane" {
  project      = var.project_id
  display_name = "${var.name_prefix}-control-plane availability"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path         = "/.well-known/oauth-authorization-server"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = replace(replace(google_cloud_run_v2_service.main.uri, "https://", ""), "/", "")
    }
  }
}

resource "google_monitoring_alert_policy" "control_plane_down" {
  project      = var.project_id
  display_name = "${var.name_prefix}-control-plane is down"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failing"
    condition_threshold {
      filter          = "resource.type=\"uptime_url\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id=\"${google_monitoring_uptime_check_config.control_plane.uptime_check_id}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_FRACTION_TRUE"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}
```

- [ ] **Step 3: Validate**

Run: `cd deploy/gcp && terraform fmt -check -diff . && terraform init -backend=false && terraform validate`
Expected: clean fmt, `Success! The configuration is valid.`

- [ ] **Step 4: Commit**

```bash
git add deploy/gcp/monitoring.tf deploy/gcp/variables.tf
git commit -m "$(cat <<'EOF'
feat(deploy): add an uptime check and email alert for the control plane

Nothing detected the HealthCheckContainerError revisions this session hit
except manually running gcloud/curl by hand. A 60s uptime check against
the always-200 OAuth discovery endpoint, alerting by email after 5
minutes of failures, catches the next regression automatically.
EOF
)"
```

---

## Phase 3 — Hardening

Operational maturity — valuable, not blocking initial production traffic.

### Task 6: Document secret-rotation limitations and procedure

**Context:** `AppKeySecretCipher` (`src/providers/secrets/app-key.ts`) supports exactly one key at a time — no key ID/versioning, no dual-key decrypt-old-encrypt-new path. `SelfHostedAuthProvider.verifyBearer` similarly has no old-key fallback (confirmed by the existing test `"rejects legacy signed tokens even when the old signing key is retained"` in `self-hosted.test.ts`). Rotating any of `SECRET_APP_KEY`/`AUTH_SIGNING_KEY`/`AUTH_CREDENTIAL_HASH_KEY` today has real, different blast radii that aren't documented anywhere. This task documents the actual behavior rather than pretending safe rotation exists — building real key-rotation support (versioned keys, dual-read/single-write) is a separate, larger effort belonging in its own future plan.

**Files:**

- Modify: `deploy/gcp/SETUP.md` (new section)

- [ ] **Step 1: Write the runbook section**

Add to `deploy/gcp/SETUP.md`, as a new numbered section after "10. Tear down a sandbox project when done":

```markdown
## 11. Rotating secrets

None of `SECRET_APP_KEY`, `AUTH_SIGNING_KEY`, or `AUTH_CREDENTIAL_HASH_KEY`
support rotation without user-visible impact today — each is a single key
with no versioning or dual-key fallback in the application code
(`src/providers/secrets/app-key.ts`, `src/providers/auth/self-hosted.ts`).
Know the blast radius before rotating any of them:

- **`AUTH_SIGNING_KEY`** — signs/verifies OAuth access tokens (10-minute
  lifetime). Rotating it immediately invalidates every live access token;
  refresh tokens still work (they're opaque, hash-compared, not JWTs), so
  clients transparently get a new access token on their next refresh.
  **Low impact** — safe to rotate as needed.
- **`AUTH_CREDENTIAL_HASH_KEY`** — HMACs login keys, authorization codes,
  refresh tokens, and CSRF challenges. Rotating it invalidates every
  outstanding login key, in-flight authorization code, and refresh token
  at once — every user must be issued a new login key (`wardby auth key
create --subject <x>`) and re-authorize from scratch. **High impact** —
  plan a maintenance window.
- **`SECRET_APP_KEY`** — the sole key for `AppKeySecretCipher`
  (`src/providers/secrets/app-key.ts`), which encrypts agent tool secrets
  at rest. There is no re-encryption path: rotating it makes every
  already-stored encrypted secret permanently undecryptable. **Rotating
  this today means re-entering every stored secret from scratch** after
  rotation completes. Building safe rotation (key IDs + a migration pass
  that decrypts-under-old/re-encrypts-under-new) is real feature work, not
  a deploy-config change — tracked as a followup, not covered by this
  plan.

To rotate `AUTH_SIGNING_KEY` or `AUTH_CREDENTIAL_HASH_KEY` (accepting the
impact above): `terraform taint random_id.auth_signing_key` (or
`random_id.auth_credential_hash_key`), then `terraform apply` — this
generates a new value, writes a new Secret Manager version, and Cloud Run
picks it up on the next revision.
```

- [ ] **Step 2: Commit**

```bash
git add deploy/gcp/SETUP.md
git commit -m "$(cat <<'EOF'
docs(deploy): document secret rotation blast radius and procedure

None of the three app-generated keys support rotation without
user-visible impact - this was undocumented and untested. Writing down
the actual behavior (and explicitly not pretending safe SECRET_APP_KEY
rotation exists) so a future rotation isn't a surprise.
EOF
)"
```

---

### Task 7: Cloud Armor edge protection (optional, gated)

**Context:** Once `allUsers` has `run.invoker` (required for self-hosted OAuth — see Phase 1's live-test findings), Cloud Run's own platform has no rate limiting or WAF beyond Google's basic infrastructure-level DDoS mitigation; the app's own `PostgresRateLimiter` is the only defense, and it adds a Postgres round-trip per request. This task adds an **optional** external HTTPS Load Balancer + Cloud Armor policy in front of Cloud Run, gated behind a new variable so it doesn't force a migration off the existing `google_cloud_run_domain_mapping` (`domain.tf`) approach for deployments that don't need it — the two are mutually exclusive ways to front the same service with a custom domain, and switching requires a deliberate DNS change (an LB uses an `A` record to a static IP; domain mapping uses a `CNAME`).

**Files:**

- Create: `deploy/gcp/edge.tf`
- Modify: `deploy/gcp/variables.tf` (add `enable_cloud_armor`)

**Interfaces:**

- Consumes: `google_cloud_run_v2_service.main.name`, `var.region`, `var.name_prefix`, `var.project_id` (all pre-existing).
- Produces: nothing consumed elsewhere — leaf task, and only created at all when `var.enable_cloud_armor = true`.

- [ ] **Step 1: Add the toggle variable**

In `deploy/gcp/variables.tf`, add:

```hcl
variable "enable_cloud_armor" {
  description = "Front the Cloud Run service with an external HTTPS Load Balancer + Cloud Armor policy instead of relying on Cloud Run's own (rate-limiter-only) defenses. Mutually exclusive in practice with create_domain_mapping's CNAME-based custom domain - pick one DNS strategy. Requires a static IP (A record) at your DNS provider once enabled; the IP is in this module's outputs."
  type        = bool
  default     = false
}
```

- [ ] **Step 2: Write the load balancer and Cloud Armor policy**

Create `deploy/gcp/edge.tf`:

```hcl
resource "google_compute_security_policy" "control_plane" {
  count   = var.enable_cloud_armor ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-control-plane"

  # Default allow, with a per-client-IP rate limit as the primary defense
  # against the kind of registration-spam DoS Task 1 partially mitigates
  # at the app layer - this adds a layer in front of the app entirely.
  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 120
        interval_sec = 60
      }
    }
    description = "Rate limit: 120 requests/minute per client IP"
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }
}

resource "google_compute_region_network_endpoint_group" "control_plane" {
  count                 = var.enable_cloud_armor ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-control-plane-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.main.name
  }
}

resource "google_compute_backend_service" "control_plane" {
  count                 = var.enable_cloud_armor ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-control-plane-backend"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  security_policy       = google_compute_security_policy.control_plane[0].id

  backend {
    group = google_compute_region_network_endpoint_group.control_plane[0].id
  }
}

resource "google_compute_url_map" "control_plane" {
  count           = var.enable_cloud_armor ? 1 : 0
  project         = var.project_id
  name            = "${var.name_prefix}-control-plane-lb"
  default_service = google_compute_backend_service.control_plane[0].id
}

resource "google_compute_managed_ssl_certificate" "control_plane" {
  count   = var.enable_cloud_armor && var.domain_name != null ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-control-plane-cert"
  managed {
    domains = [var.domain_name]
  }
}

resource "google_compute_target_https_proxy" "control_plane" {
  count            = var.enable_cloud_armor ? 1 : 0
  project          = var.project_id
  name             = "${var.name_prefix}-control-plane-https-proxy"
  url_map          = google_compute_url_map.control_plane[0].id
  ssl_certificates = var.domain_name != null ? [google_compute_managed_ssl_certificate.control_plane[0].id] : []
}

resource "google_compute_global_address" "control_plane" {
  count   = var.enable_cloud_armor ? 1 : 0
  project = var.project_id
  name    = "${var.name_prefix}-control-plane-ip"
}

resource "google_compute_global_forwarding_rule" "control_plane" {
  count                 = var.enable_cloud_armor ? 1 : 0
  project               = var.project_id
  name                  = "${var.name_prefix}-control-plane-https"
  target                = google_compute_target_https_proxy.control_plane[0].id
  port_range            = "443"
  ip_address            = google_compute_global_address.control_plane[0].id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}
```

- [ ] **Step 3: Expose the static IP as an output**

In `deploy/gcp/outputs.tf`, add:

```hcl
output "cloud_armor_ip" {
  description = "Static IP to point an A record at when enable_cloud_armor is true (null otherwise)."
  value       = var.enable_cloud_armor ? google_compute_global_address.control_plane[0].address : null
}
```

- [ ] **Step 4: Validate**

Run: `cd deploy/gcp && terraform fmt -check -diff . && terraform init -backend=false && terraform validate`
Expected: clean fmt, `Success! The configuration is valid.` (validates with the default `enable_cloud_armor = false`, creating zero new resources — confirm with `terraform plan` showing no changes when re-run against existing state with the flag left at its default).

- [ ] **Step 5: Commit**

```bash
git add deploy/gcp/edge.tf deploy/gcp/variables.tf deploy/gcp/outputs.tf
git commit -m "$(cat <<'EOF'
feat(deploy): add optional Cloud Armor + load balancer edge protection

Cloud Run's own defenses are Google's basic infra-level DDoS mitigation
plus the app's own per-IP PostgresRateLimiter - no WAF, no edge rate
limiting. Gated behind enable_cloud_armor (default false, zero new
resources) since it's a genuine DNS-strategy fork against the existing
CNAME-based domain.tf mapping, not a pure addition.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** every gap from the production-readiness punch list this plan is based on has a task — migration step (Task 2), the `/register` DoS gap (Task 1), domain-mapping production runbook (already implemented and documented pre-existing; no new task needed), Cloud SQL HA/backup posture (Task 3 covers PITR; `cloudsql_availability_type=REGIONAL` is already an existing variable, not a code gap — left as a deployment-time choice, documented in Task 3's context rather than a forced default change), edge protection (Task 7), secret rotation (Task 6), admin bootstrap (Task 4), monitoring (Task 5). CI/CD is explicitly out of scope — this is a self-hosted project; deploys are run by hand per the Global Constraints.
- **Placeholder scan:** every task has concrete file paths, real code/HCL, and real verification commands — no "TBD"/"add error handling"/"similar to Task N" patterns.
- **Type/interface consistency:** Task 1's `cleanup()` signature is unchanged (`Promise<void>`); `SELF_HOSTED_CLEANUP_INTERVAL_MS` and `cleanupTimer` names are used consistently within Task 1's own steps. Later tasks (3-7) don't consume any interface Task 1-2 produce beyond pre-existing Terraform resources, so there's no cross-task signature drift to check.
